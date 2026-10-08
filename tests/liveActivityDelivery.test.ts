import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import express from 'express'
import * as schema from '../server/db/schema.ts'

const rig = vi.hoisted(() => ({
  db: undefined as unknown as NodePgDatabase<typeof schema>,
  getCanvas: vi.fn(),
  getTasks: vi.fn(),
  allowed: vi.fn(),
  allCanvases: vi.fn((): { id: string; name: string }[] => []),
}))
vi.mock('../server/db/index.ts', () => ({
  get db() {
    return rig.db
  },
}))
vi.mock('../server/store.ts', () => ({ store: { getCanvas: rig.getCanvas, allCanvases: rig.allCanvases } }))
vi.mock('../server/actions.ts', () => ({ getTasks: rig.getTasks }))
vi.mock('../server/access.ts', () => ({ hasDurableCanvasAccess: rig.allowed }))
vi.mock('../server/apns.ts', () => ({ apnsConfigured: () => true, sendLiveActivityPush: vi.fn() }))
import { deliverLiveActivities, liveActivitiesRouter, resetLiveActivityStarts } from '../server/liveActivities.ts'

const pg = new PGlite()
beforeAll(async () => {
  rig.db = drizzle(pg, { schema }) as unknown as NodePgDatabase<typeof schema>
  await pg.exec(readFileSync('server/db/migrations/0025_live_activities.sql', 'utf8'))
})
afterAll(async () => {
  await pg.close()
})
beforeEach(async () => {
  await rig.db.delete(schema.liveActivities)
  await rig.db.delete(schema.liveActivityStarters)
  resetLiveActivityStarts()
  rig.allCanvases.mockReturnValue([])
  rig.getCanvas.mockReturnValue({ id: 'c', name: 'Confidential design' })
  rig.getTasks.mockReturnValue([{ id: 't', agentName: 'Doop', status: 'Sketching', startedAt: 1000 }])
  rig.allowed.mockReturnValue(true)
  await rig.db.insert(schema.liveActivities).values({
    id: 'a',
    userId: 'u',
    canvasId: 'c',
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    expiresAt: Date.now() + 600_000,
  })
})

it('delivers updates once, then sends a terminal event and removes the token', async () => {
  const send = vi.fn(async (_token: string, _environment: string, _payload: object) => 200)
  await deliverLiveActivities(send)
  expect(send).toHaveBeenCalledWith(
    'ab'.repeat(32),
    'sandbox',
    expect.objectContaining({
      aps: expect.objectContaining({ event: 'update', 'content-state': expect.objectContaining({ phase: 'working' }) }),
    }),
  )
  await deliverLiveActivities(send)
  expect(send).toHaveBeenCalledTimes(1)
  rig.getTasks.mockReturnValue([{ id: 't', agentName: 'Doop', status: 'Complete', startedAt: 1000, endedAt: 2000 }])
  await deliverLiveActivities(send)
  expect(send.mock.calls.at(-1)?.[2]).toMatchObject({ aps: { event: 'end', 'content-state': { phase: 'finished' } } })
  expect(await rig.db.select().from(schema.liveActivities)).toHaveLength(0)
})
it('ends revoked subscriptions without leaking private content', async () => {
  rig.allowed.mockReturnValue(false)
  const send = vi.fn(async (_token: string, _environment: string, _payload: object) => 200)
  await deliverLiveActivities(send)
  expect(JSON.stringify(send.mock.calls)).not.toContain('Confidential')
  expect(send.mock.calls[0]?.[2]).toMatchObject({
    aps: { event: 'end', 'content-state': { status: 'Activity ended' } },
  })
  expect(await rig.db.select().from(schema.liveActivities)).toHaveLength(0)
})
it('retains tokens after transient delivery failures and removes invalid ones', async () => {
  await deliverLiveActivities(async () => 503)
  expect(await rig.db.select().from(schema.liveActivities)).toHaveLength(1)
  await deliverLiveActivities(async () => 410)
  expect(await rig.db.select().from(schema.liveActivities)).toHaveLength(0)
})
it('does not send to expired registrations', async () => {
  await rig.db.update(schema.liveActivities).set({ expiresAt: 1 })
  const send = vi.fn(async (_token: string, _environment: string, _payload: object) => 200)
  await deliverLiveActivities(send)
  expect(send).not.toHaveBeenCalled()
})

