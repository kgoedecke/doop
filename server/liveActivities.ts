import { Router, type NextFunction, type Request, type Response } from 'express'
import { and, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { db } from './db/index.ts'
import { liveActivities, liveActivityStarters } from './db/schema.ts'
import { store } from './store.ts'
import { hasDurableCanvasAccess } from './access.ts'
import { getTasks } from './actions.ts'
import { agentActivityState } from '../shared/agentActivity.ts'
import { apnsConfigured, sendLiveActivityPush } from './apns.ts'

export const liveActivitiesRouter = Router()

/** Request log for the Live Activity endpoints. Mounted ahead of the API auth
 *  middleware so a registration that fails with 401 (the app launched in the
 *  background before its session was restored) shows up next to the 400/403/503
 *  answers from this router. Logs the method, route shape and status; never a token. */
export function logLiveActivityRequests(req: Request, res: Response, next: NextFunction) {
  res.on('finish', () => {
    const path = req.path.replace(/[a-f0-9]{32,}/g, '<token>')
    console.log(`[live-activities] ${req.method} ${path} -> ${res.statusCode}`)
  })
  next()
}
const registration = z.object({
  canvasId: z.string().min(1).max(100),
  token: z.string().regex(/^[a-f0-9]{32,512}$/),
  environment: z.enum(['sandbox', 'production']),
})

liveActivitiesRouter.get('/config', (_req, res) => res.json({ enabled: apnsConfigured() }))
// Registered before `/:id`, which would otherwise swallow the literal path.
const starter = z.object({
  token: z.string().regex(/^[a-f0-9]{32,512}$/),
  environment: z.enum(['sandbox', 'production']),
  origin: z.string().url().max(200),
})
/** A push-to-start token: lets the server open an activity for any canvas the
 *  user belongs to. Refreshed on every app launch; retired after 30 days. */
liveActivitiesRouter.put('/push-to-start', async (req, res) => {
  const parsed = starter.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'invalid push-to-start registration' })
  if (!apnsConfigured())
    return res.status(503).json({ error: 'Live Activity push delivery is not configured on this server' })
  const values = { ...parsed.data, userId: req.user!.id, expiresAt: Date.now() + 30 * 24 * 60 * 60_000 }
  await db
    .insert(liveActivityStarters)
    .values(values)
    .onConflictDoUpdate({
      target: liveActivityStarters.token,
      set: {
        userId: values.userId,
        environment: values.environment,
        origin: values.origin,
        expiresAt: values.expiresAt,
      },
    })
  res.json({ ok: true })
})
liveActivitiesRouter.delete('/push-to-start/:token', async (req, res) => {
  await db
    .delete(liveActivityStarters)
    .where(and(eq(liveActivityStarters.token, req.params.token), eq(liveActivityStarters.userId, req.user!.id)))
  res.json({ ok: true })
})
liveActivitiesRouter.put('/:id', async (req, res) => {
  const parsed = registration.safeParse(req.body)
  if (!parsed.success || !/^[\w-]{1,100}$/.test(req.params.id))
    return res.status(400).json({ error: 'invalid activity registration' })
  const canvas = store.getCanvas(parsed.data.canvasId)
  if (!canvas || !hasDurableCanvasAccess(req.user!.id, canvas))
    return res.status(403).json({ error: 'canvas membership required' })
  if (!apnsConfigured())
    return res.status(503).json({ error: 'Live Activity push delivery is not configured on this server' })
  try {
    const [existing] = await db.select().from(liveActivities).where(eq(liveActivities.id, req.params.id))
    if (existing && (existing.userId !== req.user!.id || existing.canvasId !== canvas.id))
      return res.status(409).json({ error: 'activity already registered' })
    const subscriptions = await db
      .select({ id: liveActivities.id })
      .from(liveActivities)
      .where(eq(liveActivities.userId, req.user!.id))
    if (!existing && subscriptions.length >= 12) return res.status(429).json({ error: 'too many live activities' })
    const values = {
      id: req.params.id,
      userId: req.user!.id,
      ...parsed.data,
      expiresAt: existing?.expiresAt ?? Date.now() + 8 * 60 * 60_000,
    }
    await db
      .insert(liveActivities)
      .values(values)
      .onConflictDoUpdate({
        target: liveActivities.id,
        set: { token: values.token, environment: values.environment },
        setWhere: eq(liveActivities.userId, req.user!.id),
      })
    res.json({ ok: true })
  } catch {
    res.status(409).json({ error: 'could not register live activity' })
  }
})
liveActivitiesRouter.delete('/:id', async (req, res) => {
  await db
    .delete(liveActivities)
    .where(and(eq(liveActivities.id, req.params.id), eq(liveActivities.userId, req.user!.id)))
  res.json({ ok: true })
})

let processing = false
/** How many APNs requests are in flight at once, and how long one delivery run may take.
 *  A dead token costs a 10 s timeout; without these, a dozen of them would hold every
 *  other user's activity past its 120 s stale window (the ticker is skipped while a run
 *  is active). */
const DELIVERY_CONCURRENCY = 8
const DELIVERY_BUDGET_MS = 40_000

