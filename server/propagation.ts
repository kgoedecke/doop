import type { Actor } from '../shared/types.ts'
import { FrameHtmlNotLoadedError, htmlLoaded } from './frameHtml.ts'
import { store } from './store.ts'
import { detached } from './journal.ts'
import { runOperation, WorkBudgetError } from './workBudget.ts'

/**
 * Component work across a canvas's frames, done in the background. A change to a
 * main (or a request to detach every instance of a component) names the components
 * it concerns and returns; the frames are visited later, ONE turn started per
 * event-loop tick, so no request ever rewrites a canvas synchronously. That
 * synchronous sweep blocked the server's one event loop for minutes on 2026-11-11.
 *
 * Work is kept per canvas and per frame: a frame waits once however many
 * components ask for it, so a burst of edits to one main (or a pull of fifty)
 * prepares each frame once. Canvases take turns, one frame each, so a large
 * canvas cannot starve the others.
 *
 * A turn is one frame of one canvas, and a canvas has at most one turn in flight.
 * On the local host a turn's write is done in the tick that starts it and only its
 * answer comes a few microtasks later. A host that answers asynchronously would make
 * a turn span ticks: meanwhile other canvases take their turns,
 * and requests write to the canvas as they always could (a write that lands under
 * a turn's preparation is caught by the turn, which asks to go again). A turn that
 * has not answered within `TURN_TIMEOUT_MS` is said as failed for its frame and the
 * canvas goes on; whatever it answers later is dropped. After a turn the job is
 * looked at again: a canvas deleted meanwhile, or a job that ended, takes nothing
 * from the answer, and nothing is reported for it.
 *
 * Which frames a task visits is its handler's `scope`. `loaded` (a changed main,
 * `propagate`): the frames whose HTML is in memory when the work is asked for,
 * and nothing is read or held for it. A frame at rest holds references to its
 * components, not their markup (server/frameRest.ts), so one that is not in
 * memory needs nothing: it is rendered from the component as it then is when its
 * page is read. `all` (`detach`, which writes real markup into every frame, and
 * `propagate` on a canvas whose frames live on an actor, rendered): the canvas is
 * loaded and held (store.load / store.hold) until its queue drains.
 *
 * What is done to a frame belongs to the task's handler (actions.ts registers
 * `propagate`, componentActions.ts `detach`); this file only decides which
 * frame is next and when. The server sends each frame's turn through the canvas
 * write entry (server/canvasWrites.ts routes both tasks with `routeFrameTask` as it
 * loads), so a frame's turn is a command like any other write. Where nothing has
 * routed a task (a test of the actions alone), its handler does the frame itself.
 */

export type FrameTask = 'detach' | 'propagate'

/* a frame both tasks wait on is detached first, so the propagation sees the result */
const TASK_ORDER: readonly FrameTask[] = ['detach', 'propagate']

export interface TouchedFrame {
  id: string
  name: string
  approvalLost: boolean
}

export interface FrameOutcome {
  /** the frame shows the change now: rendered again in memory, or rewritten where what it
   *  stores changed too */
  touched?: TouchedFrame
  /** something else wrote the frame while it was being prepared: nothing was written, try again */
  requeue?: boolean
  /** the frame cannot be worked on for now (an agent is streaming into it): the request is
   *  kept, outside the queue, until `resumeFrame` says the frame is free again */
  defer?: boolean
  /** what the task counts (instances detached) */
  count?: number
}

export interface DrainReport {
  /** ids of the components the work was for, in the order they were asked for */
  components: string[]
  frames: TouchedFrame[]
  count: number
}

export interface FrameTaskHandler {
  /** The frames the task visits on this canvas: every one (the canvas is loaded and held
   *  for it), or the ones in memory when it is asked for. Every one, when absent. */
  scope?(canvasId: string): 'all' | 'loaded'
  /** Do the task on one frame: the read and the write share a step. */
  frame: FrameRunner
  /** The canvas has no frame left waiting for this task. */
  drained(canvasId: string, report: DrainReport, actor: Actor): void
}

