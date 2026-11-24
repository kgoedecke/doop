import { AsyncLocalStorage } from 'node:async_hooks'
import { parse as parseDocument, parseFragment as parseDocumentFragment } from 'parse5'
import { env } from './env.ts'
import { transaction } from './journal.ts'

/**
 * How much one operation may make the component engine do. The engine is
 * synchronous on the server's one event loop, and what it costs is parsing: on
 * 2026-11-11 a single request parsed a canvas's frames over and over for
 * minutes. So every engine parse goes through `parse` / `parseFragment` here,
 * which charge the operation in whose context they run (an AsyncLocalStorage
 * the HTTP middleware, the MCP tool wrapper, the resident agent's tool runner
 * and the propagation queue each open) for the bytes handed to parse5 and the
 * time spent in it. Over either limit the parse is refused with a
 * WorkBudgetError: a request path answers with it, the queue skips the frame.
 *
 * The time limit counts time inside the parser, not wall time since the
 * operation began: a tool call that awaits a render for ten seconds has done
 * no work here, and must not be refused for it.
 *
 * Work outside any operation (a timer, a socket message) is counted per turn of
 * the event loop and only logged when it goes over: refusing it would throw
 * where nothing catches.
 */

export type BudgetReason = 'bytes' | 'time'

export class WorkBudgetError extends Error {
  readonly operation: string
  readonly canvasId: string | undefined
  readonly reason: BudgetReason
  /** what an operation of several steps had finished, and keeps, when a later step was
   *  refused; absent when nothing was changed at all */
  readonly done?: string

  constructor(operation: string, canvasId: string | undefined, reason: BudgetReason, done?: string) {
    const where = canvasId ? ` on canvas ${canvasId}` : ''
    const limit =
      reason === 'bytes'
        ? `more than ${env.DOOP_WORK_BUDGET_PARSE_MB} MB of HTML to parse`
        : `more than ${env.DOOP_WORK_BUDGET_MS} ms of parsing`
    const outcome = done
      ? `It stopped part of the way: ${done}. The rest was not done; run it again to continue.`
      : 'Nothing was changed. Make the change in smaller steps (fewer or smaller frames at a time).'
    super(
      `“${operation}”${where} was stopped: it needed ${limit}, the most one operation may do, so the server stays responsive for everyone else. ${outcome}`,
    )
    this.operation = operation
    this.canvasId = canvasId
    this.reason = reason
    this.done = done

    this.name = 'WorkBudgetError'
  }

  /** The same refusal, for an operation whose earlier steps had already landed and stay. */
  afterPartialWork(done: string): WorkBudgetError {
    return new WorkBudgetError(this.operation, this.canvasId, this.reason, done)
  }
}

export interface Operation {
  id: number
  /** what a person or a log line would call it: "PATCH /api/frames/:id", "mcp update_frame" */
  name: string
  canvasId?: string
  startedAt: number
  parsedBytes: number
  parseMs: number
  /** long-lived by design (an event stream): not one for the slow-operation ledger */
  quiet?: boolean
}

export interface OperationListener {
  begin(operation: Operation): void
  /** its canvas became known after it began */
  changed?(operation: Operation): void
  end(operation: Operation): void
}

const context = new AsyncLocalStorage<Operation>()
const listeners: OperationListener[] = []
let nextId = 1

/** Hear every operation begin and end (the stall watchdog keeps its in-flight list this way). */
export function onOperation(listener: OperationListener): () => void {
  listeners.push(listener)
  return () => {
    const at = listeners.indexOf(listener)
    if (at !== -1) listeners.splice(at, 1)
  }
}

export function beginOperation(name: string, canvasId?: string): Operation {
  const operation: Operation = { id: nextId++, name, canvasId, startedAt: Date.now(), parsedBytes: 0, parseMs: 0 }
  for (const listener of listeners) listener.begin(operation)
  return operation
}

export function endOperation(operation: Operation) {
  for (const listener of listeners) listener.end(operation)
}

/** Run `work` inside an operation that is already open (its end is the caller's to mark). */
export function withinOperation<T>(operation: Operation, work: () => T): T {
  return context.run(operation, work)
}

/** Run `work` as one operation with a budget of its own; it ends when the work does,
 *  which for a promise is when it settles. An operation is one write boundary
 *  (server/journal.ts): what it changed is committed when it ends, and undone when it
 *  throws, a refusal for its budget included. */
