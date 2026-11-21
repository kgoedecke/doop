import { beforeAll, expect, it, vi } from 'vitest'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import type { AgentTask, TaskFeedback } from '../shared/types.ts'
import { db } from '../server/db/index.ts'
import * as t from '../server/db/schema.ts'

/* An agent's answer must survive a restart, and saving it must never undo
   what the next write says: a feedback row is saved with its reply and then
   again with its completion, back to back. */
vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

const persist = await import('../server/db/persist.ts')

const CANVAS = 'canvas-1'

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
})

it('keeps a card’s answer across a reload', async () => {
  const card: AgentTask = {
    id: 'card-1',
    agentName: 'Doop',
    color: '#000',
    status: 'Make the hero calmer',
    startedAt: 1,
    queuedBy: 'Kevin',
    claimedAt: 2,
  }
  persist.saveTask(CANVAS, card)
  persist.saveTask(CANVAS, { ...card, reply: 'Softened the hero.', endedAt: 3 })
  await vi.waitFor(async () => {
    const [row] = await db.select().from(t.tasks).where(eq(t.tasks.id, card.id))
    expect(row?.endedAt).toBe(3)
  })
  const { tasks } = await persist.hydrate()
  expect(tasks.get(CANVAS)?.find((x) => x.id === card.id)?.reply).toBe('Softened the hero.')
})

it('a reply saved just before completion leaves the feedback completed', async () => {
  const feedback: TaskFeedback = {
    id: 'fb-1',
    taskId: 'card-1',
    canvasId: CANVAS,
    agentName: 'Doop',
    from: 'Kevin',
    text: 'Now in blue',
    at: 4,
    deliveredAt: 5,
    claimedBy: 'Doop',
  }
  persist.saveFeedback(feedback)
  /* what the end of a run does: the reply, then the completion */
  persist.saveFeedback({ ...feedback, reply: 'Switched the accent to blue.' })
  persist.saveFeedback({ ...feedback, reply: 'Switched the accent to blue.', completedAt: 6 })
  await vi.waitFor(async () => {
    const [row] = await db.select().from(t.feedback).where(eq(t.feedback.id, feedback.id))
    expect(row).toMatchObject({ completedAt: 6, reply: 'Switched the accent to blue.' })
  })
  const restored = (await persist.hydrate()).feedback.get(CANVAS)?.find((f) => f.id === feedback.id)
  expect(restored).toMatchObject({ completedAt: 6, reply: 'Switched the accent to blue.' })
  expect(restored?.failedAt).toBeUndefined()
})

it('deleting a canvas waits for its queued writes, so no row comes back', async () => {
  const canvasId = 'canvas-gone'
  const card: AgentTask = {
    id: 'card-gone',
    agentName: 'Doop',
    color: '#000',
    status: 'Make it pop',
    startedAt: 1,
    queuedBy: 'Kevin',
  }
  const feedback: TaskFeedback = {
    id: 'fb-gone',
    taskId: card.id,
    canvasId,
    agentName: 'Doop',
    from: 'Kevin',
    text: 'More pop',
    at: 2,
  }
  /* a run's last writes, then the canvas is deleted in the same tick */
  persist.saveTask(canvasId, { ...card, reply: 'Popped.' })
  persist.saveFeedback({ ...feedback, reply: 'Popped more.' })
  persist.saveFeedback({ ...feedback, reply: 'Popped more.', completedAt: 3 })
  persist.deleteCanvas(canvasId)
  await vi.waitFor(async () => {
    const tasks = await db.select().from(t.tasks).where(eq(t.tasks.canvasId, canvasId))
    const feedbackRows = await db.select().from(t.feedback).where(eq(t.feedback.canvasId, canvasId))
    expect([...tasks, ...feedbackRows]).toEqual([])
  })
  /* and stays gone once every queued write has had its turn */
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(await db.select().from(t.feedback).where(eq(t.feedback.canvasId, canvasId))).toEqual([])
  expect(await db.select().from(t.tasks).where(eq(t.tasks.canvasId, canvasId))).toEqual([])
})
