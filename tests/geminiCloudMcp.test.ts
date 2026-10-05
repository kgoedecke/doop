import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { GeminiCloudJob } from '../shared/geminiCloud.ts'

const state = vi.hoisted(() => ({ allowed: true, banned: false }))
vi.mock('../server/auth.ts', () => ({ isBanned: async () => state.banned }))
vi.mock('../server/access.ts', () => ({ canAccessCanvas: (user: string) => user === 'alice' && state.allowed }))
vi.mock('../server/store.ts', () => ({ store: { getCanvas: (id: string) => ({ id }) } }))
import { handleGeminiCloudMcp } from '../server/geminiCloudMcp.ts'
import { geminiCloudRuns } from '../server/geminiCloudRuns.ts'

const servers: Server[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  state.allowed = true
  state.banned = false
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})
async function listen(app: ReturnType<typeof express>) {
  const server = await new Promise<Server>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('Gemini cloud dispatch and run-scoped MCP', () => {
  it('dispatches without Google credentials, executes tools, enforces revocation and expires the capability', async () => {
    const app = express()
    app.use(express.json())
    app.all('/gemini-cloud/mcp/:id', (req, res, next) => {
      handleGeminiCloudMcp(req, res).catch(next)
    })
    const origin = await listen(app)
    let endpoint = ''
    let token = ''
    const execute = vi.fn(async () => ({
      type: 'tool_result' as const,
      tool_use_id: 'tool',
      content: [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aW1hZ2U=' },
        },
      ],
    }))
    let workerError: unknown
    const worker = express()
    worker.use(express.json())
    worker.post('/runs', (req, res) => {
      void (async () => {
        expect(req.headers.authorization).toBe(`Bearer ${'w'.repeat(32)}`)
        const job: GeminiCloudJob = req.body
        expect(Object.keys(job).sort()).toEqual(['id', 'maxTurns', 'prompt', 'system', 'token'])
        endpoint = `${origin}/gemini-cloud/mcp/${job.id}`
        token = job.token
        const client = new Client({ name: 'gemini-test', version: '1' })
        await client.connect(
          new StreamableHTTPClientTransport(new URL(endpoint), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          }),
        )
        try {
          expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['screenshot_frame'])
          const result = await client.callTool({ name: 'screenshot_frame', arguments: {} })
          expect(result.content).toEqual([{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }])
          await expect(client.callTool({ name: 'run_shell_command', arguments: {} })).rejects.toThrow(
            'Run or tool unavailable',
          )
          await expect(
            geminiCloudRuns.execute(job.id, job.token, 'screenshot_frame', {}, async () => false),
          ).rejects.toThrow('revoked')
          state.allowed = false
          expect(
            (await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status,
          ).toBe(403)
          state.allowed = true
          state.banned = true
          expect(
            (await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status,
          ).toBe(403)
          state.banned = false
          expect((await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status).toBe(
            403,
          )
        } finally {
          await client.close()
        }
        res.json({ success: true, text: 'Verified' })
      })().catch((error) => {
        workerError = error
        res.status(500).end()
      })
    })
    const workerUrl = await listen(worker)
    const config = { url: workerUrl, token: 'w'.repeat(32) }
    vi.stubEnv('DOOP_GEMINI_CLOUD_WORKERS', JSON.stringify({ alice: config }))
    const result = await geminiCloudRuns.start('alice', config, {
      canvasId: 'canvas-a',
      prompt: 'Verify',
      system: 'Use tools',
      maxTurns: 4,
      tools: [{ name: 'screenshot_frame', input_schema: { type: 'object', properties: {} } }],
      execute,
    })
    expect(workerError).toBeUndefined()
    expect(result).toEqual({ success: true, text: 'Verified' })
    expect(execute).toHaveBeenCalledOnce()
    expect((await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(403)
  })
})
