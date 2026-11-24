import { bleed, frameHeight, frameWidth } from './bleed'
import { matrixOf, px } from './cssValues'
import { isLocked } from './dom'
import type { Rect, Scale, Size } from './types'

/* Where elements are and how they are turned and scaled, in design px:
   this document's own CSS px, which the canvas zoom never reaches (the
   iframe element undoes the world's CSS zoom), so in here the viewport,
   vh/vw and every rect stay at design size. */

export interface ElementGeometry {
  x: number | null
  y: number | null
  rotation: number | null
  scaleX: number
  scaleY: number
  enabled: boolean
  canAlign: boolean
}

/** the element's positional selector: the editor's own selection language */
export function cssPath(el: Element | null): string {
  const parts: string[] = []
  while (el && el.nodeType === 1 && el !== document.documentElement) {
    if (el.id) {
      parts.unshift('#' + CSS.escape(el.id))
      break
    }
    const tag = el.tagName.toLowerCase()
    let nth = 1
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName === el.tagName) nth++
    }
    parts.unshift(tag + ':nth-of-type(' + nth + ')')
    el = el.parentElement
  }
  return parts.join(' > ')
}

export function designRect(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left - bleed, y: r.top - bleed, width: r.width, height: r.height }
}

/* The element's own turn, in degrees clockwise: its rotate property plus
   the angle its transform carries, when that transform is a plain 2D turn
   (a scale may ride along; a skew, a flip or a 3D turn makes it null). The
   stage's grips and rotate zones follow this angle. */
export function ownRotation(el: Element): number | null {
  const cs = getComputedStyle(el)
  if (cs.rotate !== 'none' && !/^-?[\d.]+deg$/.test(cs.rotate)) return null
  const turn = cs.rotate === 'none' ? 0 : parseFloat(cs.rotate)
  if (cs.transform === 'none') return turn
  const p = matrixOf(cs.transform)
  if (!p) return null
  const [a = NaN, b = NaN, c = NaN, d = NaN] = p
  if (!(a * d - b * c > 0) || Math.abs(a * c + b * d) > 1e-6 * (a * a + b * b)) return null
  return px(String(turn + (Math.atan2(b, a) * 180) / Math.PI))
}

/* Elements whose box takes a width/height: everything but inline text
   boxes. Replaced inline elements (an img) still size, so they count. */
const REPLACED = ['img', 'video', 'canvas', 'svg', 'iframe', 'input', 'select', 'textarea', 'button', 'embed', 'object']

export function sizable(el: Element): boolean {
  const cs = getComputedStyle(el)
  if (cs.display === 'contents' || cs.display === 'none') return false
  /* Screen deltas can only resize boxes whose axes the stage can follow:
     the element's own turn it turns the deltas by, so a plain 2D turn of
     its own is fine, but a turned, skewed or 3D ancestor is not.
     Unequal ancestor scales also skew a turn: the rectangular grips and
     rotate gesture cannot follow that affine transform, even if the
     element starts straight. */
  for (let node: Element | null = el; node; node = node.parentElement) {
    const transform = getComputedStyle(node)
    if (transform.perspective !== 'none' || transform.transform.indexOf('matrix3d') === 0) return false
    if (transform.scale !== 'none') {
      const scales = transform.scale.split(/\s+/).map(parseFloat)
      if (scales.length > 2 || scales.some((value) => value <= 0)) return false
    }
    if (node === el) {
      if (ownRotation(el) === null) return false
      continue
    }
    const parentScale = ownScale(node)
    if (Math.abs(parentScale.x - parentScale.y) > 1e-6 * Math.max(parentScale.x, parentScale.y)) return false
    if (transform.rotate !== 'none' && parseFloat(transform.rotate.split(/\s+/).pop()!) !== 0) return false
    const parts = matrixOf(transform.transform)
    if (parts) {
      const [a = NaN, b = NaN, c = NaN, d = NaN] = parts
      if (a <= 0 || d <= 0 || Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) return false
    }
  }
  return cs.display !== 'inline' || REPLACED.indexOf(el.tagName.toLowerCase()) !== -1
}

/* the element's own scale, each way: its scale property times the
   length of its transform's columns (a turn-and-scale matrix keeps them
   orthogonal, so each column is one axis's scale) */
