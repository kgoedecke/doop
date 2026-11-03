/**
 * SVG geometry with no DOM layout behind it: the full path grammar, the basic
 * shapes, transform lists and affine matrices. An import bakes every shape of
 * a file into absolute line and cubic segments through these, and the path
 * editor reads any `d` an agent or a file wrote through the same parser.
 */
import type { PathPoint, Point } from './drawing'

/** Column-major 2D affine matrix, as SVG and CSS write it: `[a b c d e f]`. */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** One stroke of a path: the anchors in order, with their cubic handles. */
export interface Subpath {
  points: PathPoint[]
  closed: boolean
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** `multiply(m, n)` applies `n` first, then `m`, as `m.multiply(n)` does on DOMMatrix. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}

export function translation(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y]
}

export function scaling(x: number, y = x): Matrix {
  return [x, 0, 0, y, 0, 0]
}

/** How much a matrix scales lengths on average: what a stroke width becomes. */
export function lengthScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
}

function finite(values: number[]): boolean {
  return values.every((value) => Number.isFinite(value))
}

const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?(?:px|deg|rad|grad|turn)?/g

/** An SVG `transform` list (or the CSS `transform` property's functions),
 *  composed left to right into one matrix; `null` when it cannot be read. */
export function parseTransform(value: string | null | undefined): Matrix | null {
  if (!value) return IDENTITY
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'none') return IDENTITY
  let matrix = IDENTITY
  const fn = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  let consumed = 0
  for (let match = fn.exec(trimmed); match; match = fn.exec(trimmed)) {
    if (trimmed.slice(consumed, match.index).replace(/[\s,]/g, '')) return null
    consumed = match.index + match[0].length
    const raw = (match[2] ?? '').match(NUMBER) ?? []
    const args = raw.map((token) => angle(token))
    if (!finite(args)) return null
    const next = transformFunction(match[1] ?? '', args)
    if (!next) return null
    matrix = multiply(matrix, next)
  }
  if (trimmed.slice(consumed).replace(/[\s,]/g, '')) return null
  return matrix
}

/** Angles in CSS units become degrees; plain numbers stay as they are. */
function angle(token: string): number {
  const value = parseFloat(token)
  if (token.endsWith('grad')) return value * 0.9
  if (token.endsWith('rad')) return (value * 180) / Math.PI
  if (token.endsWith('turn')) return value * 360
  return value
}

function transformFunction(name: string, args: number[]): Matrix | null {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = args
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  switch (name) {
    case 'matrix':
      return args.length === 6 ? [a, b, c, d, e, f] : null
    case 'translate':
      return args.length === 1 || args.length === 2 ? translation(a, b) : null
    case 'translateX':
      return args.length === 1 ? translation(a, 0) : null
    case 'translateY':
      return args.length === 1 ? translation(0, a) : null
    case 'scale':
      return args.length === 1 ? scaling(a) : args.length === 2 ? scaling(a, b) : null
    case 'scaleX':
      return args.length === 1 ? scaling(a, 1) : null
    case 'scaleY':
      return args.length === 1 ? scaling(1, a) : null
    case 'rotate': {
      if (args.length !== 1 && args.length !== 3) return null
      const cos = Math.cos(radians(a))
      const sin = Math.sin(radians(a))
      const rotation: Matrix = [cos, sin, -sin, cos, 0, 0]
      return args.length === 3 ? multiply(multiply(translation(b, c), rotation), translation(-b, -c)) : rotation
    }
    case 'skewX':
      return args.length === 1 ? [1, 0, Math.tan(radians(a)), 1, 0, 0] : null
    case 'skewY':
      return args.length === 1 ? [1, Math.tan(radians(a)), 0, 1, 0, 0] : null
    default:
      return null
  }
}

/* ---- the path grammar ---- */

class Scanner {
  private index = 0
  constructor(private readonly text: string) {}

  skipSeparators() {
    while (this.index < this.text.length && /[\s,]/.test(this.text[this.index]!)) this.index++
  }

  done(): boolean {
    this.skipSeparators()
    return this.index >= this.text.length
  }

  command(): string | null {
    this.skipSeparators()
    const char = this.text[this.index]
    if (char && /[MmZzLlHhVvCcSsQqTtAa]/.test(char)) {
      this.index++
      return char
    }
    return null
  }

