import express from 'express'
import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import { automationRuns, automations } from './db/schema.ts'
import { store } from './store.ts'
import * as actions from './actions.ts'
import * as allowance from './allowance.ts'
import * as meta from './meta.ts'
import { hasDurableCanvasAccess } from './access.ts'
import { getUserName } from './auth.ts'
import { roleName } from '../shared/agents.ts'
import {
  MAX_NAME,
  incompleteReason,
  nextRunAt,
  normalizeSchedule,
  normalizeSteps,
  type Automation,
  type AutomationRun,
  type Step,
} from '../shared/automations.ts'

/**
 * Automations: scheduled workflows of pull and agent-task steps (see
 * shared/automations.ts for the model). This module owns the rows, the
 * REST surface under /api/automations, running one automation end to end,
 * and the scheduler tick that fires due ones.
 *
 * A run walks the steps in order. A pull step lands frames on its canvas
 * right away. An agent step queues a board card for the resident team on
 * its canvas, billed to the automation's owner exactly like a card they
 * would write on the Board — the run is "ok" once the card is queued; the
 * agent's own progress shows on that canvas. Concurrency is one run per
 * automation; a tick that finds one still running leaves it alone.
 */

type AutomationRow = typeof automations.$inferSelect
type RunRow = typeof automationRuns.$inferSelect

const TICK_MS = 60_000
const RUNS_PAGE = 20
/** the number of runs kept per automation; older ones are pruned on write */
const RUNS_KEEP = 100

/* ------------------------------------------------------------------ */
/* Rows                                                                */

function toRun(row: RunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automationId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    status: row.status as AutomationRun['status'],
    summary: row.summary,
    error: row.error,
    canvasId: row.canvasId,
    failure: row.failure === 'reconnect' ? 'reconnect' : null,
  }
}

async function lastRuns(ids: string[]): Promise<Map<string, RunRow>> {
  const out = new Map<string, RunRow>()
  if (ids.length === 0) return out
  const rows = await db
    .select()
    .from(automationRuns)
    .where(inArray(automationRuns.automationId, ids))
    .orderBy(desc(automationRuns.startedAt))
  for (const r of rows) if (!out.has(r.automationId)) out.set(r.automationId, r)
  return out
}

function toAutomation(row: AutomationRow, last: RunRow | undefined): Automation {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    schedule: row.schedule,
    steps: row.steps,
    nextRunAt: row.nextRunAt,
    lastRun: last
      ? {
          id: last.id,
          startedAt: last.startedAt,
          status: last.status as AutomationRun['status'],
          summary: last.summary,
          failure: last.failure === 'reconnect' ? 'reconnect' : null,
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function listAutomations(ownerId: string): Promise<Automation[]> {
  const rows = await db
    .select()
    .from(automations)
    .where(eq(automations.ownerId, ownerId))
    .orderBy(desc(automations.updatedAt))
  const last = await lastRuns(rows.map((r) => r.id))
  return rows.map((r) => toAutomation(r, last.get(r.id)))
}

async function getRow(ownerId: string, id: string): Promise<AutomationRow | undefined> {
  const [row] = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, id), eq(automations.ownerId, ownerId)))
  return row ?? undefined
}

export async function getAutomation(ownerId: string, id: string): Promise<Automation | undefined> {
  const row = await getRow(ownerId, id)
  if (!row) return undefined
  const last = await lastRuns([row.id])
  return toAutomation(row, last.get(row.id))
}

/** When the scheduler should fire this row next — null while it can't run. */
function scheduleNext(row: Pick<AutomationRow, 'enabled' | 'schedule' | 'steps'>, after = Date.now()): number | null {
  if (!row.enabled || incompleteReason(row.steps)) return null
  return nextRunAt(row.schedule, after)
}

/** Every step's canvas must be one the owner durably reaches — a share-link
 *  visit is not a place to park an automation that outlives the visit. */
function checkCanvases(ownerId: string, steps: Step[]): string | undefined {
  for (const s of steps) {
    if (!s.canvasId) continue
    const c = store.getCanvas(s.canvasId)
    if (!c || !hasDurableCanvasAccess(ownerId, c)) return 'one of the canvases is not yours'
  }
  return undefined
}

export interface AutomationInput {
  name?: unknown
  enabled?: unknown
  schedule?: unknown
  steps?: unknown
}

function parseInput(
  body: AutomationInput,
  ownerId: string,
  current?: AutomationRow,
): { name: string; enabled: boolean; schedule: AutomationRow['schedule']; steps: Step[] } | string {
  const name =
    body.name === undefined ? (current?.name ?? 'Untitled automation') : String(body.name).trim().slice(0, MAX_NAME)
  if (!name) return 'name is required'
  const enabled = body.enabled === undefined ? (current?.enabled ?? true) : !!body.enabled
  const schedule =
    body.schedule === undefined ? (current?.schedule ?? normalizeSchedule({})) : normalizeSchedule(body.schedule)
  let steps: Step[]
  if (body.steps === undefined) steps = current?.steps ?? []
  else {
    const parsed = normalizeSteps(body.steps)
    if (typeof parsed === 'string') return parsed
    steps = parsed
  }
  const bad = checkCanvases(ownerId, steps)
  if (bad) return bad
  return { name, enabled, schedule, steps }
}

