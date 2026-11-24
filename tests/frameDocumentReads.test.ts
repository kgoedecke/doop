// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  bodyPlacementOrigin,
  frameShows,
  layerPlacement,
  onFrameLoadRequest,
  prepareFrameDocument,
  registerFrameWindow,
  showFrameDocument,
  unregisterFrameWindow,
} from '../src/lib/frameBridge'

const frameId = 'frame'
const html = '<body><p>Document</p></body>'
const otherHtml = '<body><p>Other document</p></body>'
const target = { selector: '#target', place: 'inside' } as const

type Outgoing = { type: string; reqId: number }
function outgoing() {
  const messages: Outgoing[] = []
  vi.spyOn(window, 'postMessage').mockImplementation((value: unknown) => {
    messages.push(value as Outgoing)
  })
  return messages
}
function acknowledge(message: Outgoing, payload: Record<string, unknown> = {}) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: `${message.type}-result`, reqId: message.reqId, ...payload },
      source: window,
    }),
  )
}

afterEach(() => {
  unregisterFrameWindow(frameId, window)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('recognizes a render acknowledgement received after a read times out', async () => {
  vi.useFakeTimers()
  const messages = outgoing()
  registerFrameWindow(frameId, window)
  const shown = vi.fn()
  showFrameDocument(frameId, html, shown)

  const firstRead = frameShows(frameId, html)
  await vi.advanceTimersByTimeAsync(2001)
  expect(await firstRead).toBe(false)
  expect(shown).not.toHaveBeenCalled()

  acknowledge(messages[0]!)
  expect(prepareFrameDocument(frameId, html)).toBe('ready')
  expect(shown).toHaveBeenCalledTimes(1)
})

it('does not re-enable editing from a superseded or unregistered document reply', () => {
  const messages = outgoing()
  registerFrameWindow(frameId, window)
  const first = vi.fn()
  const second = vi.fn()
  showFrameDocument(frameId, html, first)
  showFrameDocument(frameId, otherHtml, second)
  acknowledge(messages[0]!)
  expect(first).not.toHaveBeenCalled()
  expect(second).not.toHaveBeenCalled()
  unregisterFrameWindow(frameId, window)
  acknowledge(messages[1]!)
  expect(second).not.toHaveBeenCalled()
  expect(prepareFrameDocument(frameId, otherHtml)).toBe('unavailable')
})

it('starts a queued frame and waits for its acknowledged HTML before reading layer placement', async () => {
  const messages = outgoing()
  const stop = onFrameLoadRequest((id) => {
    if (id !== frameId) return false
    registerFrameWindow(frameId, window)
    showFrameDocument(frameId, html, () => {})
    return true
  })
  try {
    const placement = layerPlacement(frameId, '#layer', target, html)
    expect(messages.map((message) => message.type)).toEqual(['doop:html'])
    acknowledge(messages[0]!)
    await Promise.resolve()
    expect(messages.map((message) => message.type)).toEqual(['doop:html', 'doop:layer-placement'])
    const styles = { order: '0', flexItem: true }
    acknowledge(messages[1]!, { styles })
    expect(await placement).toEqual(styles)
  } finally {
    stop()
  }
})

it('distinguishes unmodified authored placement from unreadable layout', async () => {
  expect(await bodyPlacementOrigin(frameId, html)).toBeNull()
  expect(await layerPlacement(frameId, '#layer', target, html)).toBeNull()
  const messages = outgoing()
  registerFrameWindow(frameId, window)
  showFrameDocument(frameId, html, () => {})
  acknowledge(messages[0]!)
  const reference = layerPlacement(frameId, '#layer', target, html)
  await Promise.resolve()
  acknowledge(messages[1]!, { styles: null })
  expect(await reference).toBeUndefined()

  const origin = bodyPlacementOrigin(frameId, html)
  await Promise.resolve()
  acknowledge(messages[2]!, { origin: { x: 23, y: 47, scale: { x: 1, y: 1 } } })
  expect(await origin).toEqual({ x: 23, y: 47, scale: { x: 1, y: 1 } })
})

it('rejects a measurement from a document superseded while the request was in flight', async () => {
  const messages = outgoing()
  registerFrameWindow(frameId, window)
  showFrameDocument(frameId, html, () => {})
  acknowledge(messages[0]!)
  const origin = bodyPlacementOrigin(frameId, html)
  await Promise.resolve()
  showFrameDocument(frameId, otherHtml, () => {})
  acknowledge(messages[1]!, { origin: { x: 23, y: 47, scale: { x: 1, y: 1 } } })
  expect(await origin).toBeNull()
})