it('starts an activity on registered devices for a task on any canvas the user belongs to, once', async () => {
  rig.allCanvases.mockReturnValue([
    { id: 'c', name: 'Confidential design' },
    { id: 'other', name: 'Another board' },
  ])
  rig.getTasks.mockImplementation((canvasId: string) =>
    canvasId === 'other' ? [{ id: 't2', agentName: 'Claude', status: 'Laying out', startedAt: 5000 }] : [],
  )
  await rig.db.delete(schema.liveActivities)
  await rig.db.insert(schema.liveActivityStarters).values({
    token: 'cd'.repeat(32),
    userId: 'u',
    environment: 'sandbox',
    origin: 'https://doop.design',
    expiresAt: Date.now() + 600_000,
  })
  const send = vi.fn(async (_token: string, _environment: string, _payload: object, _priority?: number) => 200)
  await deliverLiveActivities(send)
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith(
    'cd'.repeat(32),
    'sandbox',
    {
      aps: expect.objectContaining({
        event: 'start',
        'attributes-type': 'AgentActivityAttributes',
        attributes: { canvasID: 'other', serverOrigin: 'https://doop.design' },
        'content-state': expect.objectContaining({
          phase: 'working',
          agentName: 'Claude',
          canvasName: 'Another board',
        }),
      }),
    },
    10,
  )
  // the same task is not announced again; a device that reports the activity is not started twice either
  await deliverLiveActivities(send)
  expect(send).toHaveBeenCalledTimes(1)
})
it('does not start activities for canvases the user cannot access, and drops dead start tokens', async () => {
  rig.allCanvases.mockReturnValue([{ id: 'other', name: 'Another board' }])
  rig.getTasks.mockReturnValue([{ id: 't2', agentName: 'Claude', status: 'Laying out', startedAt: 6000 }])
  rig.allowed.mockReturnValue(false)
  await rig.db.delete(schema.liveActivities)
  await rig.db.insert(schema.liveActivityStarters).values({
    token: 'ef'.repeat(32),
    userId: 'u',
    environment: 'sandbox',
    origin: 'https://doop.design',
    expiresAt: Date.now() + 600_000,
  })
  const send = vi.fn(async () => 200)
  await deliverLiveActivities(send)
  expect(send).not.toHaveBeenCalled()
  rig.allowed.mockReturnValue(true)
  await deliverLiveActivities(async () => 410)
  expect(await rig.db.select().from(schema.liveActivityStarters)).toHaveLength(0)
})

it('bounds concurrency and stops at the run deadline, leaving the rest for the next tick', async () => {
  const { forEachBounded } = await import('../server/liveActivities.ts')
  let inFlight = 0
  let peak = 0
  const seen: number[] = []
  await forEachBounded([1, 2, 3, 4, 5, 6], 2, Date.now() + 10_000, async (n) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    seen.push(n)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight -= 1
  })
  expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
  expect(peak).toBe(2)
  const late: number[] = []
  await forEachBounded([1, 2, 3], 8, Date.now() - 1, async (n) => {
    late.push(n)
  })
  expect(late).toEqual([])
})

it('registers push-to-start tokens on their own route instead of the activity id route', async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'u' } as typeof req.user
    next()
  })
  app.use('/api/live-activities', liveActivitiesRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/live-activities`
  try {
    const token = 'cd'.repeat(32)
    const put = await fetch(`${base}/push-to-start`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, environment: 'production', origin: 'https://doop.design' }),
    })
    expect(put.status).toBe(200)
    expect(await rig.db.select().from(schema.liveActivityStarters)).toMatchObject([{ token, userId: 'u' }])
    const del = await fetch(`${base}/push-to-start/${token}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await rig.db.select().from(schema.liveActivityStarters)).toHaveLength(0)
  } finally {
    server.close()
  }
})
