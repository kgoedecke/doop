import { createServer, type Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from '../server/mcp.ts'

const TOKEN = 'lin_api_' + 'a'.repeat(40)
let server: Server
let upstream: HttpServer
let owner: Client
let stranger: Client

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== TOKEN) {
      res.writeHead(401)
      res.end(JSON.stringify({ errors: [{ message: 'invalid credential' }] }))
      return
    }
    res.end(
      JSON.stringify({
        data: {
          viewer: { id: 'viewer', name: 'Test User' },
          organization: { id: 'org', name: 'Test Workspace' },
        },
      }),
    )
  })
  await new Promise<void>((resolve) => upstream.listen(4977, resolve))
  server = await startServer(4976, { LINEAR_API_URL: 'http://localhost:4977' })
  owner = await new Client(server).signUp('linear-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('linear-stranger@test.dev', 'Stranger')
}, 60_000)

afterAll(() => {
  server?.stop()
  upstream?.close()
})

describe('Linear connection', () => {
  it('requires authentication', async () => {
    const response = await new Client(server).post('/api/integrations/linear/token', { token: TOKEN })
    expect(response.status).toBe(401)
  })

  it('rejects malformed keys without connecting', async () => {
    expect((await owner.post('/api/integrations/linear/token', { token: 42 })).status).toBe(400)
    expect((await owner.post('/api/integrations/linear/token', { token: 'no' })).status).toBe(400)
    expect((await (await owner.get('/api/integrations')).json()).linear).toMatchObject({ connected: false })
  })

  it('connects only the current user and never returns the credential', async () => {
    const response = await owner.post('/api/integrations/linear/token', { token: TOKEN })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.linear).toMatchObject({ connected: true, accountName: 'Test User · Test Workspace' })
    expect(JSON.stringify(body)).not.toContain(TOKEN)
    expect(body.linear).not.toHaveProperty('accessToken')
    expect((await (await stranger.get('/api/integrations')).json()).linear).toMatchObject({ connected: false })
  })

  it('keeps the working connection when a replacement key fails', async () => {
    const response = await owner.post('/api/integrations/linear/token', { token: 'lin_api_' + 'b'.repeat(40) })
    expect(response.status).toBe(409)
    expect((await (await owner.get('/api/integrations')).json()).linear.connected).toBe(true)
  })

  it('disconnect is isolated by user and idempotent', async () => {
    expect((await stranger.delete('/api/integrations/linear')).status).toBe(200)
    expect((await (await owner.get('/api/integrations')).json()).linear.connected).toBe(true)
    const response = await owner.delete('/api/integrations/linear')
    expect((await response.json()).linear).toMatchObject({ connected: false })
    expect((await owner.delete('/api/integrations/linear')).status).toBe(200)
  })
})

it('offers read-only MCP tools with no credential inputs and refuses an ownerless session', async () => {
  const mcp = buildMcpServer()
  const client = new McpClient({ name: 'linear-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(b)
  await client.connect(a)
  try {
    const { tools } = await client.listTools()
    for (const name of ['list_linear_issues', 'get_linear_issue']) {
      const tool = tools.find((entry) => entry.name === name)
      expect(tool?.annotations?.readOnlyHint).toBe(true)
      expect(tool?.inputSchema.properties).not.toHaveProperty('token')
    }
    const result = await client.callTool({ name: 'get_linear_issue', arguments: { id: 'ENG-123' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Connect Linear')
    expect(client.getInstructions()).toContain('list_linear_issues')
  } finally {
    await client.close()
    await mcp.close()
  }
})