export function runOperation<T>(name: string, canvasId: string | undefined, work: () => T): T {
  const operation = beginOperation(name, canvasId)
  let result: T
  try {
    result = context.run(operation, () => transaction(work))
  } catch (error) {
    endOperation(operation)
    throw error
  }
  if (result instanceof Promise) return result.finally(() => endOperation(operation)) as T
  endOperation(operation)
  return result
}

export function currentOperation(): Operation | undefined {
  return context.getStore()
}

/** The canvas an operation turned out to be about, for one opened before that was known. */
export function noteCanvas(canvasId: string) {
  const operation = context.getStore()
  if (!operation || operation.canvasId) return
  operation.canvasId = canvasId
  for (const listener of listeners) listener.changed?.(operation)
}

/* work no operation was opened for: counted per turn of the event loop */
let unscoped: (Operation & { reported: boolean }) | undefined

function unscopedWork(): Operation & { reported: boolean } {
  if (unscoped) return unscoped
  unscoped = { id: 0, name: 'unscoped work', startedAt: Date.now(), parsedBytes: 0, parseMs: 0, reported: false }
  setImmediate(() => (unscoped = undefined))
  return unscoped
}

function exceeded(operation: Operation): BudgetReason | undefined {
  const maxBytes = env.DOOP_WORK_BUDGET_PARSE_MB * 1024 * 1024
  if (maxBytes && operation.parsedBytes > maxBytes) return 'bytes'
  if (env.DOOP_WORK_BUDGET_MS && operation.parseMs > env.DOOP_WORK_BUDGET_MS) return 'time'
  return undefined
}

/** Refuse (or, outside any operation, report) work that has gone over its budget. */
function enforce(operation: Operation, scoped: boolean) {
  const reason = exceeded(operation)
  if (!reason) return
  if (scoped) throw new WorkBudgetError(operation.name, operation.canvasId, reason)
  const loose = operation as Operation & { reported: boolean }
  if (loose.reported) return
  loose.reported = true
  console.error(
    `[work-budget] work outside any operation went over the ${reason} budget in one turn (${Math.round(operation.parsedBytes / 1024)} KB parsed, ${Math.round(operation.parseMs)} ms)`,
    new Error('unscoped work').stack,
  )
}

/** One parse, charged. The budget is checked on both sides of it: before, so bytes that do
 *  not fit are never parsed, and after, so the parse that took the operation over its time
 *  is itself refused instead of the one after it (an operation's last parse has none after).
 *  A running parse cannot be interrupted; its result is thrown away. The operation's write
 *  boundary undoes whatever it had changed by then, so a refusal leaves nothing behind. */
function timed<T>(bytes: number, run: () => T): T {
  const scoped = context.getStore()
  const operation = scoped ?? unscopedWork()
  operation.parsedBytes += bytes
  enforce(operation, !!scoped)
  const started = performance.now()
  let result: T
  try {
    result = run()
  } finally {
    operation.parseMs += performance.now() - started
  }
  enforce(operation, !!scoped)
  return result
}

/**
 * A check that is worth having but that nothing depends on (a note for the agent, an id to
 * hand back), run AFTER the work it is about has been committed. Out of budget, it is
 * skipped: `undefined` comes back and the completed write stands. Without this a refusal
 * here would tell the caller "nothing was changed" about a change that had landed.
 */
export function optional<T>(check: () => T): T | undefined {
  try {
    return check()
  } catch (error) {
    if (!(error instanceof WorkBudgetError)) throw error
    return undefined
  }
}

/** parse5's `parse`, charged to the operation in progress. The engine's only way to parse a document. */
export const parse: typeof parseDocument = ((html: string, options?: never) =>
  timed(html.length, () => parseDocument(html, options))) as typeof parseDocument

/** parse5's `parseFragment`, charged to the operation in progress. */
export const parseFragment: typeof parseDocumentFragment = ((...args: unknown[]) => {
  const html = args.find((arg): arg is string => typeof arg === 'string') ?? ''
  return timed(html.length, () => (parseDocumentFragment as (...forwarded: unknown[]) => unknown)(...args))
}) as typeof parseDocumentFragment

/** What the current operation has used: for a test or a log line. */
export function usage(): { parsedBytes: number; parseMs: number } {
  const operation = context.getStore() ?? unscoped
  return { parsedBytes: operation?.parsedBytes ?? 0, parseMs: operation?.parseMs ?? 0 }
}
