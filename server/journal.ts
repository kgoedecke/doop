import { AsyncLocalStorage } from 'node:async_hooks'
import { env } from './env.ts'

/**
 * One write boundary per operation. A write changes memory at once (the engine
 * reads its own writes) and records how to undo it; everything that leaves the
 * process (a database write, a room broadcast, an event, a queued job) waits in
 * order for the commit. An operation that throws, a WorkBudgetError above all,
 * is undone in reverse and its queue dropped: nobody was told, nothing was
 * stored, memory is as it was. One that returns sends its queue.
 *
 * `transaction` is the boundary. `runOperation` opens one (server/workBudget.ts),
 * so an MCP tool call, a resident tool call and each frame of the propagation
 * queue are one each; the HTTP middleware opens one per request by hand
 * (`openTransaction`) and settles it as the response starts. Inside an open
 * transaction another `transaction` is a savepoint: it undoes its own part when
 * it throws, and otherwise waits for the outer commit.
 *
 * What it does not give is isolation. Memory holds an open transaction's writes,
 * so anything else that runs while it awaits reads them. An undo therefore
 * checks that what it would put back is still its own write (store.ts), and a
 * tool that awaits a slow call sub-commits first (`checkpoint`), so it holds
 * nothing open across the wait.
 */

interface Entry {
  undo?: (rollback: Rollback) => void
  effect?: () => void
  post?: () => void
}

export interface Rollback {
  /** the transaction had awaited: a timer may have run between its write and now */
  yielded: boolean
  /** Put a stored row right, once every undo has run: a repair made in the middle could
   *  store state that a later undo takes away (a frame the same transaction created).
   *  One per key: the last one asked for runs. */
  repair: (key: string, write: () => void) => void
}

type State = 'open' | 'settling' | 'closed'

class Journal {
  private entries: Entry[] = []
  /** entries already committed by a checkpoint: a savepoint's mark counts from the start */
  private committed = 0
  private keys = new Map<string, number>()
  state: State = 'open'
  yielded = false

  readonly outside?: string

  constructor(outside?: string) {
    this.outside = outside
  }

  mark(): number {
    return this.committed + this.entries.length
  }

  add(entry: Entry, key?: string) {
    if (key !== undefined) {
      if (this.keys.has(key)) return
      this.keys.set(key, this.mark())
    }
    this.entries.push(entry)
  }

  /** Send what is queued, in order, and forget how to undo it. */
  private flush(): (() => void)[] {
    const entries = this.entries
    this.entries = []
    this.committed += entries.length
    this.keys.clear()
    const post: (() => void)[] = []
    for (const entry of entries) {
      if (entry.post) post.push(entry.post)
      if (!entry.effect) continue
      try {
        entry.effect()
      } catch (error) {
        /* the change is made and stays: one failed send must not hold back the rest */
        console.error('[journal] an effect failed after its commit', error)
      }
    }
    return post
  }

  private runPost(post: (() => void)[]) {
    /* never inside this journal: after a checkpoint it is open again, and work that follows
       a commit must commit on its own, not be undone with whatever comes after */
    const context = this.outside === undefined ? undefined : { outside: this.outside }
    for (const task of post) {
      try {
        scope.run(context, () => transaction(task))
      } catch (error) {
        console.error('[journal] work after a commit failed', error)
      }
    }
  }

  commit() {
    if (this.state !== 'open') return
    this.state = 'settling'
    const post = this.flush()
    this.state = 'closed'
    this.runPost(post)
  }

  /** Commit what is done so far and stay open for the rest. */
  checkpoint() {
    if (this.state !== 'open') return
    this.state = 'settling'
    const post = this.flush()
    this.state = 'open'
    this.runPost(post)
  }

  private undo(entries: Entry[]) {
    const repairs = new Map<string, () => void>()
    const rollback: Rollback = {
      yielded: this.yielded,
      repair: (key, write) => {
        repairs.delete(key)
        repairs.set(key, write)
      },
    }
    for (const entry of entries.reverse()) {
      if (!entry.undo) continue
      try {
        entry.undo(rollback)
      } catch (error) {
        console.error('[journal] an undo failed; the rest are still undone', error)
      }
    }
    for (const write of repairs.values()) {
      try {
        write()
      } catch (error) {
        console.error('[journal] a repair after an undo failed', error)
      }
    }
  }

  rollback() {
    if (this.state !== 'open') return
    this.state = 'settling'
    const entries = this.entries
    this.entries = []
    this.keys.clear()
    this.undo(entries)
    this.state = 'closed'
  }

  /** Undo back to a savepoint. What a checkpoint committed since stays committed. */
  rollbackTo(mark: number) {
    if (this.state !== 'open') return
    const entries = this.entries.splice(Math.max(0, mark - this.committed))
    for (const [key, at] of this.keys) if (at >= mark) this.keys.delete(key)
    this.state = 'settling'
    this.undo(entries)
    this.state = 'open'
  }
}

/** Marks work as deliberately outside any operation: each write commits by itself. */
interface Outside {
  outside: string
}

const scope = new AsyncLocalStorage<Journal | Outside | undefined>()

function openJournal(): Journal | undefined {
  const current = scope.getStore()
  return current instanceof Journal && current.state === 'open' ? current : undefined
}

function outsideMark(): string | undefined {
  return scope.getStore()?.outside
}

/** Is a write here part of a transaction that can still be undone? */
export function inTransaction(): boolean {
  return openJournal() !== undefined
}

