import { beforeAll, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { listAgentFeedback, recordAgentFeedback } from '../server/agentFeedback.ts'

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
}, 30_000)

async function connectAs(userId: string) {
  const server = buildMcpServer('Test Owner', userId)
  const client = new Client({ name: 'feedback-test-client', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as { type: string; text?: string }[]
  return first?.text ?? ''
}

it('stores what an MCP agent reports, with the account and client it came from', async () => {
  const client = await connectAs('user-report')
  const result = await client.callTool({
    name: 'report_issue',
    arguments: {
      category: 'tool_error',
      message: 'edit_frame_html said the find string was missing, but get_frame shows it verbatim',
      tool: 'edit_frame_html',
      agent_name: 'Claude',
    },
  })
  expect(result.isError).toBeFalsy()
  const { id } = JSON.parse(textOf(result)) as { id: string }

  const stored = (await listAgentFeedback()).reports.find((r) => r.id === id)
  expect(stored).toMatchObject({
    kind: 'issue',
    source: 'mcp',
    category: 'tool_error',
    tool: 'edit_frame_html',
    agentName: 'Claude',
    client: 'feedback-test-client',
    userId: 'user-report',
    canvasId: null,
  })
  await client.close()
})

it('stores ideas from share_feedback apart from issues', async () => {
  const client = await connectAs('user-idea')
  const result = await client.callTool({
    name: 'share_feedback',
    arguments: { category: 'idea', message: 'a batch edit_frame_html would save me a call per change' },
  })
  expect(result.isError).toBeFalsy()
  const { id } = JSON.parse(textOf(result)) as { id: string }
  expect((await listAgentFeedback()).reports.find((r) => r.id === id)).toMatchObject({
    kind: 'feedback',
    category: 'idea',
  })

  const wrongKind = await client.callTool({
    name: 'share_feedback',
    arguments: { category: 'tool_error', message: 'an issue category on the ideas tool' },
  })
  expect(wrongKind.isError).toBe(true)
  await client.close()
})

it('refuses a canvas the account cannot see', async () => {
  const client = await connectAs('user-stranger')
  const result = await client.callTool({
    name: 'report_issue',
    arguments: { category: 'bug', message: 'something broke', canvas_id: 'not-a-canvas' },
  })
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain('no canvas with id not-a-canvas')
  await client.close()
})

it('rejects an empty message and caps how often one account can report', async () => {
  expect(await recordAgentFeedback({ kind: 'issue', source: 'resident', category: 'other', message: '   ' })).toEqual({
    ok: false,
    error: 'message must not be empty',
  })
  const report = () =>
    recordAgentFeedback({ kind: 'feedback', source: 'mcp', category: 'bug', message: 'again', userId: 'user-looping' })
  for (let i = 0; i < 20; i++) expect((await report()).ok).toBe(true)
  const blocked = await report()
  expect(blocked.ok).toBe(false)
})

it('pages through older reports and searches all of them, not just the first page', async () => {
  for (let i = 0; i < 5; i++)
    await recordAgentFeedback({
      kind: 'issue',
      source: 'mcp',
      category: 'bug',
      message: `paged report ${i}`,
      userId: `user-paging-${i}`,
    })
  /* reports from the same millisecond order by id, so walk the pages rather than assume an order */
  const seen: string[] = []
  let before: { at: number; id: string } | undefined
  for (let pages = 0; pages < 5; pages++) {
    const page = await listAgentFeedback({ q: 'paged report', limit: 2, before })
    expect(page.counts).toEqual({ issue: 5, feedback: 0 })
    seen.push(...page.reports.map((r) => r.message))
    const last = page.reports.at(-1)
    if (!page.hasMore || !last) break
    before = { at: last.at, id: last.id }
  }
  expect([...seen].sort()).toEqual([0, 1, 2, 3, 4].map((i) => `paged report ${i}`))

  const oldest = await listAgentFeedback({ q: 'PAGED REPORT 0' })
  expect(oldest.reports.map((r) => r.message)).toEqual(['paged report 0'])
  expect((await listAgentFeedback({ q: 'paged report', kind: 'feedback' })).reports).toEqual([])
  expect((await listAgentFeedback({ q: '100%' })).reports).toEqual([])
})
