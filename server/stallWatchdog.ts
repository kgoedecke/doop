import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { env } from './env.ts'
import { onOperation, type Operation } from './workBudget.ts'

/**
 * Notices a blocked event loop from outside it. On 2026-11-11 the loop was
 * blocked for ten minutes and more at a time: the supervisor restarts a
 * process that dies, not one that hangs, and a "log it when it finishes"
 * ledger says nothing about an operation that never does.
 *
 * - Begin markers: every operation (server/workBudget.ts opens one per HTTP
 *   request, tool call and queued frame) is written into shared memory when it
 *   begins and cleared when it ends, so the list of what is in flight can be
 *   read while this thread is stuck.
 * - Heartbeat: this thread stamps the time into shared memory every 500 ms.
 * - Watcher (stallWatcher.mjs, a worker thread): when the stamp is older than
 *   STALL_LOG_MS it logs one line naming the operations in flight and their
 *   ages; older than STALL_EXIT_MS, it logs them again and kills the process,
 *   for the supervisor to start a fresh one.
 * - Slow-op ledger: an operation that took SLOW_OP_LOG_MS or more is logged
 *   when it ends, with the worst event-loop delay measured while it ran.
 *
 * Limitation, on purpose: a kill from the watcher cannot flush the store's
 * debounced frame writes (persist.flush), because the thread that would flush
 * them is the one that is blocked. Frame edits made in the last debounce
 * window before a stall that ends this way are lost, as in any hard crash. The
 * exit threshold is long (60 s by default) so that only a loop that is not
 * coming back is ended.
 */

const SLOTS = 64
const LABEL_BYTES = 192
const FLAG_EXIT = 0
const FLAG_LOGGED = 1
const FLAG_OVERFLOW = 2
const FLAG_COUNT = 4
const HEARTBEAT_MS = 500
/** how far back the event-loop delay samples go: the longest operation the ledger can speak for */
const DELAY_SAMPLES = 1200

const layout = {
  beat: 0,
  flags: 8,
  flagCount: FLAG_COUNT,
  flagExit: FLAG_EXIT,
  flagLogged: FLAG_LOGGED,
  flagOverflow: FLAG_OVERFLOW,
  starts: 8 + FLAG_COUNT * 4,
  slots: SLOTS,
  lengths: 8 + FLAG_COUNT * 4 + SLOTS * 8,
  labels: 8 + FLAG_COUNT * 4 + SLOTS * 8 + SLOTS * 4,
  labelBytes: LABEL_BYTES,
}

export interface StallWatchdogOptions {
  logMs?: number
  exitMs?: number
  slowMs?: number
  /** how often the watcher looks */
  checkMs?: number
  /** the watcher appends its lines here instead of writing them to stderr */
  logFile?: string
  /** `flag` records that the process would have been ended instead of ending it (tests) */
  exit?: 'kill' | 'flag'
}

export interface StallWatchdog {
  stop(): Promise<void>
  /** the watcher decided to end the process (only observable with exit: 'flag') */
  exitRequested(): boolean
  /** how many stalls the watcher has logged */
  stallsLogged(): number
}

let running: StallWatchdog | undefined

interface Registry {
  slotOf: Map<number, number>
  free: number[]
  starts: BigInt64Array
  lengths: Int32Array
  labels: Uint8Array
  flags: Int32Array
}

const encoder = new TextEncoder()

function labelOf(operation: Operation): string {
  return `${operation.name}${operation.canvasId ? ` canvas=${operation.canvasId}` : ''}`
}

function writeLabel(registry: Registry, slot: number, operation: Operation) {
  const bytes = encoder.encode(labelOf(operation)).subarray(0, LABEL_BYTES)
  registry.labels.set(bytes, slot * LABEL_BYTES)
  Atomics.store(registry.lengths, slot, bytes.length)
}

function begin(registry: Registry, operation: Operation) {
  const slot = registry.free.pop()
  if (slot === undefined) {
    /* more in flight than there are slots: counted, so the watcher can say "and N more" */
    Atomics.add(registry.flags, FLAG_OVERFLOW, 1)
    return
  }
  registry.slotOf.set(operation.id, slot)
  /* the label first: a slot with a start time is one the watcher may read */
  writeLabel(registry, slot, operation)
  Atomics.store(registry.starts, slot, BigInt(operation.startedAt))
}

