import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

vi.mock('../server/auth.ts', () => ({ isBanned: async () => false }))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/localAgentPreferences.ts', () => ({
  getLocalAgentPreference: vi.fn(),
  saveLocalAgentPreference: vi.fn(),
}))
vi.mock('../server/access.ts', () => ({ canAccessCanvas: (user: string) => user === 'alice' }))
vi.mock('../server/store.ts', () => ({ store: { getCanvas: (id: string) => ({ id }), canvases: new Map() } }))

import { handleLocalAgentMcp } from '../server/localAgent.ts'
import { localAgentRuns } from '../server/localAgentRuns.ts'

let server: HttpServer
let origin: string
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.all('/local-agent/mcp/:id', (req, res, next) => {
    handleLocalAgentMcp(req, res).catch(next)
  })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('per-run MCP transport', () => {
  it('supports the real MCP handshake, tool listing and screenshot content without account credentials', async () => {
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
    const result = localAgentRuns.start('alice', 'default', {
      canvasId: 'canvas-a',
      prompt: 'Verify',
      system: 'Use tools',
      maxTurns: 4,
      tools: [
        {
          name: 'screenshot_frame',
          input_schema: { type: 'object', properties: { frame_id: { type: 'string' } }, required: ['frame_id'] },
        },
      ],
      execute,
    })
    const job = localAgentRuns.poll('alice', 'desktop')!
    const endpoint = new URL(`${origin}/local-agent/mcp/${job.id}`)
    const denied = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(denied.status).toBe(403)
    const client = new Client({ name: 'test-cli', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${job.token}` } },
      }),
    )
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['screenshot_frame'])
    const shot = await client.callTool({ name: 'screenshot_frame', arguments: { frame_id: 'frame-a' } })
    expect(shot.content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }])
    expect(execute).toHaveBeenCalledOnce()
    await client.close()
    await localAgentRuns.finish(job.id, 'alice', 'desktop', { success: true, text: 'Verified' })
    expect((await result).success).toBe(true)
    expect((await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${job.token}` } })).status).toBe(
      403,
    )
  })
})
