import express from 'express'
import { and, desc, eq, inArray, isNotNull, lte, ne } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import { automationApprovals, automationRuns, automations, tasks } from './db/schema.ts'
import { store } from './store.ts'
import * as actions from './actions.ts'
import * as allowance from './allowance.ts'
import * as meta from './meta.ts'
import { AutomationPullError, extensions } from './extensions.ts'
import { hasDurableCanvasAccess } from './access.ts'
import { getUserName, isBanned } from './auth.ts'
import { roleName } from '../shared/agents.ts'
import type { AgentTask } from '../shared/types.ts'
import { env } from './env.ts'
import {
  MAX_NAME,
  incompleteReason,
  nextRunAt,
  normalizeSchedule,
  normalizeSteps,
  normalizeTrigger,
  type ApprovedSource,
  type AutomationRunState,
  type Automation,
  type AutomationRun,
  type Step,
} from '../shared/automations.ts'

/** Workflows share one durable runner for schedules and design approvals.
 * Approval receipts prevent duplicate dispatch after restarts or log pruning.
 * Agent steps wait for their board card; delivery steps receive source/result links. */

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
    trigger: row.trigger,
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
function scheduleNext(
  row: Pick<AutomationRow, 'enabled' | 'schedule' | 'steps' | 'trigger'>,
  after = Date.now(),
): number | null {
  if (!row.enabled || row.trigger.type === 'approval' || incompleteReason(row.steps, row.trigger)) return null
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
  trigger?: unknown
}

function parseInput(
  body: AutomationInput,
  ownerId: string,
  current?: AutomationRow,
): Pick<AutomationRow, 'name' | 'enabled' | 'schedule' | 'steps' | 'trigger'> | string {
  const name =
    body.name === undefined ? (current?.name ?? 'Untitled automation') : String(body.name).trim().slice(0, MAX_NAME)
  if (!name) return 'name is required'
  const enabled = body.enabled === undefined ? (current?.enabled ?? true) : !!body.enabled
  const trigger =
    body.trigger === undefined ? (current?.trigger ?? { type: 'schedule' as const }) : normalizeTrigger(body.trigger)
  if (typeof trigger === 'string') return trigger
  if (trigger.type === 'approval' && trigger.canvasId) {
    const canvas = store.getCanvas(trigger.canvasId)
    if (!canvas || !hasDurableCanvasAccess(ownerId, canvas)) return 'the approval canvas is not yours'
  }
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
  if (trigger.type === 'approval' && steps.some((s) => s.canvasId && s.canvasId !== trigger.canvasId))
    return 'Approval workflow steps must use the watched canvas'
  return { name, enabled, schedule, steps, trigger }
}

export async function createAutomation(ownerId: string, body: AutomationInput): Promise<Automation | string> {
  const parsed = parseInput(body, ownerId)
  if (typeof parsed === 'string') return parsed
  const now = Date.now()
  const row: AutomationRow = {
    id: nanoid(8),
    ownerId,
    ...parsed,
    approvalSince: now,
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
    if (body.trigger !== undefined) patch.trigger = parsed.trigger
    if (
      JSON.stringify(current.trigger) !== JSON.stringify(parsed.trigger) ||
      (!current.enabled && parsed.enabled) ||
      (incompleteReason(current.steps, current.trigger) && !incompleteReason(parsed.steps, parsed.trigger))
    )
      patch.approvalSince = now
    const [row] = await tx.update(automations).set(patch).where(eq(automations.id, id)).returning()
    return row
  })
  if (!out || typeof out === 'string') return out
  const last = await lastRuns([id])
  return toAutomation(out, last.get(id))
}