/**
 * Run `work` as one unit: all of it lands, or none of it. At the top level it
 * commits when the work returns (for a promise, when it resolves) and is undone
 * when it throws. Inside an open transaction it is a savepoint of that one.
 * Savepoints nest; two must not run side by side in one transaction.
 */
export function transaction<T>(work: () => T): T {
  const parent = openJournal()
  if (parent) {
    const mark = parent.mark()
    let nested: T
    try {
      nested = work()
    } catch (error) {
      parent.rollbackTo(mark)
      throw error
    }
    if (!(nested instanceof Promise)) return nested
    return nested.catch((error: unknown) => {
      parent.rollbackTo(mark)
      throw error
    }) as T
  }
  const journal = new Journal(outsideMark())
  let result: T
  try {
    result = scope.run(journal, work)
  } catch (error) {
    journal.rollback()
    throw error
  }
  if (!(result instanceof Promise)) {
    journal.commit()
    return result
  }
  journal.yielded = true
  return result.then(
    (value: unknown) => {
      journal.commit()
      return value
    },
    (error: unknown) => {
      journal.rollback()
      throw error
    },
  ) as T
}

/**
 * A savepoint for code that turns a failure into a returned value instead of letting it
 * out: `undo()` in its catch takes back what was done since. Nothing with no transaction
 * open. Prefer `transaction`, which does this for whatever throws out of it.
 */
export function savepoint(): { undo(): void } {
  const journal = openJournal()
  if (!journal) return { undo() {} }
  const mark = journal.mark()
  return { undo: () => journal.rollbackTo(mark) }
}

/** A function whose every call is one unit: all of it lands or none of it. Inside an
 *  operation it is a savepoint of that operation; called with none open (a job, a test) it
 *  commits by itself. */
export const atomic =
  <A extends unknown[], R>(work: (...args: A) => R) =>
  (...args: A): R =>
    transaction(() => work(...args))

export interface OpenTransaction {
  readonly open: boolean
  run<T>(work: () => T): T
  commit(): void
  rollback(): void
}

/** A transaction whose end is the caller's to call: an HTTP request commits when its
 *  response starts, and is undone when its handler threw instead. Settling twice is nothing. */
export function openTransaction(): OpenTransaction {
  const journal = new Journal(outsideMark())
  journal.yielded = true
  return {
    get open() {
      return journal.state === 'open'
    },
    run: (work) => scope.run(journal, work),
    commit: () => journal.commit(),
    rollback: () => journal.rollback(),
  }
}

/** How to take back the change just made to memory, should the transaction be undone. */
export function recordUndo(undo: (rollback: Rollback) => void) {
  openJournal()?.add({ undo })
}

/**
 * Something that leaves the process (a database write, a broadcast): it waits for the
 * commit, and is dropped when the transaction is undone. With no transaction open it runs
 * now. Under a `key` it is queued once, where it was first asked for: for a write that
 * stores the latest state whenever it runs, so asking twice is one write.
 */
export function afterCommit(effect: () => void, key?: string) {
  const journal = openJournal()
  if (journal) journal.add({ effect }, key)
  else effect()
}

/** Work that follows a commit and writes on its own account: it runs once everything
 *  queued has been sent, as a transaction of its own, so it cannot undo what it follows.
 *  With no transaction open it runs now. */
export function postCommit(work: () => void) {
  const journal = openJournal()
  if (journal) journal.add({ post: work })
  else work()
}

/**
 * Sub-commit: what the operation has done so far is sent and stays, whatever happens to
 * the rest. For an operation meant to keep partial progress, and before an await on
 * something slow, so nothing is held back (or left open to be undone) across the wait.
 */
export function checkpoint() {
  openJournal()?.checkpoint()
}

/** Run `work` with no transaction around it, whatever it was started from: a queue's tick
 *  scheduled inside a request must not join that request. */
export function detached<T>(work: () => T): T {
  return scope.run(undefined, work)
}

/**
 * Run `work` as deliberately outside any operation: a boot step, a long job that shows its
 * progress as it goes. Each write inside commits by itself (or with the `transaction` it
 * is in); `reason` is for whoever reads the call.
 */
export function outsideOperation<T>(reason: string, work: () => T): T {
  return scope.run({ outside: reason }, work)
}

export class WriteBoundaryError extends Error {
  constructor(what: string) {
    super(
      `${what} ran outside any write boundary: open one (runOperation, transaction) around the work, or mark it with outsideOperation(reason, …) if each write is meant to commit by itself`,
    )
    this.name = 'WriteBoundaryError'
  }
}

type BoundaryCheck = 'off' | 'warn' | 'throw'

function boundaryCheck(): BoundaryCheck {
  if (env.DOOP_WRITE_BOUNDARY) return env.DOOP_WRITE_BOUNDARY
  return env.NODE_ENV === 'development' ? 'warn' : 'off'
}

const warned = new Set<string>()

/**
 * Called by every store write: it must be inside a transaction, or marked as outside one.
 * A write that is neither has escaped the all-or-nothing guarantee without anyone deciding
 * so (a timer, a job continuing after its request was answered). DOOP_WRITE_BOUNDARY says
 * what happens then.
 */
export function requireBoundary(what: string) {
  const check = boundaryCheck()
  if (check === 'off' || openJournal() || outsideMark()) return
  const error = new WriteBoundaryError(what)
  if (check === 'throw') throw error
  if (warned.has(what)) return
  warned.add(what)
  console.error(`[write-boundary] ${error.message}`, error.stack)
}