  /** The next number, or null when the text has none here. */
  number(): number | null {
    this.skipSeparators()
    const rest = this.text.slice(this.index)
    const match = /^[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/.exec(rest)
    if (!match || !match[0]) return null
    this.index += match[0].length
    const value = Number(match[0])
    return Number.isFinite(value) ? value : null
  }

  /** An arc flag is a single `0` or `1`, which optimisers write without separators. */
  flag(): number | null {
    this.skipSeparators()
    const char = this.text[this.index]
    if (char !== '0' && char !== '1') return null
    this.index++
    return Number(char)
  }

  startsNumber(): boolean {
    this.skipSeparators()
    const char = this.text[this.index]
    return !!char && /[-+.\d]/.test(char)
  }
}

/** Parse any `d` attribute into absolute subpaths of line and cubic segments:
 *  relative commands, `H`/`V`, smooth curves, quadratics and arcs all become
 *  anchors with handles. `null` when the data is malformed or draws nothing. */
export function parsePathData(data: string): Subpath[] | null {
  const scanner = new Scanner(data)
  const subpaths: Subpath[] = []
  let current: Subpath | null = null
  let cursor: Point = { x: 0, y: 0 }
  let start: Point = { x: 0, y: 0 }
  /* the last cubic/quadratic control point, for S and T reflections (kept
     on an object: the closures below assign it, which narrowing cannot see) */
  const last: { cubic: Point | null; quad: Point | null } = { cubic: null, quad: null }
  let command: string | null = null

  const relative = (c: string) => c === c.toLowerCase()
  const point = (c: string): Point | null => {
    const x = scanner.number()
    const y = scanner.number()
    if (x === null || y === null) return null
    return relative(c) ? { x: cursor.x + x, y: cursor.y + y } : { x, y }
  }
  const lineTo = (to: Point) => {
    if (!current) return false
    current.points.push({ x: to.x, y: to.y })
    cursor = to
    last.cubic = last.quad = null
    return true
  }
  const cubicTo = (a: Point, b: Point, to: Point) => {
    if (!current) return false
    const from = current.points.at(-1)!
    if (a.x !== from.x || a.y !== from.y) from.handleOut = { x: a.x - from.x, y: a.y - from.y }
    const next: PathPoint = { x: to.x, y: to.y }
    if (b.x !== to.x || b.y !== to.y) next.handleIn = { x: b.x - to.x, y: b.y - to.y }
    current.points.push(next)
    cursor = to
    last.cubic = b
    last.quad = null
    return true
  }
  const quadTo = (control: Point, to: Point) => {
    const from = cursor
    const a = { x: from.x + (2 / 3) * (control.x - from.x), y: from.y + (2 / 3) * (control.y - from.y) }
    const b = { x: to.x + (2 / 3) * (control.x - to.x), y: to.y + (2 / 3) * (control.y - to.y) }
    if (!cubicTo(a, b, to)) return false
    last.quad = control
    last.cubic = null
    return true
  }
  const closeSubpath = () => {
    if (!current) return false
    current.closed = true
    cursor = start
    current = null
    last.cubic = last.quad = null
    return true
  }
  const openSubpath = (at: Point) => {
    current = { points: [{ x: at.x, y: at.y }], closed: false }
    subpaths.push(current)
    cursor = start = at
    last.cubic = last.quad = null
  }
  /* a segment after a closepath continues from the closed subpath's start */
  const continueFrom = () => {
    if (!current) openSubpath(cursor)
  }

  while (!scanner.done()) {
    const next = scanner.command()
    if (next) command = next
    else if (!command || !scanner.startsNumber() || command === 'Z' || command === 'z') return null
    /* a bare pair right after a moveto is an implicit lineto; other
       commands repeat as they are */
    else if (command === 'M' || command === 'm') command = command === 'M' ? 'L' : 'l'
    /* a path begins with a moveto, or it is no path */
    if (!subpaths.length && command !== 'M' && command !== 'm') return null
    switch (command) {
      case 'M':
      case 'm': {
        const to = point(command)
        if (!to) return null
        openSubpath(to)
        break
      }
      case 'Z':
      case 'z':
        if (!current) return null
        closeSubpath()
        break
      case 'L':
      case 'l': {
        continueFrom()
        const to = point(command)
        if (!to || !lineTo(to)) return null
        break
      }
      case 'H':
      case 'h': {
        continueFrom()
        const x = scanner.number()
        if (x === null) return null
        lineTo({ x: relative(command) ? cursor.x + x : x, y: cursor.y })
        break
      }
      case 'V':
      case 'v': {
        continueFrom()
        const y = scanner.number()
        if (y === null) return null
        lineTo({ x: cursor.x, y: relative(command) ? cursor.y + y : y })
        break
      }
      case 'C':
      case 'c': {
        continueFrom()
        const a = point(command)
        const b = a && point(command)
        const to = b && point(command)
        if (!a || !b || !to) return null
        cubicTo(a, b, to)
        break
      }
      case 'S':
      case 's': {
        continueFrom()
        const reflected = last.cubic ? { x: 2 * cursor.x - last.cubic.x, y: 2 * cursor.y - last.cubic.y } : cursor
        const b = point(command)
        const to = b && point(command)
        if (!b || !to) return null
        cubicTo(reflected, b, to)
        break
      }
      case 'Q':
      case 'q': {
        continueFrom()
        const control = point(command)
        const to = control && point(command)
        if (!control || !to) return null
        quadTo(control, to)
        break
      }
      case 'T':
      case 't': {
        continueFrom()
        const control = last.quad ? { x: 2 * cursor.x - last.quad.x, y: 2 * cursor.y - last.quad.y } : cursor
        const to = point(command)
        if (!to) return null
        quadTo(control, to)
        break
      }
      case 'A':
      case 'a': {
        continueFrom()
        const rx = scanner.number()
        const ry = scanner.number()
        const rotation = scanner.number()
        const large = scanner.flag()
        const sweep = scanner.flag()
        const to = point(command)
        if (rx === null || ry === null || rotation === null || large === null || sweep === null || !to) return null
        const from = cursor
        for (const [a, b, end] of arcToCubics(from, rx, ry, rotation, !!large, !!sweep, to)) cubicTo(a, b, end)
        /* a smooth curve after an arc starts straight: the arc's generated
           handles are nothing to reflect */
        last.cubic = last.quad = null
        break
      }
      default:
        return null
    }
  }
  const drawn = subpaths.map(mergeClosingPoint).filter((subpath) => subpath.points.length >= 2)
  return drawn.length ? drawn : null
}

/** A closed subpath whose last anchor sits on its first keeps one anchor,
 *  carrying the incoming handle over, the way the pen writes it. */
function mergeClosingPoint(subpath: Subpath): Subpath {
  const first = subpath.points[0]
  const last = subpath.points.at(-1)
  if (!subpath.closed || subpath.points.length <= 2 || !first || !last || first === last) return subpath
  if (Math.abs(first.x - last.x) > 1e-9 || Math.abs(first.y - last.y) > 1e-9) return subpath
  const merged: PathPoint = { ...first }
  if (last.handleIn) merged.handleIn = last.handleIn
  else delete merged.handleIn
  return { closed: true, points: [merged, ...subpath.points.slice(1, -1)] }
}

/** The endpoint arc of SVG as cubic Béziers of at most a quarter turn each. */
export function arcToCubics(
  from: Point,
  rx: number,
  ry: number,
  rotationDegrees: number,
  largeArc: boolean,
  sweep: boolean,
  to: Point,
): [Point, Point, Point][] {
  if (from.x === to.x && from.y === to.y) return []
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (rx === 0 || ry === 0) return [[from, to, to]]
  const phi = (rotationDegrees * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (from.x - to.x) / 2
  const dy = (from.y - to.y) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const sign = largeArc === sweep ? -1 : 1
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const coefficient = sign * Math.sqrt(Math.max(0, numerator / denominator))
  const cx1 = (coefficient * rx * y1) / ry
  const cy1 = (-coefficient * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2
  const angleOf = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const length = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let value = Math.acos(Math.min(1, Math.max(-1, dot / length)))
    if (ux * vy - uy * vx < 0) value = -value
    return value
  }
  const theta = angleOf(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
  let delta = angleOf((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9))
  const step = delta / segments
  const k = (4 / 3) * Math.tan(step / 4)
  const curves: [Point, Point, Point][] = []
  const onArc = (t: number): Point => ({
    x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  })
  const tangent = (t: number): Point => ({
    x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  })
  for (let i = 0; i < segments; i++) {
    const t1 = theta + i * step
    const t2 = t1 + step
    const p1 = i === 0 ? from : onArc(t1)
    const p2 = i === segments - 1 ? to : onArc(t2)
    const d1 = tangent(t1)
    const d2 = tangent(t2)
    curves.push([{ x: p1.x + k * d1.x, y: p1.y + k * d1.y }, { x: p2.x - k * d2.x, y: p2.y - k * d2.y }, p2])
  }
  return curves
}

/* ---- lengths ---- */

const UNITS: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
  em: 16,
  rem: 16,
}

/** A length with its unit resolved to px; a percentage against `reference`
 *  (the viewport's width, height or diagonal), or null without one. */
export function parseLength(value: string | null | undefined, reference?: number): number | null {
  if (!value) return null
  const match = /^\s*([-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value)
  if (!match) return null
  const number = Number(match[1])
  if (!Number.isFinite(number)) return null
  const unit = (match[2] ?? '').toLowerCase()
  if (unit === '%') return reference === undefined ? null : (number / 100) * reference
  return number * (UNITS[unit] ?? 1)
}

/* ---- the basic shapes ---- */

/** The viewport a shape's percentages refer to. */
export interface Viewport {
  width: number
  height: number
}

/** Percent references by axis: x-ish lengths against the width, y-ish
 *  against the height, a radius against the normalised diagonal. */
function reference(name: string, viewport?: Viewport): number | undefined {
  if (!viewport) return undefined
  if (/^(x\d?|cx|width|rx)$/.test(name)) return viewport.width
  if (/^(y\d?|cy|height|ry)$/.test(name)) return viewport.height
  return Math.sqrt((viewport.width ** 2 + viewport.height ** 2) / 2)
}

function attribute(el: Element, name: string, viewport?: Viewport, fallback = 0): number {
  const raw = el.getAttribute(name)
  if (raw === null || raw.trim() === '') return fallback
  return parseLength(raw, reference(name, viewport)) ?? fallback
}

/** A basic shape or path element as subpaths in its own user space, or null
 *  when the element is not a shape or its geometry is unreadable. Lengths
 *  with units become px; percentages resolve against `viewport`. */
export function shapeToSubpaths(el: Element, viewport?: Viewport): Subpath[] | null {
  switch (el.localName) {
    case 'path':
      return parsePathData(el.getAttribute('d') ?? '')
    case 'rect':
      return rectSubpaths(el, viewport)
    case 'circle': {
      const r = attribute(el, 'r', viewport)
      return r > 0 ? [ellipseSubpath(attribute(el, 'cx', viewport), attribute(el, 'cy', viewport), r, r)] : null
    }
    case 'ellipse': {
      const rx = attribute(el, 'rx', viewport)
      const ry = attribute(el, 'ry', viewport)
      return rx > 0 && ry > 0
        ? [ellipseSubpath(attribute(el, 'cx', viewport), attribute(el, 'cy', viewport), rx, ry)]
        : null
    }
    case 'line':
      return [
        {
          points: [
            { x: attribute(el, 'x1', viewport), y: attribute(el, 'y1', viewport) },
            { x: attribute(el, 'x2', viewport), y: attribute(el, 'y2', viewport) },
          ],
          closed: false,
        },
      ]
    case 'polyline':
    case 'polygon': {
      const numbers = (el.getAttribute('points') ?? '').match(NUMBER)?.map(Number) ?? []
      const points: PathPoint[] = []
      for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i]!, y: numbers[i + 1]! })
      if (points.length < 2 || !finite(numbers)) return null
      return [{ points, closed: el.localName === 'polygon' }]
    }
    default:
      return null
  }
}