export async function deleteAutomation(ownerId: string, id: string): Promise<boolean> {
  const canceled = await db.transaction(async (tx) => {
    const gone = await tx
      .delete(automations)
      .where(and(eq(automations.id, id), eq(automations.ownerId, ownerId)))
      .returning({ id: automations.id })
    if (!gone.length) return undefined
    // This update serializes with queueAgent's task commit, so even a task
    // dispatched concurrently with deletion is included in cancellation.
    const active = await tx
      .update(automationRuns)
      .set({ status: 'failed', endedAt: Date.now() })
      .where(and(eq(automationRuns.automationId, id), eq(automationRuns.status, 'running')))
      .returning()
    await tx.delete(automationRuns).where(eq(automationRuns.automationId, id))
    await tx.delete(automationApprovals).where(eq(automationApprovals.automationId, id))
    return active
  })
  if (!canceled) return false
  for (const run of canceled) {
    const step = run.state?.steps[run.state.stepIndex]
    if (step && run.state?.taskId) actions.failCard(step.canvasId, run.state.taskId, 'The automation was deleted')
  }
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

const canvasUrl = (id: string) => `${env.BETTER_AUTH_URL}/c/${encodeURIComponent(id)}`
const frameUrl = (canvasId: string, id: string) => `${canvasUrl(canvasId)}?frame=${encodeURIComponent(id)}`

function sourceIsCurrent(source: ApprovedSource): boolean {
  const frame = store.getFrame(source.id)
  return (
    frame?.canvasId === source.canvasId &&
    frame.approval?.status === 'ready_for_dev' &&
    frame.approval.approvedAt === source.approval.approvedAt &&
    frame.approval.approvedFrameUpdatedAt === source.approval.approvedFrameUpdatedAt
  )
}

function runContext(state: AutomationRunState, canvasId: string): string {
  return [
    state.sources.length ? 'Approved designs:' : 'Design canvas:',
    ...state.sources.map(
      (s) =>
        `${s.name.slice(0, 100)} — approved by ${s.approval.approvedBy.slice(0, 100)}\n${frameUrl(s.canvasId, s.id)}`,
    ),
    canvasUrl(canvasId),
    ...(state.links.length ? ['Workflow results:', ...state.links] : []),
  ].join('\n')
}

/** Commit the task and the run's wait point together, before waking the agent. */
async function queueAgent(
  row: AutomationRow,
  run: RunRow,
  state: AutomationRunState,
  step: Extract<Step, { type: 'agent' }>,
) {
  const gate = await allowance.consumeResidentTask(row.ownerId)
  if (!gate.ok) throw new StepError('no model account connected — the Doop Agent has nothing to run on')
  let committed = false
  try {
    const sourceBrief = state.sources.length
      ? [
          'Approved original source frames (IDs):',
          ...state.sources.map((s) => `${s.id} (approved revision ${s.approval.approvedFrameUpdatedAt})`),
          'Read each original with inspect_frame and get_frame_html first. If its approval is no longer ready_for_dev, stop. Keep approved originals untouched. Create new draft frames; do not approve generated designs.',
          '',
        ].join('\n')
      : ''
    const earlierResults =
      state.summaries.length || state.links.length
        ? [
            'Earlier steps in this workflow:',
            ...state.summaries,
            ...state.links,
            'Frame links above identify drafts produced or edited by earlier steps. Use these as inputs when the brief asks to extend, resize or localize earlier results. They are drafts and do not need approval to continue this workflow; only the original sources must remain approved.',
            '',
          ].join('\n')
        : ''
    const card: AgentTask = {
      id: nanoid(8),
      agentName: '',
      color: '#0177d3',
      status: `${sourceBrief}${earlierResults}${step.prompt}`,
      startedAt: Date.now(),
      queuedBy: `Automation · ${row.name}`,
      queuedByUserId: row.ownerId,
      pipeline: step.roles,
      stage: 0,
    }
    state.taskId = card.id
    state.dispatching = false
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(automationRuns)
        .set({ state, summary: `Working on ${step.title || 'agent task'}` })
        .where(
          and(
            eq(automationRuns.id, run.id),
            eq(automationRuns.status, 'running'),
            eq(automationRuns.leaseUntil, run.leaseUntil),
          ),
        )
        .returning({ id: automationRuns.id })
      if (!updated.length) throw new StepError('The automation was stopped')
      await tx.insert(tasks).values({
        id: card.id,
        canvasId: step.canvasId,
        agentName: card.agentName,
        color: card.color,
        status: card.status,
        startedAt: card.startedAt,
        queuedBy: card.queuedBy,
        queuedByUserId: row.ownerId,
        pipeline: step.roles.join(','),
        stage: 0,
      })
    })
    committed = true
    actions.publishQueuedCard(step.canvasId, card)
    const { onFeedback } = await import('./resident.ts')
    onFeedback(step.canvasId)
  } finally {
    if (!committed) await allowance.refundResidentTask(gate, row.ownerId)
  }
}

/** Advance one durable step. Leases serialize workers; interrupted external calls
 * fail visibly instead of replaying a possibly successful message or ticket. */