interface TaskState {
  /** frames still to visit, each with the components asking for it */
  todo: Map<string, Set<string>>
  attempts: Map<string, number>
  components: Set<string>
  touched: Map<string, TouchedFrame>
  count: number
  actor: Actor
}

interface Job {
  canvasId: string
  tasks: Map<FrameTask, TaskState>
  /** lets the canvas go again, once a task that works on all of it has taken hold of it */
  release?: () => void
  /** set while frame HTML the job needs is being read: it takes no turn until then */
  loading: boolean
  waiters: ((reports: DrainReports) => void)[]
  /** what tasks that have already drained reported, for whoever waits on the canvas */
  reports: DrainReports
  /** a turn of this canvas is in flight: its next waits for it, other canvases do not */
  busy: boolean
}

export type DrainReports = Partial<Record<FrameTask, DrainReport>>

/** One frame's turn of a task: its outcome, now or once the write that does it answers. */
export type FrameRunner = (
  canvasId: string,
  frameId: string,
  componentIds: string[],
  actor: Actor,
) => FrameOutcome | Promise<FrameOutcome>

/** A frame changed under its preparation this many times in a row: left for its own next write. */
const MAX_ATTEMPTS = 5

/** How long a turn may go unanswered before it is said as failed for its frame and its canvas
 *  goes on: far past any local write, which answers within microtasks of its tick. */
const TURN_TIMEOUT_MS = 30_000
let turnTimeoutMs = TURN_TIMEOUT_MS

/** For tests: how long a turn may go unanswered; returns the setting it replaced. */
export function setTurnTimeout(ms: number): number {
  const was = turnTimeoutMs
  turnTimeoutMs = ms
  return was
}

const handlers = new Map<FrameTask, FrameTaskHandler>()
/** who does a frame's turn of a task in place of its handler: the canvas write entry */
const routes = new Map<FrameTask, FrameRunner>()
const jobs = new Map<string, Job>()

/** Work a frame is owed once it is free: asked for while an agent was streaming into it.
 *  Kept apart from the jobs, so a canvas with nothing else to do is idle (and let go) while
 *  the stream stays open, and no tick is spent asking whether it has closed. */
interface Deferred {
  canvasId: string
  tasks: Map<FrameTask, { componentIds: Set<string>; actor: Actor }>
}
const deferred = new Map<string, Deferred>()
/** the canvases taking turns, next first */
const ring: string[] = []
let scheduled = false
let idleWaiters: (() => void)[] = []

export function registerFrameTask(task: FrameTask, handler: FrameTaskHandler) {
  handlers.set(task, handler)
}

/** Send each frame's turn of `task` through `run` (the canvas write entry) instead of the
 *  handler's own `frame`; which frames, and what is said when they are done, stay the handler's. */
export function routeFrameTask(task: FrameTask, run: FrameRunner): FrameRunner | undefined {
  const was = routes.get(task)
  routes.set(task, run)
  return was
}

function jobFor(canvasId: string): Job {
  const existing = jobs.get(canvasId)
  if (existing) return existing
  const job: Job = { canvasId, tasks: new Map(), loading: false, waiters: [], reports: {}, busy: false }
  jobs.set(canvasId, job)
  ring.push(canvasId)
  return job
}

/** May the job take its turn? Not while a read it waits on is in flight, and a job that
 *  works on the whole canvas never reads a frame of one that is not loaded. */
function ready(job: Job): boolean {
  if (job.loading) return false
  if (!job.release || store.isLoaded(job.canvasId)) return true
  /* a canvas that could not be read has nothing a job may touch */
  read(job, () => store.load(job.canvasId), true)
  return false
}

function read(job: Job, load: () => Promise<unknown>, whole: boolean) {
  job.loading = true
  load()
    .catch((error: unknown) => console.error('[propagation] reading frames failed', job.canvasId, error))
    .finally(() => {
      job.loading = false
      if (whole && !store.isLoaded(job.canvasId)) finish(job)
      schedule()
    })
}