export async function createAutomation(ownerId: string, body: AutomationInput): Promise<Automation | string> {
  const parsed = parseInput(body, ownerId)
  if (typeof parsed === 'string') return parsed
  const now = Date.now()
  const row: AutomationRow = {
    id: nanoid(8),
    ownerId,
    ...parsed,
    nextRunAt: scheduleNext(parsed, now),
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(automations).values(row)
  return toAutomation(row, undefined)
}

export async function updateAutomation(
  ownerId: string,
  id: string,
  body: AutomationInput,
): Promise<Automation | string | undefined> {
  /* read, merge and write under a row lock: the next run is derived from
     the row as it is AFTER this request, never from a copy another request
     may already have changed */
  const out = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.ownerId, ownerId)))
      .for('update')
    if (!current) return undefined
    const parsed = parseInput(body, ownerId, current)
    if (typeof parsed === 'string') return parsed
    const now = Date.now()
    /* write only what this request carries: a rename must not put another
       request's field back the way it was */
    const patch: Partial<AutomationRow> = { updatedAt: now, nextRunAt: scheduleNext(parsed, now) }
    if (body.name !== undefined) patch.name = parsed.name
    if (body.enabled !== undefined) patch.enabled = parsed.enabled
    if (body.schedule !== undefined) patch.schedule = parsed.schedule
    if (body.steps !== undefined) patch.steps = parsed.steps
    const [row] = await tx.update(automations).set(patch).where(eq(automations.id, id)).returning()
    return row
  })
  if (!out || typeof out === 'string') return out
  const last = await lastRuns([id])
  return toAutomation(out, last.get(id))
}

export async function deleteAutomation(ownerId: string, id: string): Promise<boolean> {
  const gone = await db
    .delete(automations)
    .where(and(eq(automations.id, id), eq(automations.ownerId, ownerId)))
    .returning({ id: automations.id })
  if (gone.length === 0) return false
  await db.delete(automationRuns).where(eq(automationRuns.automationId, id))
  return true
}

export async function listRuns(ownerId: string, id: string, before?: number): Promise<AutomationRun[] | undefined> {
  const row = await getRow(ownerId, id)
  if (!row) return undefined
  const rows = await db
    .select()
    .from(automationRuns)
    .where(
      before
        ? and(eq(automationRuns.automationId, id), lte(automationRuns.startedAt, before - 1))
        : eq(automationRuns.automationId, id),
    )
    .orderBy(desc(automationRuns.startedAt))
    .limit(RUNS_PAGE)
  return rows.map(toRun)
}

/* ------------------------------------------------------------------ */
/* Running                                                             */

const running = new Set<string>()

class StepError extends Error {
  failure: AutomationRun['failure']
  constructor(message: string, failure: AutomationRun['failure'] = null) {
    super(message)
    this.failure = failure
  }
}

async function runPull(row: AutomationRow, step: Extract<Step, { type: 'pull' }>, actorName: string): Promise<string> {
  const connection = await meta.getConnection(row.ownerId)
  if (!connection) throw new StepError('Meta is not connected', 'reconnect')
  try {
    const result = await meta.pullCreatives({
      connection,
      accountId: step.accountId,
      filter: step.filter,
      canvasId: step.canvasId,
      ownerId: row.ownerId,
      actor: actions.resolveActor({ name: actorName, kind: 'user' }),
    })
    const n = result.created.length
    const noun = n === 1 ? 'creative' : 'creatives'
    return result.skipped > 0 ? `${n} new ${noun} (${result.skipped} already here)` : `${n} ${noun} pulled`
  } catch (err) {
    if (err instanceof meta.MetaAuthError)
      throw new StepError(`Meta rejected the connection: ${err.message}`, 'reconnect')
    throw err
  }
}

async function runAgent(
  row: AutomationRow,
  step: Extract<Step, { type: 'agent' }>,
  actorName: string,
): Promise<string> {
  const gate = await allowance.consumeResidentTask(row.ownerId)
  if (!gate.ok) throw new StepError('no model account connected — the Doop Agent has nothing to run on')
  const card = actions.addQueuedCard(step.canvasId, step.prompt, actorName, step.roles, undefined, row.ownerId)
  if (!card) {
    await allowance.refundResidentTask(gate, row.ownerId)
    throw new StepError('canvas not found')
  }
  return `card queued for ${roleName(step.roles[0])}`
}

/** Run one automation now. The row is re-read here, not carried in from
 *  the caller: an automation deleted, disabled or edited since it was
 *  picked runs as it is now — or, once switched off or gone, not at all.
 *  Resolves to the run once every step has finished (or the first failing
 *  one has); undefined when there was nothing to run. */
