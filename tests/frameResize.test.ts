import { describe, expect, it } from 'vitest'
import { MIN_FRAME_SIZE, keepRatioAfterSnap, movingEdges, resizeFrameRect } from '../src/lib/frameResize'
import { snapFrame } from '../src/lib/snap'
import type { CanvasGuide } from '../shared/types'

const orig = { x: 100, y: 50, width: 200, height: 100 }
const guide = (axis: 'v' | 'h', at: number): CanvasGuide => ({ id: `${axis}${at}`, pageId: 'p', axis, at })

describe('resizeFrameRect', () => {
  it('grows the far edges from a south-east pull and keeps the origin', () => {
    expect(resizeFrameRect('se', orig, { dx: 30, dy: 20 })).toEqual({ x: 100, y: 50, width: 230, height: 120 })
    expect(resizeFrameRect('e', orig, { dx: 30, dy: 20 })).toEqual({ x: 100, y: 50, width: 230, height: 100 })
    expect(resizeFrameRect('s', orig, { dx: 30, dy: 20 })).toEqual({ x: 100, y: 50, width: 200, height: 120 })
  })
  it('moves a west or north edge and leaves the opposite one still', () => {
    expect(resizeFrameRect('w', orig, { dx: -30, dy: 0 })).toEqual({ x: 70, y: 50, width: 230, height: 100 })
    expect(resizeFrameRect('n', orig, { dx: 0, dy: 20 })).toEqual({ x: 100, y: 70, width: 200, height: 80 })
    expect(resizeFrameRect('nw', orig, { dx: 10, dy: -10 })).toEqual({ x: 110, y: 40, width: 190, height: 110 })
    expect(resizeFrameRect('sw', orig, { dx: -10, dy: 10 })).toEqual({ x: 90, y: 50, width: 210, height: 110 })
    expect(resizeFrameRect('ne', orig, { dx: 10, dy: -10 })).toEqual({ x: 100, y: 40, width: 210, height: 110 })
  })
  it('lets a frame shrink to a single pixel but never past it', () => {
    expect(resizeFrameRect('se', orig, { dx: -199, dy: -99 })).toEqual({ x: 100, y: 50, width: 1, height: 1 })
    const collapsed = resizeFrameRect('nw', orig, { dx: 500, dy: 500 })
    expect(collapsed).toEqual({ x: 299, y: 149, width: MIN_FRAME_SIZE, height: MIN_FRAME_SIZE })
  })
  it('keeps the aspect ratio with Shift', () => {
    expect(resizeFrameRect('e', orig, { dx: 100, dy: 0 }, { keepRatio: true })).toEqual({
      x: 100,
      y: 50,
      width: 300,
      height: 150,
    })
  })
})

describe('movingEdges', () => {
  it('names the edge each handle drags', () => {
    expect(movingEdges('se')).toEqual({ x: 'end', y: 'end' })
    expect(movingEdges('nw')).toEqual({ x: 'start', y: 'start' })
    expect(movingEdges('e')).toEqual({ x: 'end', y: null })
    expect(movingEdges('n')).toEqual({ x: null, y: 'start' })
  })
})

describe('snapFrame on a resize', () => {
  it('snaps the dragged west edge and carries the position', () => {
    const snapped = snapFrame('resize', { x: 103, y: 50, width: 197, height: 100 }, [], 1, [guide('v', 100)], 'w')
    expect(snapped).toMatchObject({ x: 100, width: 200, height: 100 })
  })
  it('snaps the dragged north edge', () => {
    const snapped = snapFrame('resize', { x: 100, y: 46, width: 200, height: 104 }, [], 1, [guide('h', 50)], 'n')
    expect(snapped).toMatchObject({ y: 50, height: 100 })
  })
  it('ignores the axis a handle does not drag', () => {
    const snapped = snapFrame('resize', { x: 100, y: 50, width: 197, height: 103 }, [], 1, [guide('h', 150)], 'e')
    expect(snapped).toMatchObject({ width: 197, height: 103, guides: [] })
  })
  it('lets a tiny frame stay tiny', () => {
    const snapped = snapFrame('resize', { x: 0, y: 0, width: 3, height: 3 }, [], 1, [guide('v', 1)], 'se')
    expect(snapped).toMatchObject({ width: 1, height: 3 })
  })
})

describe('keepRatioAfterSnap', () => {
  const vGuide = { axis: 'v' as const, at: 75, from: 0, to: 100 }
  const hGuide = { axis: 'h' as const, at: 0, from: 0, to: 100 }
  it('lets a snapped width lead and re-derives the height', () => {
    const raw = resizeFrameRect('w', orig, { dx: -30, dy: 0 }, { keepRatio: true })
    expect(raw).toEqual({ x: 70, y: 50, width: 230, height: 115 })
    const snapped = { ...raw, x: 75, width: 225, guides: [vGuide, hGuide] }
    expect(keepRatioAfterSnap('w', orig, raw, snapped)).toEqual({
      x: 75,
      y: 50,
      width: 225,
      height: 113,
      guides: [vGuide],
    })
  })
  it('lets a snapped height lead and re-anchors a north edge', () => {
    const raw = resizeFrameRect('nw', orig, { dx: -20, dy: -10 }, { keepRatio: true })
    const snapped = { ...raw, height: raw.height + 4, y: raw.y - 4, guides: [hGuide] }
    const kept = keepRatioAfterSnap('nw', orig, raw, snapped)
    expect(kept.height).toBe(raw.height + 4)
    expect(kept.width).toBe(Math.round(kept.height * 2))
    expect(kept.x + kept.width).toBe(orig.x + orig.width)
    expect(kept.y + kept.height).toBe(orig.y + orig.height)
  })
  it('leaves an unsnapped rect alone', () => {
    const raw = resizeFrameRect('se', orig, { dx: 10, dy: 0 }, { keepRatio: true })
    expect(keepRatioAfterSnap('se', orig, raw, { ...raw, guides: [] })).toEqual({ ...raw, guides: [] })
  })
})