export function ownScale(el: Element): Scale {
  const cs = getComputedStyle(el)
  const scale = cs.scale === 'none' ? [1, 1] : cs.scale.split(/\s+/).map(parseFloat)
  let sx = scale[0]!
  let sy = scale[1] === undefined ? scale[0]! : scale[1]
  const p = matrixOf(cs.transform)
  if (p) {
    const [a = NaN, b = NaN, c = NaN, d = NaN] = p
    sx *= Math.hypot(a, b)
    sy *= Math.hypot(c, d)
  }
  return { x: sx, y: sy }
}

/* how far the rendered box is from the layout box: the element's own and
   its ancestors' scale, which a drag's pointer delta has to be divided by.
   A turned element's bounds are wider than its box: the scale is read off
   the width those bounds would have at this turn, as one factor both ways */
export function renderScale(el: Element, rect: Rect): Scale {
  const { offsetWidth: w, offsetHeight: h } = el as HTMLElement
  const turn = ownRotation(el) || 0
  if (turn && w > 0) {
    /* the bounds' width is the turned box's span: the element's own scale
       each way, turned, times whatever its ancestors scale it by */
    const own = ownScale(el)
    const rad = (turn * Math.PI) / 180
    const span = w * own.x * Math.abs(Math.cos(rad)) + h * own.y * Math.abs(Math.sin(rad))
    const k = span > 0 && rect.width > 0 ? rect.width / span : 1
    return { x: k * own.x, y: k * own.y }
  }
  return { x: w > 0 && rect.width > 0 ? rect.width / w : 1, y: h > 0 && rect.height > 0 ? rect.height / h : 1 }
}

/* the element's rendered box before its own turn: what the selection
   furniture is drawn around, turned by ownRotation about the centre of
   rect (its rendered bounds) */
export function renderedBox(el: Element, rect: Rect): Size {
  const { offsetWidth: w, offsetHeight: h } = el as HTMLElement
  if (!(w > 0) || !(h > 0)) return { width: rect.width, height: rect.height }
  const s = renderScale(el, rect)
  return { width: w * s.x, height: h * s.y }
}

export function parentBounds(el: Element): Rect {
  const p = el.parentElement
  // The body's containing canvas is the viewport, even when all children are absolute.
  return p === document.body || !p || p === document.documentElement
    ? { x: 0, y: 0, width: frameWidth(), height: frameHeight() }
    : designRect(p)
}

export function elementGeometry(el: Element): ElementGeometry {
  const cs = getComputedStyle(el)
  const rect = designRect(el)
  const bounds = parentBounds(el)
  const matrix = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform)
  const rotation = cs.rotate === 'none' ? 0 : parseFloat(cs.rotate)
  const scale = cs.scale === 'none' ? [1, 1] : cs.scale.split(' ').map(Number)
  let enabled =
    !isLocked(el) &&
    matrix.is2D &&
    (cs.rotate === 'none' || /^-?[\d.]+deg$/.test(cs.rotate)) &&
    scale.length <= 2 &&
    (cs.display !== 'inline' ||
      /^(IMG|VIDEO|IFRAME|CANVAS|OBJECT|EMBED)$/.test(el.tagName) ||
      el instanceof SVGSVGElement) &&
    cs.display !== 'contents' &&
    cs.display !== 'none' &&
    (el instanceof HTMLElement || el instanceof SVGSVGElement)
  // A perspective ancestor makes translation non-linear; don't offer 2D geometry there.
  for (let p = el.parentElement; enabled && p; p = p.parentElement) {
    const ps = getComputedStyle(p)
    if (
      ps.perspective !== 'none' ||
      !new DOMMatrix(ps.transform === 'none' ? undefined : ps.transform).is2D ||
      (ps.rotate !== 'none' && !/^-?[\d.]+deg$/.test(ps.rotate))
    )
      enabled = false
  }
  return {
    x: px(String(rect.x - bounds.x)),
    y: px(String(rect.y - bounds.y)),
    rotation: px(String(rotation + (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI)),
    scaleX: scale[0]!,
    scaleY: scale[1] === undefined ? scale[0]! : scale[1],
    enabled,
    canAlign: enabled && el !== document.body && !!el.parentElement,
  }
}
