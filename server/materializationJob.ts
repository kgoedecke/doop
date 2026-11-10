import { PRIVATE_MEDIA_LIMITS, PrivateMaterializationError } from '../shared/privateMedia.ts'
import { renderAdmission } from './renderAdmission.ts'

export interface MaterializationJob {
  readonly signal: AbortSignal
  /** Call before and after every leaf; cancellation never starts another read. */
  check(): void
  read<T>(start: () => Promise<T>): Promise<T>
  /** The tracked worker leaf must stay pending until its actual exit. */
  onCancel(stop: () => void): () => void
}

/** The caller deadline and the underlying operation's lifetime are different.
 * Only execution/drain owns admission; a timed-out caller never transfers it. */
export function createMaterializationRunner({
  responseMs = PRIVATE_MEDIA_LIMITS.responseMs,
}: { responseMs?: number } = {}) {
  const acquire = renderAdmission(4)
  return function run<T>(work: (job: MaterializationJob) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const pending = new Set<Promise<unknown>>()
    const stoppers = new Set<() => void>()
    const deadline = Date.now() + responseMs
    let settled = false
    let resolveCaller!: (value: T) => void
    let rejectCaller!: (error: unknown) => void
    const caller = new Promise<T>((resolve, reject) => {
      resolveCaller = resolve
      rejectCaller = reject
    })
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if ('value' in result) resolveCaller(result.value)
      else rejectCaller(result.error)
    }
    const stop = () => {
      if (controller.signal.aborted) return
      controller.abort()
      for (const stopper of stoppers) {
        // A failed stop request is not proof of exit: the leaf keeps its slot.
        try {
          stopper()
        } catch {
          // Drain still waits for the tracked operation's settlement.
        }
      }
    }
    const cancel = () => {
      stop()
      finish({ error: new PrivateMaterializationError('aborted') })
    }
    const timer = setTimeout(cancel, Math.max(0, responseMs))
    const job: MaterializationJob = {
      signal: controller.signal,
      check() {
        if (controller.signal.aborted || Date.now() >= deadline) {
          cancel()
          throw new PrivateMaterializationError('aborted')
        }
      },
      async read<R>(start: () => Promise<R>): Promise<R> {
        job.check()
        // Defer invocation until it has been registered as owned work.
        const leaf = Promise.resolve().then(() => {
          job.check()
          return start()
        })
        pending.add(leaf)
        try {
          const value = await leaf
          job.check()
          return value
        } finally {
          pending.delete(leaf)
        }
      },
      onCancel(stopper) {
        if (controller.signal.aborted) stopper()
        else stoppers.add(stopper)
        return () => stoppers.delete(stopper)
      },
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) {
      cancel()
      return caller
    }
    const drain = async () => {
      while (pending.size) await Promise.allSettled([...pending])
    }
    // This continuation outlives a cancelled caller. Its permit cannot be
    // transferred until every begun, possibly signal-ignoring leaf settles.
    void (async () => {
      let release: (() => void) | undefined
      try {
        release = await acquire()
        job.check()
        const value = await work(job)
        await drain()
        job.check()
        finish({ value })
      } catch (error) {
        stop()
        finish({ error })
      } finally {
        await drain()
        stoppers.clear()
        release?.()
      }
    })()
    return caller
  }
}

export const runMaterializationJob = createMaterializationRunner()
