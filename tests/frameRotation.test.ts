import { describe, expect, it } from 'vitest'
import {
  ROTATION_SNAP_DEG,
  frameDesignPoint,
  frameTurnMatrix,
  frameWorldPoint,
  normalizeRotation,
  pointerAngle,
  rotateVector,
  rotatedBounds,
  rotatedBy,
  unrotatePoint,
} from '../shared/frameRotation'
import { ROTATE_CORNERS, rotateCursor, rotateCursorAngle, rotateZoneSide } from '../src/lib/frameRotate'

describe('normalizeRotation', () => {
  it('keeps a turn in (-180, 180] and drops zero', () => {
    expect(normalizeRotation(45)).toBe(45)
    expect(normalizeRotation(-45)).toBe(-45)
    expect(normalizeRotation(180)).toBe(180)
    expect(normalizeRotation(-180)).toBe(180)
    expect(normalizeRotation(270)).toBe(-90)
    expect(normalizeRotation(-270)).toBe(90)
    expect(normalizeRotation(725)).toBe(5)
    expect(normalizeRotation(0)).toBeUndefined()
    expect(normalizeRotation(360)).toBeUndefined()
    expect(normalizeRotation(-0)).toBeUndefined()
  })
  it('rounds to a hundredth of a degree', () => {
    expect(normalizeRotation(12.3456)).toBe(12.35)
    expect(normalizeRotation(0.001)).toBeUndefined()
  })
  it('refuses anything that is not a finite number', () => {
    expect(normalizeRotation(NaN)).toBeUndefined()
    expect(normalizeRotation(Infinity)).toBeUndefined()
    expect(normalizeRotation('90')).toBeUndefined()
    expect(normalizeRotation(null)).toBeUndefined()
    expect(normalizeRotation(undefined)).toBeUndefined()
  })
})

describe('pointerAngle', () => {
  const center = { x: 100, y: 100 }
  it('counts clockwise from the positive x axis in screen space', () => {
    expect(pointerAngle(center, { x: 200, y: 100 })).toBe(0)
    expect(pointerAngle(center, { x: 100, y: 200 })).toBe(90)
    expect(pointerAngle(center, { x: 0, y: 100 })).toBe(180)
    expect(pointerAngle(center, { x: 100, y: 0 })).toBe(-90)
  })
})

describe('rotatedBy', () => {
  it('adds how far the pointer swung to the rotation at the press', () => {
    expect(rotatedBy(0, 45, 135)).toBe(90)
    expect(rotatedBy(30, 45, 135)).toBe(120)
    expect(rotatedBy(0, 135, 45)).toBe(-90)
  })
  it('wraps across the ±180 seam', () => {
    expect(rotatedBy(170, 0, 20)).toBe(-170)
    expect(rotatedBy(-170, 0, -20)).toBe(170)
  })
  it('snaps to multiples of fifteen degrees with Shift', () => {
    expect(rotatedBy(0, 0, 22, { snap: true })).toBe(ROTATION_SNAP_DEG)
    expect(rotatedBy(0, 0, 23, { snap: true })).toBe(2 * ROTATION_SNAP_DEG)
    expect(rotatedBy(10, 0, 4, { snap: true })).toBe(ROTATION_SNAP_DEG)
    expect(rotatedBy(0, 0, 3, { snap: true })).toBe(0)
  })
})

describe('rotatedBounds', () => {
  const rect = { x: 100, y: 50, width: 200, height: 100 }
  it('is the rect itself unturned and swaps the sides at a quarter turn', () => {
    expect(rotatedBounds(rect, 0)).toEqual(rect)
    const quarter = rotatedBounds(rect, 90)
    expect(quarter.width).toBeCloseTo(100)
    expect(quarter.height).toBeCloseTo(200)
    expect(quarter.x).toBeCloseTo(150)
    expect(quarter.y).toBeCloseTo(0)
  })
  it('keeps the centre and grows the box between', () => {
    const b = rotatedBounds(rect, 45)
    expect(b.x + b.width / 2).toBeCloseTo(200)
    expect(b.y + b.height / 2).toBeCloseTo(100)
    expect(b.width).toBeCloseTo((200 + 100) / Math.SQRT2)
    expect(b.height).toBeCloseTo((200 + 100) / Math.SQRT2)
  })
})