function rectSubpaths(el: Element, viewport?: Viewport): Subpath[] | null {
  const x = attribute(el, 'x', viewport)
  const y = attribute(el, 'y', viewport)
  const width = attribute(el, 'width', viewport)
  const height = attribute(el, 'height', viewport)
  if (width <= 0 || height <= 0) return null
  let rx = el.hasAttribute('rx') ? attribute(el, 'rx', viewport, -1) : -1
  let ry = el.hasAttribute('ry') ? attribute(el, 'ry', viewport, -1) : -1
  if (rx < 0 && ry < 0) rx = ry = 0
  else if (rx < 0) rx = ry
  else if (ry < 0) ry = rx
  rx = Math.min(rx, width / 2)
  ry = Math.min(ry, height / 2)
  if (rx <= 0 || ry <= 0) {
    return [
      {
        closed: true,
        points: [
          { x, y },
          { x: x + width, y },
          { x: x + width, y: y + height },
          { x, y: y + height },
        ],
      },
    ]
  }
  /* each corner is a quarter ellipse: the kappa handles of a circular arc */
  const k = 0.5522847498
  const hx = { x: rx * k, y: 0 }
  const hy = { x: 0, y: ry * k }
  const points: PathPoint[] = [
    { x: x + rx, y },
    { x: x + width - rx, y, handleOut: hx },
    { x: x + width, y: y + ry, handleIn: { x: 0, y: -hy.y } },
    { x: x + width, y: y + height - ry, handleOut: hy },
    { x: x + width - rx, y: y + height, handleIn: hx },
    { x: x + rx, y: y + height, handleOut: { x: -hx.x, y: 0 } },
    { x, y: y + height - ry, handleIn: hy },
    { x, y: y + ry, handleOut: { x: 0, y: -hy.y } },
  ]
  points[0]!.handleIn = { x: -hx.x, y: 0 }
  return [{ points: dropStraightDuplicates(points), closed: true }]
}

