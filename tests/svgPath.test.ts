// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  apply,
  arcToCubics,
  multiply,
  nearestT,
  paddedBounds,
  parseLength,
  parsePathData,
  parseTransform,
  pointOnSegment,
  shapeToSubpaths,
  splitSegment,
  subpathsBounds,
  subpathsData,
  transformSubpaths,
  type Matrix,
} from '../src/lib/svgPath'

const svg = (markup: string) =>
  new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml')
    .documentElement.firstElementChild!

describe('path data', () => {
  it('reads absolute and relative commands, shorthands and implicit linetos', () => {
    expect(subpathsData(parsePathData('M10 10 20 10 l 0 10 H 10 v -5 Z')!)).toBe(
      'M 10 10 L 20 10 L 20 20 L 10 20 L 10 15 Z',
    )
  })
  it('turns smooth and quadratic curves into cubics with reflected handles', () => {
    const smooth = parsePathData('M 0 0 C 10 0 20 10 20 20 S 30 40 40 40')!
    const [first, second, third] = smooth[0]!.points
    expect(second!.handleOut).toEqual({ x: 0, y: 10 }) /* the reflection of (20,10) about (20,20) */
    expect(third!.handleIn).toEqual({ x: -10, y: 0 })
    expect(first!.handleOut).toEqual({ x: 10, y: 0 })
    const quad = parsePathData('M 0 0 Q 30 0 30 30 T 60 60')!
    const [, mid, end] = quad[0]!.points
    expect(mid!.handleIn).toEqual({ x: 0, y: -20 })
    expect(end!.handleIn!.x).toBeCloseTo(-20)
  })
  it('reads optimiser output: compact arc flags and numbers that share a decimal point', () => {
    const tight = parsePathData('M0 0a5 5 0 1012 0l.5.5')!
    expect(tight).toHaveLength(1)
    expect(tight[0]!.points.at(-1)).toMatchObject({ x: 12.5, y: 0.5 })
    expect(parsePathData('M1.5.5L2.5.5')![0]!.points).toEqual([
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0.5 },
    ])
  })
  it('approximates arcs with at most a quarter turn per cubic', () => {
    const half = arcToCubics({ x: 0, y: 0 }, 10, 10, 0, false, true, { x: 20, y: 0 })
    expect(half).toHaveLength(2)
    const parsed = parsePathData('M 0 0 A 10 10 0 0 1 20 0')!
    const bounds = subpathsBounds(parsed)!
    expect(bounds.y).toBeCloseTo(-10, 1)
    expect(bounds.height).toBeCloseTo(10, 1)
    const [from, to] = parsed[0]!.points
    const mid = pointOnSegment(from!, to!, 0.5)
    expect(Math.hypot(mid.x - 10, mid.y)).toBeCloseTo(10, 2)
  })
  it('starts a smooth curve after an arc with a straight handle, not the arc’s own', () => {
    const data = parsePathData('M 0 0 A 5 5 0 0 1 10 0 S 20 10 20 0')!
    const joint = data[0]!.points.at(-2)!
    expect(joint.handleOut).toBeUndefined()
  })
  it('starts a new stroke after a closepath from the closed stroke’s start', () => {
    const data = parsePathData('M 0 0 L 10 0 L 10 10 Z L 5 5')!
    expect(data).toHaveLength(2)
    expect(data[1]!.points[0]).toEqual({ x: 0, y: 0 })
  })
  it.each(['', 'L 1 1', 'M 1', 'M 1 1 A 1 1 0 2 0 3 3', 'M 1 1 L 2 2 Z 3 3', 'M 1 1 L 2 2 nope'])(
    'rejects malformed data: %s',
    (data) => expect(parsePathData(data)).toBeNull(),
  )
})