/**
 * Ask for `task` on the frames of the canvas its handler's scope takes in, for these
 * components. Returns at once: nothing is read or written here. `exceptFrameId` is the
 * frame whose own write caused this, which is already up to date.
 */
export function enqueue(
  task: FrameTask,
  canvasId: string,
  componentIds: string[],
  actor: Actor,
  options: { exceptFrameId?: string; onlyFrameIds?: readonly string[] } = {},
) {
  const canvas = store.getCanvas(canvasId)
  if (!canvas || !componentIds.length) return
  const whole = (handlers.get(task)?.scope?.(canvasId) ?? 'all') === 'all'
  const job = jobFor(canvasId)
  if (whole) job.release ??= store.hold(canvasId)
  let state = job.tasks.get(task)
  if (!state) {
    state = { todo: new Map(), attempts: new Map(), components: new Set(), touched: new Map(), count: 0, actor }
    job.tasks.set(task, state)
  }
  state.actor = actor
  for (const id of componentIds) state.components.add(id)
  for (const frame of canvas.frames) {
    if (frame.id === options.exceptFrameId) continue
    if (options.onlyFrameIds && !options.onlyFrameIds.includes(frame.id)) continue
    /* not in memory: it is rendered from its components as they are when its page is read */
    if (!whole && !htmlLoaded(frame)) continue
    const waiting = state.todo.get(frame.id)
    if (waiting) for (const id of componentIds) waiting.add(id)
    else state.todo.set(frame.id, new Set(componentIds))
  }
  schedule()
}

function schedule() {
  if (scheduled || !ring.length) return
  scheduled = true
  /* detached: a tick is scheduled from inside whatever asked for work, and must never
     join that request's write boundary (server/journal.ts). A tick never rejects: a frame's
     failure is said and skipped (`guarded`), and anything past that is said here */
  setImmediate(() => detached(tick))
}

/** One tick: the next canvas that can work starts a turn, one frame. A canvas whose turn is
 *  still in flight is passed over; its turn schedules the next tick when it ends. */
function tick() {
  scheduled = false
  /* canvases still being read are passed over; when none can work, their load reschedules */
  for (const canvasId of [...ring]) {
    const job = jobs.get(canvasId)
    if (!job || job.busy) continue
    ring.splice(ring.indexOf(canvasId), 1)
    ring.push(canvasId)
    if (!store.getCanvas(canvasId)) {
      finish(job)
      continue
    }
    if (!ready(job)) continue
    job.busy = true
    step(job)
      .catch((error: unknown) => console.error('[propagation] a turn of the queue failed', canvasId, error))
      .finally(() => {
        job.busy = false
        schedule()
      })
    /* another canvas may start its turn on the next tick, whether or not this one has answered */
    schedule()
    return
  }
}

/** The job a turn was for is over: its canvas was deleted, or it was finished meanwhile. */
function gone(job: Job): boolean {
  if (jobs.get(job.canvasId) !== job) return true
  if (store.getCanvas(job.canvasId)) return false
  finish(job)
  return true
}

function nextWork(job: Job): { task: FrameTask; state: TaskState } | undefined {
  for (const task of TASK_ORDER) {
    const state = job.tasks.get(task)
    if (state) return { task, state }
  }
  return undefined
}

async function step(job: Job) {
  const work = nextWork(job)
  if (!work) return finish(job)
  const { task, state } = work
  const [frameId, componentIds] = state.todo.entries().next().value ?? []
  if (frameId && componentIds) {
    state.todo.delete(frameId)
    await visit(job, task, state, frameId, [...componentIds])
    /* nothing of the answer is kept for a canvas or a job that is no more: no report, no line */
    if (gone(job)) return
  }
  if (state.todo.size) return
  job.tasks.delete(task)
  const report: DrainReport = {
    components: [...state.components],
    frames: [...state.touched.values()],
    count: state.count,
  }
  job.reports[task] = merged(job.reports[task], report)
  guarded(`${task} drained`, job.canvasId, () => handlers.get(task)?.drained(job.canvasId, report, state.actor))
  if (!job.tasks.size) finish(job)
}