/** A rounded rectangle whose radius spans a whole side has coincident anchors. */
function dropStraightDuplicates(points: PathPoint[]): PathPoint[] {
  return points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length]!
    if (point.x !== previous.x || point.y !== previous.y) return true
    previous.handleOut = point.handleOut
    return false
  })
}

function ellipseSubpath(cx: number, cy: number, rx: number, ry: number): Subpath {
  const k = 0.5522847498
  return {
    closed: true,
    points: [
      { x: cx + rx, y: cy, handleIn: { x: 0, y: -ry * k }, handleOut: { x: 0, y: ry * k } },
      { x: cx, y: cy + ry, handleIn: { x: rx * k, y: 0 }, handleOut: { x: -rx * k, y: 0 } },
      { x: cx - rx, y: cy, handleIn: { x: 0, y: ry * k }, handleOut: { x: 0, y: -ry * k } },
      { x: cx, y: cy - ry, handleIn: { x: -rx * k, y: 0 }, handleOut: { x: rx * k, y: 0 } },
    ],
  }
}

/* ---- geometry over subpaths ---- */

function mapVector(m: Matrix, v: Point): Point {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y }
}

/** Affine maps keep Bézier control points, so a transform moves anchors and handles alike. */
export function transformSubpaths(subpaths: Subpath[], m: Matrix): Subpath[] {
  return subpaths.map((subpath) => ({
    closed: subpath.closed,
    points: subpath.points.map((point) => {
      const next: PathPoint = { ...apply(m, point) }
      if (point.handleIn) next.handleIn = mapVector(m, point.handleIn)
      if (point.handleOut) next.handleOut = mapVector(m, point.handleOut)
      if (point.handle) next.handle = mapVector(m, point.handle)
      return next
    }),
  }))
}

