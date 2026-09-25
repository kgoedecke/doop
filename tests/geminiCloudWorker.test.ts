import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGeminiCloudWorker, runGeminiCli, geminiWorkerSettings } from '../server/geminiCloudWorker.ts'
import { geminiCloudWorkerFor } from '../server/geminiCloudRuns.ts'
import { httpOrigin, type GeminiCloudJob } from '../shared/geminiCloud.ts'

const job: GeminiCloudJob = {
  id: '1b088126-e936-4339-8c2a-e0593b629865',
  token: 'a'.repeat(64),
  prompt: 'Make a card',
  system: 'Use Doop tools',
  maxTurns: 4,
}
const secret = 'worker-secret-'.repeat(4)
const servers: Server[] = []
const directories: string[] = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function listen(app: ReturnType<typeof createGeminiCloudWorker>['app']) {
  const server = await new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('Gemini cloud worker', () => {
  it('authenticates before accepting jobs, validates input, and permits only one active run', async () => {
    let finish!: (result: { success: boolean; text: string }) => void
    const started = deferred()
    const runner = vi.fn(() => {
      started.resolve()
      return new Promise<{ success: boolean; text: string }>((resolve) => {
        finish = resolve
      })
    })
    const worker = createGeminiCloudWorker({ token: secret, origin: 'https://doop.example', runner })
    const origin = await listen(worker.app)
    const post = (body: unknown, token = secret) =>
      fetch(`${origin}/runs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await post(job, 'wrong')).status).toBe(401)
    expect((await post({ ...job, maxTurns: 0 })).status).toBe(400)
    expect(runner).not.toHaveBeenCalled()
    const first = post(job)
    await started.promise
    expect((await post(job)).status).toBe(409)
    finish({ success: true, text: 'Done' })
    expect(await (await first).json()).toEqual({ success: true, text: 'Done' })
  })

  it('cancels the agent when the dispatcher connection disappears', async () => {
    const started = deferred()
    const cancelled = deferred()
    const worker = createGeminiCloudWorker({
      token: secret,
      origin: 'https://doop.example',
      runner: async (_job, _origin, signal) => {
        started.resolve()
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              cancelled.resolve()
              resolve()
            },
            { once: true },
          ),
        )
        return { success: false, text: 'Cancelled' }
      },
    })
    const origin = await listen(worker.app)
    const controller = new AbortController()
    const request = fetch(`${origin}/runs`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    }).catch(() => null)
    await started.promise
    controller.abort()
    await cancelled.promise
    await request
  })

  it('restricts the CLI to Google login and the assigned MCP server', () => {
    const settings = geminiWorkerSettings(job, 'https://doop.example')
    expect(settings.security.auth).toEqual({ selectedType: 'oauth-personal', enforcedType: 'oauth-personal' })
    expect(settings.tools.core).toEqual([])
    expect(settings.mcp.allowed).toEqual(['doop'])
    expect(settings.mcpServers.doop.httpUrl).toBe(`https://doop.example/gemini-cloud/mcp/${job.id}`)
    expect(settings.hooksConfig.enabled).toBe(false)
    expect(settings.admin.extensions.enabled).toBe(false)
    expect(() => httpOrigin('https://user:secret@example.com/')).toThrow()
    expect(() => httpOrigin('file:///tmp/')).toThrow()
  })

  it('runs a real child process with stdin, removes temporary credentials, and excludes worker/API secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gemini-test-'))
    directories.push(directory)
    const script = join(directory, 'cli.cjs')
    await writeFile(
      script,
      `const fs = require('node:fs'); let prompt = ''; process.stdin.on('data', x => prompt += x); process.stdin.on('end', () => console.log(JSON.stringify({response: JSON.stringify({prompt, directory: process.cwd(), system: fs.readFileSync(process.env.GEMINI_SYSTEM_MD, 'utf8'), workerSecret: process.env.GEMINI_WORKER_TOKEN, apiKey: process.env.GEMINI_API_KEY})})));`,
    )
    vi.stubEnv('GEMINI_WORKER_TOKEN', secret)
    vi.stubEnv('GEMINI_API_KEY', 'must-not-reach-child')
    const result = await runGeminiCli(job, 'https://doop.example', new AbortController().signal, {
      executable: process.execPath,
      args: [script],
    })
    expect(result.success).toBe(true)
    const output = JSON.parse(result.text)
    expect(output).toMatchObject({ prompt: job.prompt, system: job.system })
    expect(output.workerSecret).toBeUndefined()
    expect(output.apiKey).toBeUndefined()
    await expect(access(output.directory)).rejects.toThrow()
  })

  it('fails closed on malformed output, CLI failure, and excess output', async () => {
    for (const code of ['console.log("not json")', 'process.exit(1)', 'process.stdout.write("x".repeat(1100000))']) {
      const directory = await mkdtemp(join(tmpdir(), 'gemini-test-'))
      directories.push(directory)
      const script = join(directory, 'cli.cjs')
      await writeFile(script, code)
      const result = await runGeminiCli(job, 'https://doop.example', new AbortController().signal, {
        executable: process.execPath,
        args: [script],
      })
      expect(result.success).toBe(false)
      expect(result.text.length).toBeLessThan(200)
    }
  })

  it('terminates an already-running CLI process on cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gemini-test-'))
    directories.push(directory)
    const script = join(directory, 'cli.cjs')
    const marker = join(directory, 'pid')
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
    )
    const controller = new AbortController()
    const run = runGeminiCli(job, 'https://doop.example', controller.signal, {
      executable: process.execPath,
      args: [script],
    })
    try {
      await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toMatch(/^\d+$/))
    } finally {
      controller.abort()
    }
    expect((await run).success).toBe(false)
    const pid = Number(await readFile(marker, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('rejects shared workers and hides configuration secrets in errors', () => {
    vi.stubEnv('DOOP_GEMINI_CLOUD_WORKERS', JSON.stringify({ alice: { url: 'https://worker.example', token: secret } }))
    expect(geminiCloudWorkerFor('bob')).toBeUndefined()
    expect(geminiCloudWorkerFor('alice')?.url).toBe('https://worker.example')
    vi.stubEnv(
      'DOOP_GEMINI_CLOUD_WORKERS',
      JSON.stringify({
        alice: { url: 'https://worker.example', token: secret },
        bob: { url: 'https://worker.example', token: secret },
      }),
    )
    expect(() => geminiCloudWorkerFor('alice')).toThrow('Invalid DOOP_GEMINI_CLOUD_WORKERS configuration')
  })
})