export async function runAutomation(
  id: string,
  opts: { scheduled?: boolean } = {},
): Promise<AutomationRun | undefined> {
  if (running.has(id)) throw new Error('already running')
  running.add(id)
  const summaries: string[] = []
  let run: RunRow | undefined
  try {
    const [row] = await db.select().from(automations).where(eq(automations.id, id))
    if (!row || (opts.scheduled && !row.enabled)) return undefined
    run = {
      id: nanoid(8),
      automationId: row.id,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      summary: null,
      error: null,
      canvasId: row.steps[0]?.canvasId ?? null,
      failure: null,
    }
    await db.insert(automationRuns).values(run)
    try {
      const incomplete = incompleteReason(row.steps)
      if (incomplete) throw new StepError(incomplete)
      const bad = checkCanvases(row.ownerId, row.steps)
      if (bad) throw new StepError(bad)
      const actorName = `${(await getUserName(row.ownerId)) ?? 'Automation'} · ${row.name}`
      for (const step of row.steps) {
        summaries.push(
          step.type === 'pull' ? await runPull(row, step, actorName) : await runAgent(row, step, actorName),
        )
      }
      run.status = 'ok'
      run.summary = summaries.join(' · ')
    } catch (err) {
      run.status = 'failed'
      run.summary = summaries.length ? summaries.join(' · ') : null
      run.error = err instanceof Error ? err.message : String(err)
      run.failure = err instanceof StepError ? err.failure : null
    }
    run.endedAt = Date.now()
    await db.update(automationRuns).set(run).where(eq(automationRuns.id, run.id))
    void pruneRuns(row.id)
    return toRun(run)
  } finally {
    running.delete(id)
  }
}

async function pruneRuns(automationId: string): Promise<void> {
  const rows = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(desc(automationRuns.startedAt))
    .offset(RUNS_KEEP)
  if (rows.length > 0)
    await db.delete(automationRuns).where(
      inArray(
        automationRuns.id,
        rows.map((r) => r.id),
      ),
    )
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */

/** Fire every automation whose time has come. The claim is one conditional
 *  update — move `next_run_at` forward only if it still holds the value we
 *  read — so with several server replicas on one database exactly one of
 *  them runs each occurrence, and a crash mid-run costs that occurrence
 *  rather than leaving a stuck row. */
export async function tick(now = Date.now()): Promise<number> {
  const due = await db
    .select()
    .from(automations)
    .where(and(eq(automations.enabled, true), isNotNull(automations.nextRunAt), lte(automations.nextRunAt, now)))
  let fired = 0
  for (const row of due) {
    if (row.nextRunAt === null) continue
    const claimed = await db
      .update(automations)
      .set({ nextRunAt: scheduleNext(row, now) })
      .where(and(eq(automations.id, row.id), eq(automations.nextRunAt, row.nextRunAt)))
      .returning({ id: automations.id })
    if (claimed.length === 0 || running.has(row.id)) continue
    fired++
    runAutomation(row.id, { scheduled: true }).catch((err) => console.error('[automations] run failed', row.id, err))
  }
  return fired
}

let timer: NodeJS.Timeout | undefined

export function startScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    tick().catch((err) => console.error('[automations] tick failed', err))
  }, TICK_MS)
  timer.unref()
}

/* ------------------------------------------------------------------ */
/* REST                                                                */

export const automationsRouter = express.Router()

automationsRouter.get('/', async (req, res) => {
  res.json(await listAutomations(req.user!.id))
})

automationsRouter.post('/', async (req, res) => {
  const out = await createAutomation(req.user!.id, req.body ?? {})
  if (typeof out === 'string') return res.status(400).json({ error: out })
  res.json(out)
})

automationsRouter.get('/:id', async (req, res) => {
  const out = await getAutomation(req.user!.id, req.params.id)
  if (!out) return res.status(404).json({ error: 'not found' })
  res.json(out)
})

automationsRouter.patch('/:id', async (req, res) => {
  const out = await updateAutomation(req.user!.id, req.params.id, req.body ?? {})
  if (!out) return res.status(404).json({ error: 'not found' })
  if (typeof out === 'string') return res.status(400).json({ error: out })
  res.json(out)
})

automationsRouter.delete('/:id', async (req, res) => {
  if (!(await deleteAutomation(req.user!.id, req.params.id))) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
})

automationsRouter.get('/:id/runs', async (req, res) => {
  const before = Number(req.query.before) || undefined
  const out = await listRuns(req.user!.id, req.params.id, before)
  if (!out) return res.status(404).json({ error: 'not found' })
  res.json(out)
})

/* "Run now": the same run the schedule would start, on demand. Responds once
   the run has finished — a pull is seconds, an agent step only queues. */
automationsRouter.post('/:id/run', async (req, res) => {
  const row = await getRow(req.user!.id, req.params.id)
  if (!row) return res.status(404).json({ error: 'not found' })
  if (running.has(row.id)) return res.status(409).json({ error: 'already running' })
  const run = await runAutomation(row.id)
  if (!run) return res.status(404).json({ error: 'not found' })
  res.json(run)
})
