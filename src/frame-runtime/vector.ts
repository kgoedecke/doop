import { px } from './cssValues'
import { patchStyle } from './styles'
import type { StylePatch } from './types'

/* A vector layer paints with SVG's fill and stroke, not the box's
   background and border: the Design panel's Fill and Stroke write these,
   and they go on the shapes themselves, where a drawn or imported path
   carries them as attributes an inherited value from the <svg> loses to. */

export interface VectorPaint {
  fill: string
  fillOpacity: number | null
  stroke: string
  strokeWidth: number | null
  inline: Record<string, string>
}

/** a patch split into the paint its vector's shapes take and the rest */
interface SplitPaint {
  shapes: SVGElement[]
  paint: StylePatch
  rest: StylePatch
}

const VECTOR_PAINT = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity']
const VECTOR_SHAPE = /^(path|rect|circle|ellipse|line|polyline|polygon)$/
const VECTOR_SKIP =
  /^(defs|clippath|mask|symbol|pattern|marker|lineargradient|radialgradient|filter|foreignobject|text)$/

export function vectorShapes(el: Element | null): SVGElement[] {
  if (!el || el.namespaceURI !== 'http://www.w3.org/2000/svg') return []
  const tag = el.tagName.toLowerCase()
  if (VECTOR_SHAPE.test(tag)) return [el as SVGElement]
  if (tag !== 'svg' && tag !== 'g') return []
  const shapes: SVGElement[] = []
  ;(function walk(node: Element) {
    for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
      const name = c.tagName.toLowerCase()
      if (VECTOR_SHAPE.test(name)) shapes.push(c as SVGElement)
      else if (!VECTOR_SKIP.test(name) && !(c.hasAttribute && c.hasAttribute('data-doop-defs'))) walk(c)
    }
  })(el)
  return shapes
}

export function vectorInfo(el: Element): VectorPaint | null {
  const shapes = vectorShapes(el)
  const first = shapes[0]
  if (!first) return null
  const scs = getComputedStyle(first)
  const inline: Record<string, string> = {}
  for (const name of VECTOR_PAINT) {
    const value = first.style.getPropertyValue(name)
    if (value) inline[name] = value
  }
  return {
    fill: scs.fill,
    fillOpacity: px(scs.fillOpacity),
    stroke: scs.stroke,
    strokeWidth: px(scs.strokeWidth),
    inline,
  }
}

/* the vector paint in a patch, taken out of it; null when there is none or
   el is no vector */
export function takeVectorPaint(el: Element, styles: StylePatch): SplitPaint | null {
  let paint: StylePatch | null = null
  const rest: StylePatch = {}
  const shapes = vectorShapes(el)
  for (const k in styles) {
    if (!Object.prototype.hasOwnProperty.call(styles, k)) continue
    if (shapes.length && VECTOR_PAINT.indexOf(k) !== -1) (paint = paint || {})[k] = styles[k]
    else rest[k] = styles[k]
  }
  return paint ? { shapes, paint, rest } : null
}

export function paintShapes(shapes: SVGElement[], paint: StylePatch): void {
  shapes.forEach((shape) => {
    patchStyle(shape, paint)
    if (!shape.getAttribute('style')) shape.removeAttribute('style')
  })
}
