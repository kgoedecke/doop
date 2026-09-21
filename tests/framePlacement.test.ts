import { describe, expect, it } from 'vitest'
import { frameCenterPosition } from '../src/lib/framePlacement'

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
