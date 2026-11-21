import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startStallWatchdog, type StallWatchdog } from '../server/stallWatchdog.ts'
import { runOperation } from '../server/workBudget.ts'

/* The watcher writes to a file here, and the test reads that file synchronously from
   inside the busy loop's operation: whatever it finds was written while this thread was
   blocked, by a thread that did not need it. */

let dir: string
let logFile: string
let watchdog: StallWatchdog | undefined

const logged = () => readFileSync(logFile, 'utf8')

/** Block this thread, as a runaway synchronous loop would. */
function block(ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* nothing can run here: no timer, no promise, no I/O callback */
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doop-stall-'))
  logFile = join(dir, 'watcher.log')
  writeFileSync(logFile, '')
})

afterEach(async () => {
  await watchdog?.stop()
  watchdog = undefined
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('the stall watchdog', () => {
  it('names the operation in flight while the main thread is still blocked', async () => {
    watchdog = startStallWatchdog({ logMs: 200, exitMs: 0, slowMs: 0, logFile, exit: 'flag' })
    /* the watcher thread is up and has seen a heartbeat */
    await wait(150)
    expect(logged()).toBe('')

    const seenWhileBlocked = runOperation('mcp update_frame', 'canvas-stalled', () => {
      block(900)
      return logged()
    })

    expect(seenWhileBlocked).toContain('[stall] event loop blocked for')
    expect(seenWhileBlocked).toContain('mcp update_frame canvas=canvas-stalled')
    expect(seenWhileBlocked).toMatch(/mcp update_frame canvas=canvas-stalled \(\d+ ms\)/)
    /* one line per stall, not one per look */
    expect(seenWhileBlocked.trim().split('\n')).toHaveLength(1)
    expect(watchdog.exitRequested()).toBe(false)

    /* and it says when the loop is back */
    await wait(300)
    expect(logged()).toContain('answering again')
    expect(watchdog.stallsLogged()).toBe(1)
  })

  it('ends the process past the exit threshold, through an exit that can be swapped out', async () => {
    watchdog = startStallWatchdog({ logMs: 100, exitMs: 400, slowMs: 0, logFile, exit: 'flag' })
    await wait(150)

    const seenWhileBlocked = runOperation('PATCH /api/frames/f1', 'canvas-gone', () => {
      block(1000)
      return { log: logged(), exit: watchdog!.exitRequested() }
    })

    /* decided, and said, while this thread could not have taken part */
    expect(seenWhileBlocked.exit).toBe(true)
    expect(seenWhileBlocked.log).toContain('past STALL_EXIT_MS=400: ending the process')
    expect(seenWhileBlocked.log).toContain('PATCH /api/frames/f1 canvas=canvas-gone')
    /* this test is the proof the process was not ended */
  })

  it('does not wait for a longer log threshold before ending the process', async () => {
    /* misconfigured on purpose: the line is due after the exit */
    watchdog = startStallWatchdog({ logMs: 5000, exitMs: 300, slowMs: 0, logFile, exit: 'flag' })
    await wait(150)

    const seenWhileBlocked = runOperation('mcp set_frame_html', 'canvas-late-log', () => {
      block(1200)
      return { log: logged(), exit: watchdog!.exitRequested() }
    })

    expect(seenWhileBlocked.exit).toBe(true)
    const lines = seenWhileBlocked.log.trim().split('\n')
    /* still said before it is done: what was in flight, then that the process is ended */
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[stall] event loop blocked for')
    expect(lines[0]).toContain('mcp set_frame_html canvas=canvas-late-log')
    expect(lines[1]).toContain('past STALL_EXIT_MS=300: ending the process')
  })

  it('says nothing about a normal workload', async () => {
    const lines = vi.spyOn(console, 'log').mockImplementation(() => {})
    watchdog = startStallWatchdog({ logMs: 1000, exitMs: 2000, slowMs: 2000, logFile, exit: 'flag' })
    await wait(100)
    /* many short operations that yield, as requests do */
    for (let round = 0; round < 12; round++) {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          runOperation(`GET /api/canvases/c${index}`, `c${index}`, async () => {
            block(5)
            await wait(40)
          }),
        ),
      )
    }
    expect(logged()).toBe('')
    expect(watchdog.stallsLogged()).toBe(0)
    expect(watchdog.exitRequested()).toBe(false)
    expect(lines.mock.calls.filter(([line]) => String(line).startsWith('[slow-op]'))).toEqual([])
  })

  it('files a slow operation when it finishes, with the event-loop delay it ran under', async () => {
    const lines = vi.spyOn(console, 'log').mockImplementation(() => {})
    watchdog = startStallWatchdog({ logMs: 0, exitMs: 0, slowMs: 300, logFile })
    await wait(50)
    await runOperation('mcp import_webpage', 'canvas-slow', async () => {
      await wait(100)
      block(250)
      await wait(100)
    })
    await runOperation('GET /healthz', undefined, async () => wait(20))

    const slow = lines.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('[slow-op]'))
    expect(slow).toHaveLength(1)
    expect(slow[0]).toContain('mcp import_webpage canvas=canvas-slow took')
    const delay = Number(/worst event-loop delay meanwhile (\d+) ms/.exec(slow[0]!)?.[1])
    expect(delay).toBeGreaterThan(150)
  })

  it('counts operations past its slots instead of losing track', async () => {
    watchdog = startStallWatchdog({ logMs: 150, exitMs: 0, slowMs: 0, logFile, exit: 'flag' })
    await wait(100)
    const open = Array.from({ length: 70 }, (_, index) =>
      runOperation(`GET /slow/${index}`, undefined, () => wait(700)),
    )
    const seen = runOperation('the blocker', undefined, () => {
      block(500)
      return logged()
    })
    expect(seen).toContain('in flight, newest first')
    expect(seen).toMatch(/and \d+ more/)
    await Promise.all(open)
  })
})
