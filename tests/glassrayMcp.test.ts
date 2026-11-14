import { beforeAll, expect, it, vi } from 'vitest'
import { checkMcpServer, formatChecks } from '@glassray/signals/testing'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import { buildMcpServer } from '../server/mcp.ts'

/**
 * Glassray plays a short session against the MCP server Doop really builds —
 * a call that fails, then a report, then a person complaining in the agent's
 * chat — and grades what arrives: the instructions agents read, Doop's own
 * report_issue, the words the agent passes on, the calls a report carries
 * with it, and whether every signal says who the person is. The stand-in
 * Glassray lives inside checkMcpServer, so nothing leaves the machine.
 */

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

it('Glassray hears from this MCP server', async () => {
  const result = await checkMcpServer(() => buildMcpServer('Glassray Check', 'glassray-check-user'), {
    /* a frame id that cannot exist: get_frame answers with isError */
    failingCall: { tool: 'get_frame', args: { frame_id: 'no-such-frame' } },
    reportTool: 'report_issue',
    reportArgs: { category: 'tool_error' },
  })
  expect(result.ok, formatChecks(result)).toBe(true)

  /* the report is the agent's side of the story: it has to name the person
     and the canvas-less report still carries the call that failed */
  const report = result.signals.find((s) => s.source === 'agent')
  expect(report?.refs?.user).toBe('glassray-check-user')
  expect(report?.kind).toBe('tool_failure')
  expect(report?.context?.recent_tool_calls).toEqual(
    expect.arrayContaining([expect.objectContaining({ tool: 'get_frame', ok: false })]),
  )
}, 30_000)
