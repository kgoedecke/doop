import { describe, expect, it } from 'vitest'
import { guideDelta, snapFrame, snapPointToGuides } from '../src/lib/snap'
import { parseGuide, sameGuide } from '../shared/guides'
import type { CanvasGuide, Frame } from '../shared/types'

const guide = (axis: 'v' | 'h', at: number, id = `${axis}${at}`): CanvasGuide => ({ id, pageId: 'p', axis, at })
const frame = (x: number, y: number, width: number, height: number): Frame => ({
  id: `f${x}`,
  canvasId: 'c',
  name: 'F',
  x,
  y,
  width,
  height,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'T',
})

describe('snapFrame with ruler guides', () => {
  it('pulls a moving frame edge onto a guide within the screen tolerance', () => {
    const moved = snapFrame('move', { x: 205, y: 0, width: 100, height: 100 }, [], 1, [guide('v', 200)])
    expect(moved.x).toBe(200)
    expect(moved.guides).toEqual([{ axis: 'v', at: 200, from: 0, to: 100 }])
  })

  it('snaps the far edge and the centre, too', () => {
    expect(snapFrame('move', { x: 96, y: 0, width: 100, height: 100 }, [], 1, [guide('v', 200)]).x).toBe(100)
    expect(snapFrame('move', { x: 0, y: 147, width: 100, height: 100 }, [], 1, [guide('h', 200)]).y).toBe(150)
  })

  it('scales the tolerance with the zoom', () => {
    /* 8 screen px: 16 world px at 50%, 4 at 200% */
    expect(snapFrame('move', { x: 212, y: 0, width: 100, height: 100 }, [], 0.5, [guide('v', 200)]).x).toBe(200)
    expect(snapFrame('move', { x: 206, y: 0, width: 100, height: 100 }, [], 2, [guide('v', 200)]).x).toBe(206)
  })

  it('takes whichever is closer, a guide or another frame', () => {
    const others = [frame(0, 500, 203, 50)]
    const near = snapFrame('move', { x: 205, y: 0, width: 100, height: 100 }, others, 1, [guide('v', 200)])
    expect(near.x).toBe(203)
    expect(near.guides[0]).toMatchObject({ axis: 'v', at: 203, from: 0, to: 550 })
  })

  it('snaps the right and bottom edges of a resize', () => {
    const resized = snapFrame('resize', { x: 0, y: 0, width: 296, height: 203 }, [], 1, [
      guide('v', 300),
      guide('h', 200),
    ])
    expect(resized).toMatchObject({ width: 300, height: 200 })
  })

  it('ignores guides of the other axis', () => {
    expect(snapFrame('move', { x: 205, y: 0, width: 100, height: 100 }, [], 1, [guide('h', 200)]).x).toBe(205)
  })
})

describe('guideDelta and snapPointToGuides', () => {
  const guides = [guide('v', 100), guide('v', 110), guide('h', -40)]
  it('moves a value onto the nearest guide in range', () => {
    expect(guideDelta(104, guides, 'v', 1)).toBe(-4)
    expect(guideDelta(106, guides, 'v', 1)).toBe(4)
    expect(guideDelta(140, guides, 'v', 1)).toBe(0)
  })

  it('snaps both coordinates of a point independently', () => {
    expect(snapPointToGuides({ x: 97, y: -45 }, guides, 1)).toEqual({ x: 100, y: -40 })
    expect(snapPointToGuides({ x: 50, y: -45 }, guides, 1)).toEqual({ x: 50, y: -40 })
  })
})

describe('parseGuide', () => {
  it('accepts a guide on a known page and rounds its position', () => {
    expect(parseGuide('g1', { pageId: 'p', axis: 'h', at: 10.123 }, ['p'])).toEqual({
      id: 'g1',
      pageId: 'p',
      axis: 'h',
      at: 10.12,
    })
  })

  it('rejects malformed guides', () => {
    expect(typeof parseGuide('bad id!', { pageId: 'p', axis: 'h', at: 0 }, ['p'])).toBe('string')
    expect(typeof parseGuide('g', { pageId: 'p', axis: 'x', at: 0 }, ['p'])).toBe('string')
    expect(typeof parseGuide('g', { pageId: 'p', axis: 'v', at: Number.NaN }, ['p'])).toBe('string')
    expect(typeof parseGuide('g', { pageId: 'p', axis: 'v', at: 2e6 }, ['p'])).toBe('string')
    expect(parseGuide('g', { pageId: 'other', axis: 'v', at: 0 }, ['p'])).toBe('page not found')
  })

  it('compares guides by value', () => {
    expect(sameGuide(guide('v', 1), guide('v', 1))).toBe(true)
    expect(sameGuide(guide('v', 1), { ...guide('v', 1), at: 2 })).toBe(false)
    expect(sameGuide(null, undefined)).toBe(true)
    expect(sameGuide(null, guide('v', 1))).toBe(false)
  })
})
