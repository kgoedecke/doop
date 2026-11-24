import { bleed, viewX } from './bleed'
import { isLocked } from './dom'
import { cssPath } from './geometry'
import type { Rect } from './types'

/* Vector paths for the path editor: the one path a pen or imported shape
   draws, with the matrices that map its points to design px. */

export interface PathInfo {
  selector: string
  data: string | null
  matrix: number[]
  layoutMatrix: number[]
  paint: { fill: string; stroke: string; strokeWidth: string }
  /** a shape inside a group: where the group's box is, in the same layout px */
  parentBox?: Rect
}

/** what `doop:path` asks: a selector, or a point to find a shape at */
export interface PathQuery {
  selector?: unknown
  x: number
  y: number
}

/* the path editor and a drawing being dragged out of place draw their own
   copy over the canvas; the original stays laid out but unpainted */
let pathEditingSelector: string | null = null
let movingDrawingSelector: string | null = null

export function syncPathVisibility(): void {
  document.querySelectorAll('[data-v-path-hidden]').forEach((el) => {
    el.removeAttribute('data-v-path-hidden')
  })
  ;[pathEditingSelector, movingDrawingSelector].forEach((selector) => {
    const hidden = selector && document.querySelector(selector)
    if (hidden) hidden.setAttribute('data-v-path-hidden', '')
  })
}

export function setPathEditing(selector: string | null): void {
  pathEditingSelector = selector
  syncPathVisibility()
}

export function setMovingDrawing(selector: string | null): void {
  movingDrawingSelector = selector
  syncPathVisibility()
}

/* the topmost unlocked element under a point, a standalone's root included:
   a double-click on a shape inside an imported group edits that shape */
function vectorAt(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(viewX(x), viewX(y))) {
    if (el === document.documentElement || el === document.body) return null
    if (!isLocked(el)) return el
  }
  return null
}

/* the one path a pen or imported shape's SVG draws: its direct path child
   (a defs block beside it, for a gradient or clip, is fine) */
function shapePath(svg: Element): SVGPathElement | null {
  const paths: SVGPathElement[] = []
  for (const child of svg.children) if (child.localName === 'path') paths.push(child as SVGPathElement)
  return paths.length === 1 ? paths[0]! : null
}

export function pathInfo(d: PathQuery): PathInfo | null {
  const hit = d.selector ? document.querySelector(d.selector as string) : vectorAt(d.x, d.y)
  const svg = hit && hit.closest('svg[data-doop-drawing="path"]')
  const path = svg && shapePath(svg)
  // Native pen paths and imported shapes have one direct path child. Other SVG artwork keeps its normal editor.
  if (!svg || !path || (svg.parentElement && svg.parentElement.closest('svg')) || isLocked(svg)) return null
  let matrix = path.getScreenCTM()
  if (!matrix || Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-9) return null
  const probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  probe.setAttribute('viewBox', '0 0 1 1')
  probe.style.cssText =
    'position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;margin:0!important;padding:0!important;border:0!important;transform:none!important;translate:none!important;rotate:none!important;scale:none!important;visibility:hidden!important'
  let layout: DOMMatrix
  let page: DOMMatrix
  try {
    document.body.appendChild(probe)
    page = probe.getScreenCTM()!
    layout = page.inverse().multiply(matrix)
  } finally {
    probe.remove()
  }
  const css = getComputedStyle(path)
  matrix = matrix.translate(0, 0)
  matrix.e -= bleed
  matrix.f -= bleed
  layout.e -= bleed / page.a
  layout.f -= bleed / page.d
  const info: PathInfo = {
    selector: cssPath(svg),
    data: path.getAttribute('d'),
    matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
    layoutMatrix: [layout.a, layout.b, layout.c, layout.d, layout.e, layout.f],
    paint: { fill: css.fill, stroke: css.stroke, strokeWidth: css.strokeWidth },
  }
  if (svg.parentElement && svg.parentElement !== document.body) {
    const box = svg.parentElement.getBoundingClientRect()
    info.parentBox = {
      x: (box.left - bleed) / page.a,
      y: (box.top - bleed) / page.d,
      width: box.width / page.a,
      height: box.height / page.d,
    }
  }
  return info
}