export function controlPoints(from: PathPoint, to: PathPoint): [Point, Point] {
  return [
    { x: from.x + (from.handleOut?.x ?? from.handle?.x ?? 0), y: from.y + (from.handleOut?.y ?? from.handle?.y ?? 0) },
    { x: to.x + (to.handleIn?.x ?? -(to.handle?.x ?? 0)), y: to.y + (to.handleIn?.y ?? -(to.handle?.y ?? 0)) },
  ]
}

export function isCurved(from: PathPoint, to: PathPoint): boolean {
  return !!(from.handle || to.handle || from.handleOut || to.handleIn)
}

/** The segments of a subpath as `[from, to]` anchor pairs, the closing one included. */
export function segments(subpath: Subpath): [PathPoint, PathPoint][] {
  const out: [PathPoint, PathPoint][] = []
  const count = subpath.points.length
  for (let i = 1; i < count + (subpath.closed ? 1 : 0); i++)
    out.push([subpath.points[i - 1]!, subpath.points[i % count]!])
  return out
}

/** A point along a segment; a straight one runs linearly in `t`, so a split
 *  lands where the pointer is. */
export function pointOnSegment(from: PathPoint, to: PathPoint, t: number): Point {
  if (!isCurved(from, to)) return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
  const [a, b] = controlPoints(from, to)
  const u = 1 - t
  return {
    x: u ** 3 * from.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t ** 3 * to.x,
    y: u ** 3 * from.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t ** 3 * to.y,
  }
}

