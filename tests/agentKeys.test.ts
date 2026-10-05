import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Agent keys: the account-scoped bearer credentials headless MCP clients
 * authenticate with, exercised against the real server — the REST surface
 * that mints and revokes them, and the /mcp gate that accepts them.
 */

const PORT = 5004

let server: Server
let BASE: string

beforeAll(async () => {
  server = await startServer(PORT)
  BASE = server.base
}, 70_000)

afterAll(() => server?.stop())

/** A minimal stateless MCP round-trip: initialize, authenticated by `secret`. */
function mcpInitialize(secret?: string) {
  return fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'agent-keys-test', version: '1.0.0' },
      },
    }),
  })
}

describe('agent keys', () => {
  let owner: Client
  let stranger: Client
  let secret: string
  let keyId: string

  beforeAll(async () => {
    owner = new Client(server)
    stranger = new Client(server)
    await owner.signUp('keys-owner@test.dev', 'Owner')
    await stranger.signUp('keys-stranger@test.dev', 'Stranger')
  })

  it('mints a key whose secret appears once and is never listed', async () => {
    const res = await owner.post('/api/agent-keys', { name: 'mastra-prod' })
    expect(res.status).toBe(200)
    const key = (await res.json()) as { id: string; name: string; secret: string; start: string }
    expect(key.secret).toMatch(/^dpk_[\w-]{32}$/)
    expect(key.start).toBe(key.secret.slice(0, 8))
    expect(key.name).toBe('mastra-prod')
    secret = key.secret
    keyId = key.id

    const listed = (await (await owner.get('/api/agent-keys')).json()) as Record<string, unknown>[]
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty('secret')
    expect(listed[0]).not.toHaveProperty('secretHash')
    expect(listed[0]!.start).toBe(secret.slice(0, 8))
  })

  it('authenticates /mcp with the key as a bearer', async () => {
    const res = await mcpInitialize(secret)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('serverInfo')
  })

  it('still routes everything else to the OAuth gate', async () => {
    const anonymous = await mcpInitialize()
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toContain('oauth-protected-resource')
  })

  it('rejects an unknown key without pointing it at OAuth discovery', async () => {
    const res = await mcpInitialize('dpk_00000000000000000000000000000000')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  it("won't let one account touch another's keys", async () => {
    const res = await stranger.delete(`/api/agent-keys/${keyId}`)
    expect(res.status).toBe(404)
    expect((await mcpInitialize(secret)).status).toBe(200)
  })

  it('holds the per-account ceiling under concurrent creates', async () => {
    const crowd = new Client(server)
    await crowd.signUp('keys-crowd@test.dev', 'Crowd')
    /* all at once: a count-then-insert would let every one of these see room
       and take it, landing the account well past the ceiling */
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => crowd.post('/api/agent-keys', { name: `key-${i}` })),
    )
    expect(results.filter((r) => r.status === 200)).toHaveLength(25)
    expect(results.filter((r) => r.status === 400)).toHaveLength(5)
    const listed = (await (await crowd.get('/api/agent-keys')).json()) as unknown[]
    expect(listed).toHaveLength(25)
  })

  it('revokes: the next MCP request with the secret gets a 401', async () => {
    const res = await owner.delete(`/api/agent-keys/${keyId}`)
    expect(res.status).toBe(200)
    expect((await mcpInitialize(secret)).status).toBe(401)
    expect((await (await owner.get('/api/agent-keys')).json()) as unknown[]).toHaveLength(0)
  })
})