async function visit(job: Job, task: FrameTask, state: TaskState, frameId: string, componentIds: string[]) {
  /* its own operation: one frame's worth of budget, a name the stall watchdog can report,
     and one write boundary, so a frame is brought up to date whole or left as it was */
  let unread = false
  const run = routes.get(task) ?? handlers.get(task)?.frame
  const outcome = await guardedLater(`${task} of frame ${frameId}`, job.canvasId, async () => {
    try {
      return await answered(
        Promise.resolve(
          runOperation(`queue ${task} frame ${frameId}`, job.canvasId, () =>
            run?.(job.canvasId, frameId, componentIds, state.actor),
          ),
        ),
      )
    } catch (error) {
      if (!(error instanceof FrameHtmlNotLoadedError)) throw error
      unread = true
      return undefined
    }
  })
  if (gone(job)) return
  /* the frame's write reads a frame that is not in memory (a main it holds a copy of): read
     what a write to it may read, then its turn comes again */
  if (unread) {
    if (!again(state, frameId, componentIds)) return
    return read(job, () => store.loadForFrames(job.canvasId, [frameId]), false)
  }
  if (!outcome) return
  if (outcome.defer) return defer(job.canvasId, task, frameId, componentIds, state.actor)
  if (outcome.count) state.count += outcome.count
  if (outcome.touched) {
    const before = state.touched.get(frameId)
    state.touched.set(frameId, {
      ...outcome.touched,
      approvalLost: outcome.touched.approvalLost || !!before?.approvalLost,
    })
  }
  if (outcome.requeue && !again(state, frameId, componentIds))
    console.error(`[propagation] frame ${frameId} kept changing; left for its own next write`, job.canvasId)
}

