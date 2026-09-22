import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

/* createCenteredFrame creates through the API and records for undo - stub the
   network and analytics the same way frameClipboard.test.ts does for the
   ⌘V/right-click paste paths, so the Stage-bounds and viewport wiring can be
   exercised without a real server or PostHog. */
let nextId = 0
const api = {
  createFrame: vi.fn(async (canvasId: string, rest: Partial<Frame>) => ({
    ...frame('x'),
    ...rest,
    canvasId,
    id: `new${++nextId}`,
  })),
  deleteFrame: vi.fn(async () => ({})),
}
vi.mock('../src/lib/api', () => ({ api }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

function frame(id: string, x = 0, y = 0, width = 100, height = 100): Frame {
  return { id, canvasId: 'c1', name: id, html: `<p>${id}</p>`, x, y, width, height } as Frame
}

const { useStore } = await import('../src/lib/store')
const history = await import('../src/lib/history')
const { frameCenterPosition, createCenteredFrame, DEFAULT_FRAME_SIZE } = await import('../src/lib/framePlacement')

describe('frameCenterPosition', () => {
  it('centers a frame in an untransformed view (no pan, no zoom)', () => {
    // 1000x800 view, origin at the top-left, no zoom: the world-space
    // center of the view is (500, 400). A 640x480 frame centered there has
    // its top-left at (500 - 320, 400 - 240).
    const pos = frameCenterPosition({ x: 0, y: 0, zoom: 1 }, { width: 1000, height: 800 }, { width: 640, height: 480 })

    expect(pos).toEqual({ x: 180, y: 160 })
  })

  it('accounts for a panned viewport', () => {
    // panning the camera right/down by (200, 100) moves the world under a
    // fixed screen point left/up by the same amount, so the frame should
    // land 200/100 world-units further left/up than the unpanned case.
    const pos = frameCenterPosition(
      { x: 200, y: 100, zoom: 1 },
      { width: 1000, height: 800 },
      { width: 640, height: 480 },
    )

    expect(pos).toEqual({ x: -20, y: 60 })
  })

  it('accounts for zoom, matching what pasteFrameCentered already does for paste', () => {
    // at 2x zoom, the same screen center covers half the world distance
    const pos = frameCenterPosition({ x: 0, y: 0, zoom: 2 }, { width: 1000, height: 800 }, { width: 640, height: 480 })

    expect(pos).toEqual({ x: 250 - 320, y: 200 - 240 })
  })

  it('is independent of how many frames already exist on the canvas', () => {
    // the bug this replaces was keyed off canvas.frames (right of the
    // right-most one), which drifts further off-screen the more frames
    // exist. The fix only depends on the current view, so the same
    // viewport always yields the same placement.
    const withNoFrames = frameCenterPosition(
      { x: 0, y: 0, zoom: 1 },
      { width: 1000, height: 800 },
      { width: 640, height: 480 },
    )
    const withManyFrames = frameCenterPosition(
      { x: 0, y: 0, zoom: 1 },
      { width: 1000, height: 800 },
      { width: 640, height: 480 },
    )

    expect(withManyFrames).toEqual(withNoFrames)
  })
})

describe('createCenteredFrame', () => {
  beforeEach(() => {
    nextId = 0
    useStore.getState().setCanvas({ id: 'c1', name: 'c', frames: [] } as unknown as Canvas)
    useStore.getState().setViewport({ x: 0, y: 0, zoom: 1 })
    useStore.getState().select(null)
    history.clearHistory()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('centers on the Stage element size, not the window size', async () => {
    // the window is much bigger than the Stage (e.g. a docked side panel, or
    // an app inset above it) - using window.innerWidth/innerHeight here would
    // place the frame too far right/down and, on a short window, partly
    // below the visible area.
    vi.stubGlobal('window', { innerWidth: 3000, innerHeight: 3000 })
    vi.stubGlobal('document', {
      querySelector: (sel: string) =>
        sel === '.stage' ? { getBoundingClientRect: () => ({ width: 1000, height: 800, left: 0, top: 0 }) } : null,
    })

    await createCenteredFrame('c1', 'Frame 1', '<p>hi</p>')

    const [, request] = api.createFrame.mock.calls[0]!
    expect(request).toMatchObject({ x: 180, y: 160 })
  })

  it('falls back to the window size when the Stage element is not mounted', async () => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 })
    vi.stubGlobal('document', { querySelector: () => null })

    await createCenteredFrame('c1', 'Frame 1', '<p>hi</p>')

    const [, request] = api.createFrame.mock.calls[0]!
    expect(request).toMatchObject({ x: 180, y: 160 })
  })

  it('sends the same size in the create request that it centered around', async () => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 })
    vi.stubGlobal('document', { querySelector: () => null })

    await createCenteredFrame('c1', 'Frame 1', '<p>hi</p>')

    const [canvasId, request] = api.createFrame.mock.calls[0]!
    expect(canvasId).toBe('c1')
    expect(request).toMatchObject({
      name: 'Frame 1',
      html: '<p>hi</p>',
      width: DEFAULT_FRAME_SIZE.width,
      height: DEFAULT_FRAME_SIZE.height,
    })
  })

  it('records the created frame for undo and returns it', async () => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 })
    vi.stubGlobal('document', { querySelector: () => null })

    const created = await createCenteredFrame('c1', 'Frame 1', '<p>hi</p>')
    expect(created.id).toBe('new1')

    // If the create wasn't pushed onto the undo stack, this is a no-op and
    // deleteFrame is never called.
    await history.undo()
    expect(api.deleteFrame).toHaveBeenCalledWith('new1')
  })
})