/** The tight box around the ink of the subpaths (cubic extrema, not handles), or null when empty. */
export function subpathsBounds(subpaths: Subpath[]): Box | null {
  const xs: number[] = []
  const ys: number[] = []
  for (const subpath of subpaths) {
    for (const point of subpath.points) {
      xs.push(point.x)
      ys.push(point.y)
    }
    for (const [from, to] of segments(subpath)) {
      if (!isCurved(from, to)) continue
      const [a, b] = controlPoints(from, to)
      for (const axis of ['x', 'y'] as const) {
        const p = -from[axis] + 3 * a[axis] - 3 * b[axis] + to[axis]
        const q = 2 * (from[axis] - 2 * a[axis] + b[axis])
        const r = a[axis] - from[axis]
        const discriminant = q * q - 4 * p * r
        const roots =
          Math.abs(p) < 1e-9
            ? Math.abs(q) < 1e-9
              ? []
              : [-r / q]
            : discriminant < 0
              ? []
              : [(-q + Math.sqrt(discriminant)) / (2 * p), (-q - Math.sqrt(discriminant)) / (2 * p)]
        for (const t of roots) {
          if (t <= 0 || t >= 1) continue
          const at = pointOnSegment(from, to, t)
          xs.push(at.x)
          ys.push(at.y)
        }
      }
    }
  }
  if (!xs.length) return null
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** The box `pad` beyond the ink, the selection box a shape's SVG gets. */
export function paddedBounds(subpaths: Subpath[], pad: number): Box {
  const bounds = subpathsBounds(subpaths) ?? { x: 0, y: 0, width: 0, height: 0 }
  return { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + 2 * pad, height: bounds.height + 2 * pad }
}

/** What a shape's box needs beyond its anchors: the pen's two px, or half a wider stroke. */
export function strokePad(strokeWidth: string | number): number {
  const width = typeof strokeWidth === 'number' ? strokeWidth : parseFloat(strokeWidth) || 0
  return Math.max(2, width / 2)
}

export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100
}

/** Absolute `M/L/C/Z` data, the form the pen writes, shifted by `origin`. */
export function subpathsData(subpaths: Subpath[], origin: Point = { x: 0, y: 0 }): string {
  const at = (p: Point) => `${roundCoordinate(p.x - origin.x)} ${roundCoordinate(p.y - origin.y)}`
  const commands: string[] = []
  for (const subpath of subpaths) {
    const first = subpath.points[0]
    if (!first) continue
    commands.push(`M ${at(first)}`)
    const count = subpath.points.length
    for (let i = 1; i < count + (subpath.closed ? 1 : 0); i++) {
      const from = subpath.points[i - 1]!
      const to = subpath.points[i % count]!
      if (isCurved(from, to)) {
        const [a, b] = controlPoints(from, to)
        commands.push(`C ${at(a)} ${at(b)} ${at(to)}`)
      } else if (i < count) commands.push(`L ${at(to)}`)
    }
    if (subpath.closed) commands.push('Z')
  }
  return commands.join(' ')
}

/** Split a segment at `t` (de Casteljau), returning the three anchors that
 *  replace its two: a line stays straight, a curve keeps its shape. */
export function splitSegment(from: PathPoint, to: PathPoint, t: number): [PathPoint, PathPoint, PathPoint] {
  const start: PathPoint = { x: from.x, y: from.y }
  if (from.handleIn) start.handleIn = from.handleIn
  const end: PathPoint = { x: to.x, y: to.y }
  if (to.handleOut) end.handleOut = to.handleOut
  if (!isCurved(from, to)) {
    return [start, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, end]
  }
  const [a, b] = controlPoints(from, to)
  const lerp = (p: Point, q: Point): Point => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const ab = lerp(from, a)
  const bc = lerp(a, b)
  const cd = lerp(b, to)
  const abc = lerp(ab, bc)
  const bcd = lerp(bc, cd)
  const mid = lerp(abc, bcd)
  start.handleOut = { x: ab.x - from.x, y: ab.y - from.y }
  end.handleIn = { x: cd.x - to.x, y: cd.y - to.y }
  return [
    start,
    { ...mid, handleIn: { x: abc.x - mid.x, y: abc.y - mid.y }, handleOut: { x: bcd.x - mid.x, y: bcd.y - mid.y } },
    end,
  ]
}

/** The parameter along a segment closest to a point, by sampling then refining. */
export function nearestT(from: PathPoint, to: PathPoint, at: Point): { t: number; distance: number } {
  let best = { t: 0, distance: Infinity }
  const consider = (t: number) => {
    const p = pointOnSegment(from, to, t)
    const distance = Math.hypot(p.x - at.x, p.y - at.y)
    if (distance < best.distance) best = { t, distance }
  }
  for (let i = 0; i <= 32; i++) consider(i / 32)
  let step = 1 / 64
  for (let i = 0; i < 20; i++) {
    const t = best.t
    consider(Math.max(0, t - step))
    consider(Math.min(1, t + step))
    step /= 2
  }
  return best
}