/** Run `task` over `items`, at most `limit` at a time, until the budget deadline passes;
 *  items left over are picked up by the next tick. */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  deadline: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length && Date.now() < deadline) {
      const item = items[next++]!
      try {
        await task(item)
      } catch {
        /* a failed item never stops the others */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Tasks already started on a device, by user/canvas: a task is announced once per run. */
const announced = new Map<string, number>()
export function resetLiveActivityStarts() {
  announced.clear()
}

/** Polls the in-memory task log, not the model provider. Coalesces updates and survives app suspension. */
export async function deliverLiveActivities(send = sendLiveActivityPush) {
  if (processing || !apnsConfigured()) return
  processing = true
  const deadline = Date.now() + DELIVERY_BUDGET_MS
  try {
    await startLiveActivities(send, deadline)
    await db.delete(liveActivities).where(lt(liveActivities.expiresAt, Date.now()))
    const rows = await db.select().from(liveActivities)
    await forEachBounded(rows, DELIVERY_CONCURRENCY, deadline, async (row) => {
      const canvas = store.getCanvas(row.canvasId)
      const permitted = canvas && hasDurableCanvasAccess(row.userId, canvas)
      const state = permitted ? agentActivityState(canvas.name, getTasks(canvas.id)) : null
      const ended = !state || (state.phase !== 'working' && state.phase !== 'queued')
      // Revocations send no private canvas/task content; then discard the token.
      const content = state ?? {
        canvasName: 'Doop',
        agentName: 'Doop',
        status: 'Activity ended',
        phase: 'finished',
        activeCount: 0,
        startedAt: 0,
      }
      const serialized = JSON.stringify(content)
      // Refresh before stale-date even when a long-running task keeps the same narration.
      const now = Math.floor(Date.now() / 1000)
      if (row.lastPayload === serialized && now - row.lastTimestamp < 60) return
      const timestamp = Math.max(now, row.lastTimestamp + 1)
      const aps = {
        timestamp,
        event: ended ? 'end' : 'update',
        'content-state': content,
        'stale-date': now + 120,
        ...(ended ? { 'dismissal-date': permitted ? now + 60 : now } : {}),
      }
      try {
        const status = await send(row.token, row.environment, { aps })
        console.log(`[live-activities] ${aps.event} push for ${row.id} -> ${status} (${content.phase})`)
        if (status === 410 || status === 400 || (status === 200 && ended)) {
          await db.delete(liveActivities).where(eq(liveActivities.id, row.id))
        } else if (status === 200) {
          await db
            .update(liveActivities)
            .set({ lastPayload: serialized, lastTimestamp: timestamp })
            .where(eq(liveActivities.id, row.id))
        }
        // Transient errors retain the row; the next tick retries. Never log the token.
      } catch (err) {
        /* APNs/network failure must not affect canvas mutations; the row stays for the next tick. */
        console.log(`[live-activities] ${aps.event} push for ${row.id} failed (${content.phase}): ${describe(err)}`)
      }
    })
  } finally {
    processing = false
  }
}

/** Error text for the delivery log: message only, never a token or payload. */
function describe(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

/** Open an activity on every registered device for each agent task that just
 *  began on a canvas its user belongs to, unless that device already reports
 *  an activity for the canvas. The start push carries the first content state;
 *  the app then registers the activity's update token like any other. */
async function startLiveActivities(send: typeof sendLiveActivityPush, deadline: number) {
  await db.delete(liveActivityStarters).where(lt(liveActivityStarters.expiresAt, Date.now()))
  const starters = await db.select().from(liveActivityStarters)
  if (starters.length === 0) return
  const covered = new Set(
    (await db.select({ userId: liveActivities.userId, canvasId: liveActivities.canvasId }).from(liveActivities)).map(
      (row) => `${row.userId}/${row.canvasId}`,
    ),
  )
  const canvases = store.allCanvases()
  const now = Math.floor(Date.now() / 1000)
  await forEachBounded(starters, DELIVERY_CONCURRENCY, deadline, async (device) => {
    for (const canvas of canvases) {
      if (!hasDurableCanvasAccess(device.userId, canvas)) continue
      const state = agentActivityState(canvas.name, getTasks(canvas.id))
      if (!state || (state.phase !== 'working' && state.phase !== 'queued')) continue
      const key = `${device.userId}/${canvas.id}`
      if (covered.has(key) || announced.get(`${device.token}/${canvas.id}`) === state.startedAt) continue
      const aps = {
        timestamp: now,
        event: 'start',
        'content-state': state,
        'attributes-type': 'AgentActivityAttributes',
        attributes: { canvasID: canvas.id, serverOrigin: device.origin },
        alert: { title: state.canvasName, body: `${state.agentName}: ${state.status}` },
        // The first update can only follow once the woken app has registered the
        // activity's token, which takes a minute or two on a sleeping phone.
        'stale-date': now + 300,
      }
      try {
        const status = await send(device.token, device.environment, { aps }, 10)
        console.log(`[live-activities] start push for canvas ${canvas.id} -> ${status} (${state.phase})`)
        if (status === 200) announced.set(`${device.token}/${canvas.id}`, state.startedAt)
        else if (status === 410 || status === 400) {
          await db.delete(liveActivityStarters).where(eq(liveActivityStarters.token, device.token))
          break
        }
      } catch (err) {
        /* retried on the next tick */
        console.log(`[live-activities] start push for canvas ${canvas.id} failed (${state.phase}): ${describe(err)}`)
      }
    }
  })
}

export function startLiveActivityDelivery() {
  if (!apnsConfigured()) return
  setInterval(() => {
    void deliverLiveActivities().catch(() => console.error('[live-activities] delivery failed'))
  }, 15_000).unref()
}
