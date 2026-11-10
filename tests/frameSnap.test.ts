import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  frameSnapTransform,
  settleSnapScale,
  snapCameraOffset,
  snapScale,
  subscribeSnapScale,
  type SnapBox,
  type SnapScale,
} from '../src/lib/frameSnap'

/** Where a box's edges land, in device px, once its snap is applied. */
function snappedEdges(box: SnapBox, scale: SnapScale) {
  const transform = frameSnapTransform(box, scale)
  const [, tx, ty, sx, sy] = transform?.match(/translate\((.+)px, (.+)px\) scale\((.+), (.+)\)/) ?? []
  const shift = { x: Number(tx ?? 0), y: Number(ty ?? 0) }
  const stretch = { x: Number(sx ?? 1), y: Number(sy ?? 1) }
  const perDesign = scale.zoom * scale.dpr
  return {
    left: (box.x + shift.x) * perDesign,
    top: (box.y + shift.y) * perDesign,
    right: (box.x + shift.x + box.width * stretch.x) * perDesign,
    bottom: (box.y + shift.y + box.height * stretch.y) * perDesign,
  }
}

const offGrid = (value: number) => Math.abs(value - Math.round(value))

describe('frameSnapTransform', () => {
  const zooms = [0.08, 0.1, 0.13, 0.29, 0.4653, 0.5748987854251012, 0.75, 1, 1.3, 2.5, 16]
  const boxes: SnapBox[] = [
    { x: 0, y: 0, width: 1440, height: 1024 },
    { x: 1578, y: -38, width: 988, height: 910 },
    { x: -412.5, y: 355.25, width: 760.4, height: 560.7 },
    { x: 3, y: 7, width: 1, height: 1 },
  ]

  it('lands every edge on a whole device pixel', () => {
    for (const dpr of [1, 1.5, 2, 3])
      for (const zoom of zooms)
        for (const box of boxes) {
          const edges = snappedEdges(box, { zoom, dpr })
          for (const edge of Object.values(edges)) expect(offGrid(edge)).toBeLessThan(1e-6)
        }
  })

  it('moves no edge by more than half a device pixel', () => {
    for (const zoom of zooms)
      for (const box of boxes.slice(0, 3)) {
        const perDesign = zoom * 2
        const edges = snappedEdges(box, { zoom, dpr: 2 })
        expect(Math.abs(edges.left - box.x * perDesign)).toBeLessThanOrEqual(0.5 + 1e-6)
        expect(Math.abs(edges.right - (box.x + box.width) * perDesign)).toBeLessThanOrEqual(0.5 + 1e-6)
        expect(Math.abs(edges.bottom - (box.y + box.height) * perDesign)).toBeLessThanOrEqual(0.5 + 1e-6)
      }
  })

  it('keeps two frames that share an edge sharing it', () => {
    const scale = { zoom: 0.4653, dpr: 2 }
    const left = snappedEdges({ x: 100, y: 0, width: 988, height: 600 }, scale)
    const right = snappedEdges({ x: 1088, y: 0, width: 400, height: 600 }, scale)
    expect(left.right).toBeCloseTo(right.left, 6)
  })

  it('keeps a sliver one device pixel wide', () => {
    const edges = snappedEdges({ x: 10, y: 10, width: 1, height: 1 }, { zoom: 0.08, dpr: 1 })
    expect(edges.right - edges.left).toBeCloseTo(1, 6)
    expect(edges.bottom - edges.top).toBeCloseTo(1, 6)
  })

  it('leaves a frame already on the grid alone', () => {
    expect(frameSnapTransform({ x: 120, y: 40, width: 1440, height: 1024 }, { zoom: 1, dpr: 2 })).toBeNull()
    expect(frameSnapTransform({ x: 120, y: 40, width: 1440, height: 1024 }, { zoom: 0.5, dpr: 2 })).toBeNull()
  })

  it('has nothing to say about a box or a scale it cannot use', () => {
    expect(frameSnapTransform({ x: 0, y: 0, width: 0, height: 10 }, { zoom: 0.3, dpr: 2 })).toBeNull()
    expect(frameSnapTransform({ x: 0.3, y: 0, width: 10, height: 10 }, { zoom: 0, dpr: 2 })).toBeNull()
  })
})

describe('snapCameraOffset', () => {
  it('puts the world origin on a device pixel, counting where the stage starts', () => {
    for (const dpr of [1, 1.5, 2])
      for (const origin of [0, 44, 280.5, 12.25])
        for (const offset of [-481.19, 286.767, 0.37, 1200]) {
          const snapped = snapCameraOffset(offset, origin, dpr)
          expect(offGrid((origin + snapped) * dpr)).toBeLessThan(1e-6)
          expect(Math.abs(snapped - offset) * dpr).toBeLessThanOrEqual(0.5 + 1e-6)
        }
  })
})

describe('the settled snap scale', () => {
  afterEach(() => settleSnapScale(null))

  it('tells its listeners of a new scale, and only of a new one', () => {
    const listener = vi.fn()
    const stop = subscribeSnapScale(listener)
    settleSnapScale({ zoom: 0.5, dpr: 2 })
    settleSnapScale({ zoom: 0.5, dpr: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(snapScale()).toEqual({ zoom: 0.5, dpr: 2 })
    settleSnapScale({ zoom: 0.5, dpr: 1 })
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    settleSnapScale({ zoom: 2, dpr: 1 })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