/** A turn's answer, or a rejection once it has gone unanswered for `turnTimeoutMs`. */
function answered<T>(turn: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${turnTimeoutMs / 1000} s; the canvas goes on`)),
      turnTimeoutMs,
    )
  })
  /* an answer after the timeout is dropped: its turn was already said as failed */
  turn.catch(() => {})
  return Promise.race([turn, timeout]).finally(() => clearTimeout(timer))
}

/** Put the frame back in the queue for another try; false once it has had its tries. */
function again(state: TaskState, frameId: string, componentIds: string[]): boolean {
  const attempts = (state.attempts.get(frameId) ?? 0) + 1
  if (attempts >= MAX_ATTEMPTS) return false
  state.attempts.set(frameId, attempts)
  const waiting = state.todo.get(frameId)
  if (waiting) for (const id of componentIds) waiting.add(id)
  else state.todo.set(frameId, new Set(componentIds))
  return true
}

function defer(canvasId: string, task: FrameTask, frameId: string, componentIds: string[], actor: Actor) {
  let owed = deferred.get(frameId)
  if (!owed) deferred.set(frameId, (owed = { canvasId, tasks: new Map() }))
  const waiting = owed.tasks.get(task)
  if (waiting) {
    for (const id of componentIds) waiting.componentIds.add(id)
    waiting.actor = actor
  } else owed.tasks.set(task, { componentIds: new Set(componentIds), actor })
}

/** The frame is free again (its stream closed, finished or abandoned): what it was owed goes
 *  back into the queue, for that frame alone. A frame deleted meanwhile is simply not there
 *  when its turn comes. */
export function resumeFrame(frameId: string) {
  const owed = deferred.get(frameId)
  if (!owed) return
  deferred.delete(frameId)
  for (const [task, { componentIds, actor }] of owed.tasks)
    enqueue(task, owed.canvasId, [...componentIds], actor, { onlyFrameIds: [frameId] })
}

/** Frames with work kept for when they are free. */
export function deferredFrames(): string[] {
  return [...deferred.keys()]
}

/** A frame that throws is skipped and said so: the queue, and the process, outlive it. One
 *  over its work budget is left as it is in memory (at the revision it had) and catches up
 *  on its own next write, or when its page is next read. */
function guarded<T>(what: string, canvasId: string, run: () => T): T | undefined {
  try {
    return run()
  } catch (error) {
    return skipped(what, canvasId, error)
  }
}

/** `guarded` for a turn that answers later: its rejection is said and skipped the same way. */
async function guardedLater<T>(what: string, canvasId: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    return skipped(what, canvasId, error)
  }
}

function skipped(what: string, canvasId: string, error: unknown): undefined {
  if (error instanceof WorkBudgetError) console.error(`[propagation] ${what} skipped: ${error.message}`)
  else console.error(`[propagation] ${what} failed; skipped`, canvasId, error)
  return undefined
}

function merged(earlier: DrainReport | undefined, later: DrainReport): DrainReport {
  if (!earlier) return later
  const frames = new Map(earlier.frames.map((frame) => [frame.id, frame]))
  for (const frame of later.frames)
    frames.set(frame.id, { ...frame, approvalLost: frame.approvalLost || !!frames.get(frame.id)?.approvalLost })
  return {
    components: [...new Set([...earlier.components, ...later.components])],
    frames: [...frames.values()],
    count: earlier.count + later.count,
  }
}

function finish(job: Job) {
  if (jobs.get(job.canvasId) !== job) return
  jobs.delete(job.canvasId)
  const at = ring.indexOf(job.canvasId)
  if (at !== -1) ring.splice(at, 1)
  job.release?.()
  for (const waiter of job.waiters) waiter(job.reports)
  if (jobs.size) return
  const waiting = idleWaiters
  idleWaiters = []
  for (const waiter of waiting) waiter()
}

/** Is this component waiting to be carried to frames of the canvas? */
export function isPending(canvasId: string, task: FrameTask, componentId: string): boolean {
  const state = jobs.get(canvasId)?.tasks.get(task)
  if (!state) return false
  for (const waiting of state.todo.values()) if (waiting.has(componentId)) return true
  return false
}

/** How many frames of the canvas still wait for a visit. */
export function pendingFrames(canvasId: string): number {
  let frames = 0
  for (const state of jobs.get(canvasId)?.tasks.values() ?? []) frames += state.todo.size
  return frames
}

/** Resolves when the canvas has no work pending, with what its queue did since it last was idle. */
export function whenCanvasIdle(canvasId: string): Promise<DrainReports> {
  const job = jobs.get(canvasId)
  if (!job) return Promise.resolve({})
  return new Promise((resolve) => job.waiters.push(resolve))
}

/** Like whenCanvasIdle, but gives up after `ms`: false when work is still pending then. */
export function settled(canvasIds: string[], ms: number): Promise<boolean> {
  const busy = canvasIds.filter((id) => jobs.has(id))
  if (!busy.length) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void Promise.all(busy.map(whenCanvasIdle)).then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** How long a read that an agent uses to check its work waits for the canvas to settle. */
const READ_SETTLE_MS = 2000

/** Tools an agent checks a change with (a frame's HTML, a screenshot, an export): they wait
 *  a moment for queued work on their canvas, so the check sees the change it follows. */
export const SETTLING_TOOLS: ReadonlySet<string> = new Set([
  'get_frame',
  'get_frame_screenshot',
  'export_frame',
  'get_frame_html',
  'inspect_frame',
  'screenshot_frame',
])

export function settleForRead(tool: string, canvasIds: string[]): Promise<boolean> {
  return SETTLING_TOOLS.has(tool) ? settled(canvasIds, READ_SETTLE_MS) : Promise.resolve(true)
}

/** Resolves when no canvas has work pending. Tests await this where they used to read a
 *  synchronous result. */
export function whenIdle(): Promise<void> {
  if (!jobs.size) return Promise.resolve()
  return new Promise((resolve) => idleWaiters.push(resolve))
}

export function stats() {
  return { canvases: jobs.size, frames: [...jobs.keys()].reduce((total, id) => total + pendingFrames(id), 0) }
}
