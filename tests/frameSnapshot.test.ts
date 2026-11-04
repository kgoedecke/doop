// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { registerFrameWindow, snapshotFrame, unregisterFrameWindow } from '../src/lib/frameBridge'

/* the export's snapshot of a frame: an unmounted frame has none (its saved
   HTML stands in), a mounted one answers, and a mounted one that cannot
   or does not answer is for the server, never its saved HTML */

afterEach(() => {
  unregisterFrameWindow('mounted', window)
  vi.useRealTimers()
})

it('has no snapshot of an unmounted frame', async () => {
  expect(await snapshotFrame('unmounted')).toBeNull()
})

it('carries the live document a mounted frame answers with', async () => {
  registerFrameWindow('mounted', window)
  const posted = vi.spyOn(window, 'postMessage').mockImplementation((data: unknown) => {
    const { reqId } = data as { reqId: number }
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'doop:snapshot-result', reqId, html: '<html/>' }, source: window }),
    )
  })
  expect(await snapshotFrame('mounted')).toEqual({ html: '<html/>' })
  expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'doop:snapshot' }), '*')
})

it('reports a mounted frame that could not read itself', async () => {
  registerFrameWindow('mounted', window)
  vi.spyOn(window, 'postMessage').mockImplementation((data: unknown) => {
    const { reqId } = data as { reqId: number }
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'doop:snapshot-result', reqId, html: null }, source: window }),
    )
  })
  expect(await snapshotFrame('mounted')).toEqual({ html: null })
})

it('treats a mounted frame that never answers as unreadable, not unmounted', async () => {
  vi.useFakeTimers()
  registerFrameWindow('mounted', window)
  vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  const snapshot = snapshotFrame('mounted')
  await vi.advanceTimersByTimeAsync(15_000)
  expect(await snapshot).toEqual({ html: null })
})
