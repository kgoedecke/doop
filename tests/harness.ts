import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

/**
 * Shared rig for the integration tests: a REAL server, spawned as a child
 * process on a fresh PGlite database in a temp directory, exercised over HTTP
 * and WebSocket exactly like the browser and MCP clients. No mocks — this is
 * the same surface a self-hoster exposes to the internet.
 */

const ROOT = process.cwd() // vitest runs from the repo root

export interface Server {
  base: string
  port: number
  /** PGlite lives here; pass it back to startServer to reboot the same database */
  dataDir: string
  /** Resolves after the child process exits; useful before reopening its data directory. */
  stopped: Promise<void>
  stop(opts?: { keepData?: boolean }): void
}

export async function startServer(port: number, env: Record<string, string> = {}, reuseDir?: string): Promise<Server> {
  const dataDir = reuseDir ?? mkdtempSync(path.join(tmpdir(), 'doop-test-'))
  const proc: ChildProcess = spawn(
    path.join(ROOT, 'node_modules', '.bin', 'tsx'),
    [path.join(ROOT, 'server', 'index.ts')],
    {
      cwd: dataDir, // PGlite persists to <cwd>/data — isolated per run
      env: { ...process.env, PORT: String(port), NODE_ENV: undefined as unknown as string, ...env },
      stdio: 'ignore',
    },
  )
  const base = `http://localhost:${port}`
  const stopped = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`)
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not boot within 60s')
    await new Promise((r) => setTimeout(r, 500))
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
      const [pair] = c.split(';')
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
