import { describe, expect, it } from 'vitest'
import { NO_INSETS } from '../src/lib/viewFit'
import { zoomAtPoint, zoomToBox } from '../src/lib/zoomTool'

/**
 * The Zoom tool (Z): a click zooms in on the point under the pointer, ⌥ zooms
 * out from it, and a dragged box fills the open stage.
 */

const limits = { min: 0.08, max: 16 }

/** the world point a stage point shows under a camera */
const world = (vp: { x: number; y: number; zoom: number }, at: { x: number; y: number }) => ({
  x: (at.x - vp.x) / vp.zoom,
  y: (at.y - vp.y) / vp.zoom,
})

describe('zoomAtPoint', () => {
  it('keeps the world point under the click where it was', () => {
    const vp = { x: 40, y: -20, zoom: 1 }
    const at = { x: 300, y: 200 }
    const next = zoomAtPoint(vp, at, 2, limits)
    expect(next.zoom).toBe(2)
    expect(world(next, at)).toEqual(world(vp, at))
    const out = zoomAtPoint(next, at, 0.5, limits)
    expect(out.zoom).toBe(1)
    expect(world(out, at)).toEqual(world(vp, at))
  })

  it('stops at the camera limits', () => {
    expect(zoomAtPoint({ x: 0, y: 0, zoom: 12 }, { x: 0, y: 0 }, 2, limits).zoom).toBe(16)
    expect(zoomAtPoint({ x: 0, y: 0, zoom: 0.1 }, { x: 0, y: 0 }, 0.5, limits).zoom).toBe(0.08)
  })
})

describe('zoomToBox', () => {
  it('fills the stage with the box, centred, without padding', () => {
    const vp = { x: 0, y: 0, zoom: 1 }
    const next = zoomToBox(
      vp,
      { x: 100, y: 100, width: 200, height: 100 },
      { width: 800, height: 600 },
      NO_INSETS,
      limits,
    )
    /* the wider side decides: 800 / 200 */
    expect(next.zoom).toBe(4)
    /* the box's centre (world 200, 150) lands on the stage's centre */
    expect(world(next, { x: 400, y: 300 })).toEqual({ x: 200, y: 150 })
  })

  it('centres in the area the chrome leaves open', () => {
    const insets = { top: 50, right: 200, bottom: 0, left: 0 }
    const next = zoomToBox(
      { x: 0, y: 0, zoom: 1 },
      { x: 0, y: 0, width: 300, height: 275 },
      { width: 800, height: 600 },
      insets,
      limits,
    )
    expect(next.zoom).toBe(2)
    expect(world(next, { x: 300, y: 325 })).toEqual({ x: 150, y: 137.5 })
  })

  it('stops at the camera limits', () => {
    const next = zoomToBox(
      { x: 0, y: 0, zoom: 4 },
      { x: 0, y: 0, width: 4, height: 4 },
      { width: 800, height: 600 },
      NO_INSETS,
      limits,
    )
    expect(next.zoom).toBe(16)
  })
})