describe('basic shapes', () => {
  it('turns a rounded rect into four corner curves and squares into four corners', () => {
    const square = shapeToSubpaths(svg('<rect x="1" y="2" width="10" height="20"/>'))!
    expect(square[0]!.points).toHaveLength(4)
    expect(square[0]!.closed).toBe(true)
    const rounded = shapeToSubpaths(svg('<rect width="10" height="10" rx="2"/>'))!
    expect(rounded[0]!.points).toHaveLength(8)
    expect(subpathsBounds(rounded)).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    /* a pill: a radius spanning the whole side leaves two curves per end */
    const pill = shapeToSubpaths(svg('<rect width="20" height="10" rx="5"/>'))!
    expect(pill[0]!.points).toHaveLength(6)
  })
  it('turns circles and ellipses into four-anchor curves with the right bounds', () => {
    const circle = shapeToSubpaths(svg('<circle cx="10" cy="10" r="5"/>'))!
    expect(subpathsBounds(circle)).toEqual({ x: 5, y: 5, width: 10, height: 10 })
    const ellipse = shapeToSubpaths(svg('<ellipse cx="0" cy="0" rx="4" ry="2"/>'))!
    const bounds = subpathsBounds(ellipse)!
    expect(bounds.width).toBeCloseTo(8)
    expect(bounds.height).toBeCloseTo(4)
  })
  it('resolves units and percentages against the viewport', () => {
    const viewport = { width: 200, height: 100 }
    expect(subpathsBounds(shapeToSubpaths(svg('<rect width="100%" height="50%"/>'), viewport)!)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 50,
    })
    const circle = subpathsBounds(shapeToSubpaths(svg('<circle r="10mm"/>'), viewport)!)!
    expect(circle.width).toBeCloseTo(75.59, 1)
    expect(parseLength('1in')).toBe(96)
    expect(parseLength('50%')).toBeNull()
  })
  it('reads lines, polylines and polygons', () => {
    expect(shapeToSubpaths(svg('<line x1="0" y1="0" x2="5" y2="5"/>'))![0]!.points).toHaveLength(2)
    const polyline = shapeToSubpaths(svg('<polyline points="0,0 10,0 10,10"/>'))!
    expect(polyline[0]).toMatchObject({ closed: false })
    const polygon = shapeToSubpaths(svg('<polygon points="0 0 10 0 10 10"/>'))!
    expect(polygon[0]).toMatchObject({ closed: true })
    expect(shapeToSubpaths(svg('<rect width="0" height="5"/>'))).toBeNull()
    expect(shapeToSubpaths(svg('<text>hi</text>'))).toBeNull()
  })
})

describe('transforms', () => {
  it('composes a transform list left to right', () => {
    const m = parseTransform('translate(10, 20) scale(2)')!
    expect(apply(m, { x: 1, y: 1 })).toEqual({ x: 12, y: 22 })
    const rotated = parseTransform('rotate(90 5 5)')!
    const p = apply(rotated, { x: 10, y: 5 })
    expect(p.x).toBeCloseTo(5)
    expect(p.y).toBeCloseTo(10)
    expect(parseTransform('matrix(1 0 0 1 3 4)')).toEqual([1, 0, 0, 1, 3, 4])
    expect(parseTransform('translateX(5px) rotate(0.25turn)')).not.toBeNull()
    expect(parseTransform('none')).toEqual([1, 0, 0, 1, 0, 0])
    expect(parseTransform('skewX(45)')![2]).toBeCloseTo(1)
    /* gradians are not radians */
    expect(apply(parseTransform('rotate(100grad)')!, { x: 1, y: 0 }).y).toBeCloseTo(1)
  })
  it.each(['rotate()', 'matrix(1 2 3)', 'scale(1) junk', 'spin(4)'])('rejects %s', (value) =>
    expect(parseTransform(value)).toBeNull(),
  )
  it('moves anchors and handles alike', () => {
    const m: Matrix = multiply([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 5, 5])
    const [moved] = transformSubpaths([{ points: [{ x: 0, y: 0, handleOut: { x: 1, y: 0 } }], closed: false }], m)
    expect(moved!.points[0]).toEqual({ x: 10, y: 10, handleOut: { x: 2, y: 0 } })
  })
})

describe('editing geometry', () => {
  it('splits a line into a corner and a curve into a smooth anchor', () => {
    const [, mid] = splitSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.3)
    expect(mid).toEqual({ x: 3, y: 0 })
    const from = { x: 0, y: 0, handleOut: { x: 0, y: 10 } }
    const to = { x: 10, y: 0, handleIn: { x: 0, y: 10 } }
    const before = pointOnSegment(from, to, 0.75)
    const [start, inserted, end] = splitSegment(from, to, 0.5)
    expect(inserted.handleIn).toBeDefined()
    expect(inserted.handleOut).toBeDefined()
    /* the curve keeps its shape: a point of the old curve lies on the new halves */
    const after = pointOnSegment(inserted, end, 0.5)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(start.handleOut).toEqual({ x: 0, y: 5 })
  })
  it('finds the parameter nearest a point', () => {
    const { t, distance } = nearestT({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 2.5, y: 1 })
    expect(t).toBeCloseTo(0.25, 3)
    expect(distance).toBeCloseTo(1, 3)
  })
  it('pads the ink, not the handles', () => {
    const curve = [
      {
        points: [
          { x: 0, y: 0, handleOut: { x: 0, y: -100 } },
          { x: 10, y: 0 },
        ],
        closed: false,
      },
    ]
    const box = paddedBounds(curve, 2)
    expect(box.y).toBeCloseTo(-44.44 - 2, 1)
    expect(box.x).toBe(-2)
    expect(box.width).toBe(14)
  })
})