function end(registry: Registry, operation: Operation) {
  const slot = registry.slotOf.get(operation.id)
  if (slot === undefined) {
    if (Atomics.load(registry.flags, FLAG_OVERFLOW) > 0) Atomics.sub(registry.flags, FLAG_OVERFLOW, 1)
    return
  }
  Atomics.store(registry.starts, slot, 0n)
  registry.slotOf.delete(operation.id)
  registry.free.push(slot)
}

/** Start the watchdog (once per process: a second call returns the one running). */
export function startStallWatchdog(options: StallWatchdogOptions = {}): StallWatchdog {
  if (running) return running
  const logMs = options.logMs ?? env.STALL_LOG_MS
  const exitMs = options.exitMs ?? env.STALL_EXIT_MS
  const slowMs = options.slowMs ?? env.SLOW_OP_LOG_MS
  const buffer = new SharedArrayBuffer(layout.labels + SLOTS * LABEL_BYTES)
  const beat = new BigInt64Array(buffer, layout.beat, 1)
  const registry: Registry = {
    slotOf: new Map(),
    free: Array.from({ length: SLOTS }, (_, index) => SLOTS - 1 - index),
    starts: new BigInt64Array(buffer, layout.starts, SLOTS),
    lengths: new Int32Array(buffer, layout.lengths, SLOTS),
    labels: new Uint8Array(buffer, layout.labels, SLOTS * LABEL_BYTES),
    flags: new Int32Array(buffer, layout.flags, FLAG_COUNT),
  }

  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  /* the worst delay per heartbeat, so an operation can be told what the loop did while it ran */
  const samples: { at: number; maxMs: number }[] = []
  const sample = () => {
    samples.push({ at: Date.now(), maxMs: delay.max / 1e6 })
    if (samples.length > DELAY_SAMPLES) samples.shift()
    delay.reset()
  }
  const worstDelaySince = (startedAt: number) =>
    samples.reduce((worst, entry) => (entry.at >= startedAt ? Math.max(worst, entry.maxMs) : worst), delay.max / 1e6)

  let stopped = false
  const stopListening = onOperation({
    begin: (operation) => begin(registry, operation),
    changed: (operation) => {
      const slot = registry.slotOf.get(operation.id)
      if (slot !== undefined) writeLabel(registry, slot, operation)
    },
    end: (operation) => {
      end(registry, operation)
      const took = Date.now() - operation.startedAt
      if (stopped || !slowMs || took < slowMs || operation.quiet) return
      console.log(
        `[slow-op] ${labelOf(operation)} took ${took} ms (${Math.round(operation.parsedBytes / 1024)} KB parsed in ${Math.round(operation.parseMs)} ms; worst event-loop delay meanwhile ${Math.round(worstDelaySince(operation.startedAt))} ms)`,
      )
    },
  })

  Atomics.store(beat, 0, BigInt(Date.now()))
  /* well inside the shortest threshold, or the gap between two beats would read as a stall */
  const shortest = Math.min(...[logMs, exitMs].filter((ms) => ms > 0), HEARTBEAT_MS * 4)
  const heartbeat = setInterval(
    () => {
      Atomics.store(beat, 0, BigInt(Date.now()))
      sample()
    },
    Math.max(10, Math.min(HEARTBEAT_MS, Math.floor(shortest / 4))),
  )
  heartbeat.unref()

  const watching = logMs > 0 || exitMs > 0
  const worker = watching
    ? new Worker(new URL('./stallWatcher.mjs', import.meta.url), {
        workerData: {
          buffer,
          layout,
          /* with only an exit threshold, the line still comes first */
          logMs: logMs > 0 ? logMs : exitMs,
          exitMs,
          checkMs: options.checkMs ?? Math.max(20, Math.min(250, Math.floor(shortest / 4))),
          logFile: options.logFile,
          exitMode: options.exit ?? 'kill',
          pid: process.pid,
        },
      })
    : undefined
  worker?.unref()
  worker?.on('error', (error) => console.error('[stall] the watcher thread failed', error))

  running = {
    async stop() {
      stopped = true
      running = undefined
      clearInterval(heartbeat)
      delay.disable()
      stopListening()
      await worker?.terminate()
    },
    exitRequested: () => Atomics.load(registry.flags, FLAG_EXIT) === 1,
    stallsLogged: () => Atomics.load(registry.flags, FLAG_LOGGED),
  }
  return running
}
