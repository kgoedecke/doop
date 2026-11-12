/* eslint-disable no-undef */
import { appendFileSync, writeSync } from 'node:fs'
import { workerData } from 'node:worker_threads'

/**
 * The watching half of server/stallWatchdog.ts, on its own thread: plain
 * JavaScript, so it loads the same under tsx, vitest and a built image. It
 * must never rely on the main thread, which is by definition not answering
 * when this has something to say. So: it reads shared memory only, writes its
 * lines with a synchronous write to the descriptor (a worker's console is
 * forwarded through the main thread and would sit there unprinted), and ends
 * the process with a signal the main thread cannot handle or delay.
 */

const { buffer, layout, logMs, exitMs, checkMs, logFile, exitMode, pid } = workerData

const beat = new BigInt64Array(buffer, layout.beat, 1)
const flags = new Int32Array(buffer, layout.flags, layout.flagCount)
const starts = new BigInt64Array(buffer, layout.starts, layout.slots)
const lengths = new Int32Array(buffer, layout.lengths, layout.slots)
const labels = new Uint8Array(buffer, layout.labels, layout.slots * layout.labelBytes)
const decoder = new TextDecoder()

const MAX_NAMED = 16

function say(line) {
  const text = `${line}\n`
  if (logFile) appendFileSync(logFile, text)
  else writeSync(2, text)
}

/** The operations in flight, newest first: one of them is what the main thread is stuck in. */
function inFlight(now) {
  const found = []
  for (let slot = 0; slot < layout.slots; slot++) {
    const started = Atomics.load(starts, slot)
    if (started === 0n) continue
    const length = Math.min(Atomics.load(lengths, slot), layout.labelBytes)
    /* a copy: TextDecoder refuses a view on shared memory */
    const bytes = labels.slice(slot * layout.labelBytes, slot * layout.labelBytes + length)
    /* the slot was reused while it was being read: what was read is of neither operation */
    if (Atomics.load(starts, slot) !== started) continue
    found.push({ started: Number(started), label: decoder.decode(bytes) })
  }
  found.sort((a, b) => b.started - a.started)
  const named = found.slice(0, MAX_NAMED).map((entry) => `${entry.label} (${now - entry.started} ms)`)
  const more = found.length - named.length + Atomics.load(flags, layout.flagOverflow)
  if (!named.length) return 'no operation in flight'
  return `in flight, newest first: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}`
}

let lastCheck = Date.now()
/* stalls are measured from here at the earliest: moved up when this thread itself was not
   scheduled (the machine slept, the container was frozen), which is not the main thread's doing */
let since = lastCheck
let reported = false
let blockedSince = 0

function check() {
  const now = Date.now()
  if (now - lastCheck > Math.max(1000, checkMs * 4)) since = now
  lastCheck = now
  const last = Math.max(Number(Atomics.load(beat, 0)), since)
  const stalled = now - last
  /* on its own: a log threshold set above it must not hold the exit back */
  const ending = exitMs > 0 && stalled > exitMs
  if (!ending && stalled <= logMs) {
    if (reported) say(`[stall] event loop answering again; it was blocked for about ${now - blockedSince} ms`)
    reported = false
    return
  }
  if (!reported) {
    reported = true
    blockedSince = last
    Atomics.add(flags, layout.flagLogged, 1)
    say(`[stall] event loop blocked for ${stalled} ms; ${inFlight(now)}`)
  }
  if (!ending) return
  say(
    `[stall] event loop blocked for ${stalled} ms, past STALL_EXIT_MS=${exitMs}: ending the process; ${inFlight(now)}`,
  )
  Atomics.store(flags, layout.flagExit, 1)
  if (exitMode !== 'kill') {
    clearInterval(timer)
    return
  }
  /* process.exit() in a worker only ends the worker, and a catchable signal waits for the
     blocked thread: SIGKILL is the one exit the main thread has no part in. The supervisor
     (Railway's restart policy ALWAYS) starts the service again. */
  process.kill(pid, 'SIGKILL')
}

const timer = setInterval(check, checkMs)
