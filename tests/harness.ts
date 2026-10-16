import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inject } from 'vitest'
import WebSocket from 'ws'

/**
 * Shared rig for the integration tests: a REAL server, spawned as a child
 * process on a fresh PGlite database in a temp directory, exercised over HTTP
 * and WebSocket exactly like the browser and MCP clients. No mocks — this is
 * the same surface a self-hoster exposes to the internet.
 */

const ROOT = process.cwd() // vitest runs from the repo root

/** the last process started on each data directory, so a reboot can wait for it */
const exits = new Map<string, Promise<void>>()

declare module 'vitest' {
  interface ProvidedContext {
    /** a data directory with every migration applied, built once per run by
     *  tests/globalSetup.ts; fresh servers copy it instead of replaying the
     *  journal on an empty PGlite (~1s per boot) */
    templateDir: string
  }
}

export interface Server {
  base: string
  port: number
  /** PGlite lives here; pass it back to startServer to reboot the same database */
  dataDir: string
  /** Resolves after the child process exits; useful before reopening its data directory. */
  stopped: Promise<void>
  stop(opts?: { keepData?: boolean }): void
}

/** An OS-assigned port, released again so a child can bind it. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Boot a server on an OS-assigned port (or `env.PORT`, for a caller that had
 * to know it first). `env` overrides the process environment; BETTER_AUTH_URL
 * defaults to the server's own origin. Pass `reuseDir` (a previous server's
 * dataDir) to reboot the same database on the same port.
 */
export function startServer(env: Record<string, string> = {}, reuseDir?: string): Promise<Server> {
  return boot(env, reuseDir, inject('templateDir'))
}

async function boot(env: Record<string, string>, reuseDir: string | undefined, templateDir?: string): Promise<Server> {
  const dataDir = reuseDir ?? mkdtempSync(path.join(tmpdir(), 'doop-test-'))
  /* a reboot on the same port: the previous process must be gone first, or
     /healthz answers from a server that is still flushing on its way out */
  if (reuseDir) await exits.get(reuseDir)
  if (!reuseDir && templateDir) cpSync(templateDir, dataDir, { recursive: true })
  /* a reboot keeps its port: clients created against the first server (and
     the BETTER_AUTH_URL baked into its sessions) stay valid across it */
  const portFile = path.join(dataDir, 'port')
  const fixed = env.PORT ?? (reuseDir ? readFileSync(portFile, 'utf8') : undefined)
  /* The server must know its origin before it binds (BETTER_AUTH_URL is baked
     into responses), so the port is picked up front. Between that pick and
     the bind a parallel worker can be handed the same number; the child's own
     "bound" log line is the proof it won, and a child that died first (EADDRINUSE)
     is simply started again on another port. */
  for (let attempt = 1; ; attempt++) {
    const port = fixed ? Number(fixed) : await freePort()
    const base = `http://localhost:${port}`
    const proc: ChildProcess = spawn(
      path.join(ROOT, 'node_modules', '.bin', 'tsx'),
      [path.join(ROOT, 'server', 'index.ts')],
      {
        cwd: dataDir, // PGlite persists to <cwd>/data — isolated per run
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: undefined as unknown as string,
          BETTER_AUTH_URL: base,
          /* always the embedded PGlite in dataDir, never a DATABASE_URL
             exported in the developer's shell */
          DATABASE_URL: '',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    const stopped = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    exits.set(dataDir, stopped)
    const bound = await waitForBind(proc, port)
    if (!bound) {
      if (fixed || attempt >= 5) throw new Error(`server did not bind port ${port}`)
      continue
    }
    writeFileSync(portFile, String(port))
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        const res = await fetch(`${base}/healthz`)
        if (res.ok) break
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('server did not boot within 60s')
      await new Promise((r) => setTimeout(r, 50))
    }
    return {
      base,
      port,
      dataDir,
      stopped,
      stop({ keepData }: { keepData?: boolean } = {}) {
        proc.kill()
        if (!keepData) rmSync(dataDir, { recursive: true, force: true })
      },
    }
  }
}

/** Resolves true once the child logs that it is listening on `port`, false if
 *  it exits first. The log keeps draining afterwards so a full pipe can
 *  never stall the server. */
function waitForBind(proc: ChildProcess, port: number): Promise<boolean> {
  const out = proc.stdout
  if (!out) throw new Error('server stdout is not piped')
  return new Promise((resolve) => {
    let log = ''
    const onData = (chunk: Buffer) => {
      log += chunk.toString()
      if (!log.includes(`doop server     http://localhost:${port}`)) return
      out.off('data', onData)
      out.resume()
      resolve(true)
    }
    out.on('data', onData)
    proc.once('exit', () => resolve(false))
  })
}

/** Build the per-run template: boot once on an empty directory so the server
 *  applies the migration journal, and keep the resulting data directory. */
export async function buildTemplate(dir: string): Promise<void> {
  const server = await boot({}, undefined)
  server.stop({ keepData: true })
  await server.stopped
  cpSync(server.dataDir, dir, { recursive: true })
  rmSync(server.dataDir, { recursive: true, force: true })
}

/** Minimal cookie-jar client: better-auth drives everything through cookies. */
export class Client {
  cookies = new Map<string, string>()

  constructor(private server: Server) {}

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async req(pathname: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.server.base + pathname, {
      ...init,
      headers: { 'Content-Type': 'application/json', Cookie: this.header(), ...init.headers },
      redirect: 'manual',
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';')
      const idx = pair.indexOf('=')
      this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
    }
    return res
  }

  get(p: string) {
    return this.req(p)
  }

  post(p: string, body?: unknown) {
    return this.req(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  }

  patch(p: string, body: unknown) {
    return this.req(p, { method: 'PATCH', body: JSON.stringify(body) })
  }

  delete(p: string) {
    return this.req(p, { method: 'DELETE' })
  }

  async signUp(email: string, name: string) {
    const res = await this.post('/api/auth/sign-up/email', { email, password: 'password12345', name })
    if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`)
    return this
  }

  /** join a canvas room over WS; resolves with how the server answered */
  joinWs(canvasId: string): Promise<{ kind: 'init' } | { kind: 'closed'; code: number }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${this.server.port}/ws`, { headers: { Cookie: this.header() } })
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('ws join timed out'))
      }, 8000)
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 't', kind: 'user' })),
      )
      ws.on('message', (d) => {
        if (JSON.parse(String(d)).type === 'init') {
          clearTimeout(timer)
          ws.close()
          resolve({ kind: 'init' })
        }
      })
      ws.on('close', (code) => {
        clearTimeout(timer)
        resolve({ kind: 'closed', code })
      })
      ws.on('error', () => {}) // close event carries the verdict
    })
  }
}
