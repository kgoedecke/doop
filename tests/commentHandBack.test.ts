import { beforeAll, expect, it, vi } from 'vitest'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import type { ElementComment } from '../shared/types.ts'
import { db } from '../server/db/index.ts'

/* A request handed back to the person must stay handed back across a
   restart: the database row, not just memory, drops the agent flag. */
vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

const persist = await import('../server/db/persist.ts')
const actions = await import('../server/actions.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
const CANVAS = 'canvas-1'

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
  actions.wire(
    () => {},
    () => {},
  )
})

it('keeps a handed-back request out of the agent queue after a reload', async () => {
  const request: ElementComment = {
    id: 'q1',
    canvasId: CANVAS,
    pageId: 'p1',
    x: 10,
    y: 10,
    snippet: '',
    from: 'alice',
    fromUserId: 'alice',
    text: `@${DEFAULT_ROLE_ID} make it pop`,
    at: 1,
    forAgent: true,
    targetAgent: AGENT,
    claimedBy: AGENT,
    claimedAt: 2,
  }
  await persist.saveCommentNow(request)
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([[CANVAS, [request]]]),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  expect(actions.handBackComment('q1', AGENT)?.forAgent).toBeUndefined()
  await persist.saveCommentNow(actions.findComment('q1')!)

  const { comments } = await persist.hydrate()
  const reloaded = comments.get(CANVAS)?.find((c) => c.id === 'q1')
  expect(reloaded?.forAgent).toBeUndefined()
  expect(reloaded?.claimedBy).toBeUndefined()
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments,
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  expect(actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice')).toEqual([])
})