describe('unrotatePoint', () => {
  const size = { width: 200, height: 100 }
  it('is the plain offset when nothing is turned', () => {
    const bounds = { left: 10, top: 20, width: 200, height: 100 }
    expect(unrotatePoint({ x: 60, y: 45 }, bounds, size, 0)).toEqual({ x: 50, y: 25 })
  })
  it('turns a press back into the design of a frame turned a quarter', () => {
    /* a 200×100 frame turned 90° about (110, 70) covers a 100×200 box */
    const bounds = { left: 60, top: -30, width: 100, height: 200 }
    /* its top-left design corner now sits at the box's top-right */
    const corner = unrotatePoint({ x: 160, y: -30 }, bounds, size, 90)
    expect(corner.x).toBeCloseTo(0)
    expect(corner.y).toBeCloseTo(0)
    const centre = unrotatePoint({ x: 110, y: 70 }, bounds, size, 90)
    expect(centre.x).toBeCloseTo(100)
    expect(centre.y).toBeCloseTo(50)
  })
})

describe('rotate zones', () => {
  it('sit outside each corner, away from the frame', () => {
    expect(ROTATE_CORNERS).toEqual(['nw', 'ne', 'se', 'sw'])
    expect(rotateZoneSide('nw')).toEqual({ x: -1, y: -1 })
    expect(rotateZoneSide('ne')).toEqual({ x: 1, y: -1 })
    expect(rotateZoneSide('se')).toEqual({ x: 1, y: 1 })
    expect(rotateZoneSide('sw')).toEqual({ x: -1, y: 1 })
  })
  it('turn the cursor glyph with the corner and the frame', () => {
    expect(rotateCursorAngle('ne', 0)).toBe(0)
    expect(rotateCursorAngle('se', 0)).toBe(90)
    expect(rotateCursorAngle('sw', 0)).toBe(180)
    expect(rotateCursorAngle('nw', 0)).toBe(270)
    expect(rotateCursorAngle('sw', 100)).toBe(280)
    expect(rotateCursorAngle('ne', -30)).toBe(330)
  })
  it('draw a tagged image cursor with a keyword fallback, one image per whole degree', () => {
    const cursor = rotateCursor('se', 0)
    expect(cursor.startsWith('url("data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(cursor.endsWith('") 12 12, grab')).toBe(true)
    expect(decodeURIComponent(cursor)).toContain(`data-cursor="rotate"`)
    expect(decodeURIComponent(cursor)).toContain('rotate(90 12 12)')
    expect(rotateCursor('se', 0.3)).toBe(cursor)
    expect(rotateCursor('nw', 180)).toBe(cursor)
    expect(rotateCursor('se', 1)).not.toBe(cursor)
  })
})

describe('a turned frame on the canvas', () => {
  const frame = { x: 100, y: 50, width: 200, height: 100, rotation: 90 }
  it('turns a vector clockwise', () => {
    const v = rotateVector({ x: 10, y: 0 }, 90)
    expect(v.x).toBeCloseTo(0)
    expect(v.y).toBeCloseTo(10)
    expect(rotateVector({ x: 3, y: 4 }, 0)).toEqual({ x: 3, y: 4 })
  })
  it('maps a world point into the design and back', () => {
    /* the centre stays the centre */
    const c = frameDesignPoint({ x: 200, y: 100 }, frame)
    expect(c.x).toBeCloseTo(100)
    expect(c.y).toBeCloseTo(50)
    /* a quarter turn puts the design's top-left corner at the canvas's top-right of the turned box */
    const corner = frameWorldPoint({ x: 0, y: 0 }, frame)
    expect(corner.x).toBeCloseTo(250)
    expect(corner.y).toBeCloseTo(0)
    const back = frameDesignPoint(corner, frame)
    expect(back.x).toBeCloseTo(0)
    expect(back.y).toBeCloseTo(0)
    expect(frameDesignPoint({ x: 130, y: 70 }, { ...frame, rotation: 0 })).toEqual({ x: 30, y: 20 })
  })
  it('is the identity matrix unturned and turns about the centre otherwise', () => {
    expect(frameTurnMatrix({ ...frame, rotation: 0 })).toEqual([1, 0, 0, 1, 0, 0])
    const [a, b, c, d, e, f] = frameTurnMatrix(frame)
    const at = (p: { x: number; y: number }) => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f })
    const centre = at({ x: 200, y: 100 })
    expect(centre.x).toBeCloseTo(200)
    expect(centre.y).toBeCloseTo(100)
    const corner = at({ x: 100, y: 50 })
    expect(corner.x).toBeCloseTo(250)
    expect(corner.y).toBeCloseTo(0)
  })
})