export async function advanceRun(id: string): Promise<void> {
  if (running.has(id)) return
  running.add(id)
  let run: RunRow | undefined
  try {
    ;[run] = await db
      .update(automationRuns)
      .set({ leaseUntil: Date.now() + 300_000 })
      .where(
        and(
          eq(automationRuns.id, id),
          eq(automationRuns.status, 'running'),
          lte(automationRuns.leaseUntil, Date.now()),
        ),
      )
      .returning()
    if (!run?.state) return
    const state = run.state
    const save = async (patch: Partial<RunRow>) => {
      const updated = await db
        .update(automationRuns)
        .set(patch)
        .where(
          and(
            eq(automationRuns.id, id),
            eq(automationRuns.status, 'running'),
            eq(automationRuns.leaseUntil, run!.leaseUntil),
          ),
        )
        .returning({ id: automationRuns.id })
      return updated.length > 0
    }
    try {
      const [row] = await db.select().from(automations).where(eq(automations.id, run.automationId))
      if (!row || !row.enabled) throw new StepError('The automation was turned off or deleted')
      if (await isBanned(row.ownerId)) throw new StepError('The automation owner’s account is suspended')
      const incomplete = incompleteReason(state.steps)
      if (incomplete) throw new StepError(incomplete)
      const bad = checkCanvases(row.ownerId, state.steps)
      if (bad) throw new StepError(bad)
      if (!state.sources.every(sourceIsCurrent))
        throw new StepError('An approved source changed or returned to draft. Review and approve it again.')
      if (state.dispatching)
        throw new StepError(
          'This step was interrupted. Check its destination before starting a new run; it may already have completed.',
        )
      const step = state.steps[state.stepIndex]
      if (!step) {
        await save({ status: 'ok', endedAt: Date.now(), summary: state.summaries.join(' · '), leaseUntil: 0 })
        return
      }
      if (state.taskId) {
        const [task] = await db.select().from(tasks).where(eq(tasks.id, state.taskId))
        if (!task) throw new StepError('The workflow task was removed')
        if (task.failedAt) throw new StepError(task.failureReason || 'The design task failed')
        if (!task.endedAt) {
          if (Date.now() - task.startedAt > 60 * 60_000) throw new StepError('The design task timed out after one hour')
          return
        }
        state.summaries.push(
          `Completed ${step.type === 'agent' ? step.title || roleName(step.roles[0]) : 'design task'}`,
        )
        for (const frameId of (task.frameIds ?? '').split(',').filter(Boolean)) {
          if (store.getFrame(frameId)?.canvasId === step.canvasId && state.links.length < 30)
            state.links.push(frameUrl(step.canvasId, frameId))
        }
        delete state.taskId
      } else {
        state.dispatching = true
        if (!(await save({ state }))) throw new StepError('The automation was stopped before dispatch')
        if (step.type === 'agent') {
          await queueAgent(row, run, state, step)
          return
        }
        if (step.type === 'pull') {
          state.summaries.push(
            await runPull(row, step, `${(await getUserName(row.ownerId)) ?? 'Automation'} · ${row.name}`),
          )
        } else {
          const extension = extensions.find((e) => e.id === step.type)
          if (!extension?.runAutomationAction) throw new StepError(`No integration handles ${step.type}`)
          const result = await extension.runAutomationAction(step, {
            ownerId: row.ownerId,
            context: runContext(state, step.canvasId),
          })
          state.summaries.push(result.summary)
          if (result.url) state.links.push(result.url)
        }
        state.dispatching = false
      }
      state.stepIndex++
      const done = state.stepIndex >= state.steps.length
      await save({
        state,
        summary: state.summaries.join(' · '),
        status: done ? 'ok' : 'running',
        endedAt: done ? Date.now() : null,
      })
      if (done) await pruneRuns(row.id)
    } catch (error) {
      if (state.taskId) {
        const step = state.steps[state.stepIndex]
        if (step) actions.failCard(step.canvasId, state.taskId, 'The automation stopped')
      }
      await save({
        status: 'failed',
        endedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        failure: error instanceof StepError || error instanceof AutomationPullError ? (error.failure ?? null) : null,
      })
      await pruneRuns(run.automationId)
    }
  } finally {
    if (run)
      await db
        .update(automationRuns)
        .set({ leaseUntil: 0 })
        .where(and(eq(automationRuns.id, id), eq(automationRuns.leaseUntil, run.leaseUntil)))
    running.delete(id)
  }
}

/** Approval runs claim durable receipts under the automation lock. Scheduled and
 * manual runs share the same execution path and wait for agent results. */
