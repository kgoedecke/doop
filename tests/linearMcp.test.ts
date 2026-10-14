import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import { connect, disconnect } from '../server/linear/connection.ts'
import { buildMcpServer } from '../server/mcp.ts'

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

const keys = { alice: 'lin_api_' + 'a'.repeat(40), bob: 'lin_api_' + 'b'.repeat(40) }
const requests: { token: string; query: string; variables: Record<string, unknown> }[] = []
let upstream: Server
let revoked = false

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
  upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const { query, variables } = JSON.parse(raw)
      const token = req.headers.authorization ?? ''
      requests.push({ token, query, variables })
      res.setHeader('Content-Type', 'application/json')
      const owner = token === keys.alice ? 'alice' : token === keys.bob ? 'bob' : undefined
      if (!owner || (revoked && owner === 'alice')) {
        res.writeHead(401)
        res.end(JSON.stringify({ errors: [{ message: 'Invalid key' }] }))
        return
      }
      const issue = {
        id: owner + '-issue',
        identifier: 'ENG-123',
        title: owner + ' design',
        url: 'https://linear.app/test/issue/ENG-123',
        priority: 2,
        updatedAt: '2026-09-25T00:00:00Z',
        state: { id: 'todo', name: 'Todo', type: 'unstarted' },
        team: { id: 'team', key: 'ENG', name: 'Engineering' },
        assignee: null,
        project: null,
        description: owner + ' private brief',
      }
      const data = query.includes('DoopConnection')
        ? { viewer: { id: owner, name: owner }, organization: { id: 'org', name: 'Workspace' } }
        : query.includes('DoopIssues')
          ? { issues: { nodes: [issue], pageInfo: { hasNextPage: true, endCursor: owner + '-cursor' } } }
          : { issue }
      res.end(JSON.stringify({ data }))
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  vi.stubEnv('LINEAR_API_URL', `http://localhost:${address.port}`)
  await connect('alice', keys.alice)
  await connect('bob', keys.bob)
}, 30_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

async function withClient(ownerId: string, run: (client: Client) => Promise<void>) {
  const server = buildMcpServer(ownerId, ownerId)
  const client = new Client({ name: 'linear-read-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  try {
    await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

it('lists and reads tickets through MCP using each connected owner’s key', async () => {
  for (const owner of ['alice', 'bob'] as const) {
    await withClient(owner, async (client) => {
      const listed = await client.callTool({
        name: 'list_linear_issues',
        arguments: { team_key: 'ENG', first: 5, after: 'previous' },
      })
      expect(listed.isError).not.toBe(true)
      expect(JSON.stringify(listed)).toContain(owner + ' design')
      expect(JSON.stringify(listed)).toContain(owner + '-cursor')
      expect(requests.at(-1)).toMatchObject({
        token: keys[owner],
        variables: { first: 5, after: 'previous', filter: { team: { key: { eq: 'ENG' } } } },
      })
      const issue = await client.callTool({ name: 'get_linear_issue', arguments: { id: 'ENG-123' } })
      expect(issue.isError).not.toBe(true)
      expect(JSON.stringify(issue)).toContain(owner + ' private brief')
      expect(JSON.stringify(issue)).not.toContain(keys[owner])
      expect(requests.at(-1)).toMatchObject({ token: keys[owner], variables: { id: 'ENG-123' } })
    })
  }
})

it('rejects a user without a connection before making an upstream call', async () => {
  const before = requests.length
  await withClient('stranger', async (client) => {
    const result = await client.callTool({ name: 'get_linear_issue', arguments: { id: 'ENG-123' } })
    expect(result.isError).toBe(true)
  })
  expect(requests).toHaveLength(before)
})

it('surfaces revoked credentials and stops reads after disconnect', async () => {
  revoked = true
  await withClient('alice', async (client) => {
    const result = await client.callTool({ name: 'get_linear_issue', arguments: { id: 'ENG-123' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Reconnect')
    await disconnect('alice')
    const before = requests.length
    expect((await client.callTool({ name: 'list_linear_issues', arguments: {} })).isError).toBe(true)
    expect(requests).toHaveLength(before)
  })
})