export async function runAutomation(
  id: string,
  opts: { scheduled?: boolean; approved?: boolean } = {},
): Promise<AutomationRun | undefined> {
  const run = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(automations).where(eq(automations.id, id)).for('update')
    if (!row || !row.enabled) return undefined
    const active = await tx
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, id), eq(automationRuns.status, 'running')))
      .limit(1)
    if (active.length) return undefined
    if (opts.scheduled && row.trigger.type !== 'schedule') return undefined
    const sources: ApprovedSource[] = []
    if (row.trigger.type === 'approval') {
      if (incompleteReason(row.steps, row.trigger)) return undefined
      const canvas = store.getCanvas(row.trigger.canvasId)
      if (!canvas || !hasDurableCanvasAccess(row.ownerId, canvas)) return undefined
      const receipts = await tx
        .select({ frameId: automationApprovals.frameId, approvedAt: automationApprovals.approvedAt })
        .from(automationApprovals)
        .where(eq(automationApprovals.automationId, id))
      const handled = new Set(receipts.map((receipt) => `${receipt.frameId}:${receipt.approvedAt}`))
      for (const frame of canvas.frames) {
        if (
          frame.approval?.status !== 'ready_for_dev' ||
          (opts.approved && frame.approval.approvedAt < row.approvalSince)
        )
          continue
        if (handled.has(`${frame.id}:${frame.approval.approvedAt}`)) continue
        const source: ApprovedSource = {
          id: frame.id,
          canvasId: frame.canvasId,
          name: frame.name,
          approval: { ...frame.approval },
        }
        const inserted = await tx
          .insert(automationApprovals)
          .values({ automationId: id, frameId: source.id, approvedAt: source.approval.approvedAt })
          .onConflictDoNothing()
          .returning()
        if (inserted.length) sources.push(source)
        if (sources.length >= 10) break
      }
      if (!sources.length) return undefined
    } else if (opts.approved) return undefined
    const state: AutomationRunState = { steps: row.steps, sources, stepIndex: 0, summaries: [], links: [] }
    const [created] = await tx
      .insert(automationRuns)
      .values({
        id: nanoid(8),
        automationId: id,
        startedAt: Date.now(),
        status: 'running',
        canvasId: row.steps[0]?.canvasId ?? null,
        state,
      })
      .returning()
    return created
  })
  if (!run) return undefined
  await advanceRun(run.id)
  const [updated] = await db.select().from(automationRuns).where(eq(automationRuns.id, run.id))
  return updated ? toRun(updated) : undefined
}

const WORKFLOW_CONCURRENCY = 4
const workflowJobs = new Map<string, Promise<void>>()
const workflowQueue: { id: string; run: () => Promise<void>; done: () => void }[] = []
let activeWorkflowJobs = 0

/** A process-wide bounded queue, with one job per automation. Discovery can run
 * again while an integration is awaiting I/O; fast workflows keep progressing. */
function pumpWorkflows(): void {
  while (activeWorkflowJobs < WORKFLOW_CONCURRENCY && workflowQueue.length) {
    const job = workflowQueue.shift()!
    activeWorkflowJobs++
    void job
      .run()
      .catch((error) => console.error('[automations] workflow job failed', job.id, error))
      .finally(() => {
        activeWorkflowJobs--
        workflowJobs.delete(job.id)
        job.done()
        pumpWorkflows()
      })
  }
}

function enqueueWorkflow(id: string): Promise<void> {
  const existing = workflowJobs.get(id)
  if (existing) return existing
  let done!: () => void
  const completion = new Promise<void>((resolve) => {
    done = resolve
  })
  workflowJobs.set(id, completion)
  workflowQueue.push({
    id,
    done,
    run: async () => {
      const active = await db
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(and(eq(automationRuns.automationId, id), eq(automationRuns.status, 'running')))
      for (const run of active) await advanceRun(run.id)
      await runAutomation(id, { approved: true })
    },
  })
  pumpWorkflows()
  return completion
}

export async function tickWorkflows(): Promise<void> {
  const [active, enabled] = await Promise.all([
    db.select({ id: automationRuns.automationId }).from(automationRuns).where(eq(automationRuns.status, 'running')),
    db
      .select({ id: automations.id, trigger: automations.trigger })
      .from(automations)
      .where(eq(automations.enabled, true)),
  ])
  const ids = new Set([
    ...active.map((run) => run.id),
    ...enabled.filter((row) => row.trigger.type === 'approval').map((row) => row.id),
  ])
  await Promise.all([...ids].map(enqueueWorkflow))
}

async function pruneRuns(automationId: string): Promise<void> {
  const rows = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(and(eq(automationRuns.automationId, automationId), ne(automationRuns.status, 'running')))
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
    if (claimed.length === 0) continue
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
  void tickWorkflows().catch((err) => console.error('[automations] workflow tick failed', err))
  const workTimer = setInterval(() => {
    void tickWorkflows().catch((err) => console.error('[automations] workflow tick failed', err))
  }, 5_000)
  workTimer.unref()
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

/* Run now starts unprocessed approvals or a scheduled workflow. Long-running
   tasks continue in the worker; the response is the current run state. */
automationsRouter.post('/:id/run', async (req, res) => {
  const row = await getRow(req.user!.id, req.params.id)
  if (!row) return res.status(404).json({ error: 'not found' })
  if (!row.enabled) return res.status(400).json({ error: 'Turn the automation on before running it' })
  const run = await runAutomation(row.id)
  if (!run)
    return res
      .status(409)
      .json({ error: 'Already running, or no unprocessed approved designs. New approvals run automatically.' })
  res.json(run)
})
