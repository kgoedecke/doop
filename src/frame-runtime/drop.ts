import type { LayoutDrop, PlacementOrigin } from '../lib/frameBridge'
import type { DropPlace, DropTarget, FlowPlacement } from '../lib/layers'
import { frameHeight, frameWidth, viewX } from './bleed'
import { isLocked, styleTarget } from './dom'
import { cssPath, designRect, renderScale } from './geometry'
import type { Rect } from './types'

/* Where a dragged layer lands: worked out inside the sandboxed frame, where
   browser layout and hit testing are available. The parent draws the result
   and commits through the layer editor. */

const NOT_LAYERS = ['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE']
const CONTAINERS = [
  'BODY',
  'DIV',
  'SECTION',
  'MAIN',
  'ARTICLE',
  'ASIDE',
  'HEADER',
  'FOOTER',
  'NAV',
  'FORM',
  'FIELDSET',
  'LI',
  'DT',
  'DD',
  'TD',
  'TH',
  'FIGURE',
  'FIGCAPTION',
]

export interface MoveTarget {
  free: boolean
  drop: LayoutDrop | null
}

interface DropAxes {
  horizontal: boolean
  reverse: boolean
  wrapped: boolean
}

function dropContainer(el: Element | null, source: Element): boolean {
  if (!el || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || isLocked(el)) return false
  if (el === source || source.contains(el)) return false
  // a group made on the canvas holds layers; other drawings are leaves
  const drawing = el.getAttribute('data-doop-drawing')
  if (drawing !== null && drawing !== 'group') return false
  if (el.tagName === 'UL' || el.tagName === 'OL') return source.tagName === 'LI'
  if (el.tagName === 'DL') return source.tagName === 'DT' || source.tagName === 'DD'
  return CONTAINERS.indexOf(el.tagName) !== -1 && getComputedStyle(el).display !== 'contents'
}

function dropAxes(parent: Element): DropAxes {
  const cs = getComputedStyle(parent)
  const vertical = cs.writingMode.indexOf('vertical') === 0
  const flex = cs.display.indexOf('flex') !== -1
  const grid = cs.display.indexOf('grid') !== -1
  const row = flex ? cs.flexDirection.indexOf('row') === 0 : grid && cs.gridAutoFlow.indexOf('column') !== 0
  const horizontal = row ? !vertical : vertical
  let reverse = row ? cs.direction === 'rtl' : cs.writingMode === 'vertical-rl'
  if (flex && cs.flexDirection.indexOf('reverse') !== -1) reverse = !reverse
  return { horizontal, reverse, wrapped: grid || (flex && cs.flexWrap !== 'nowrap') }
}

// A rotated/skewed layout needs polygon guides. Keep its existing free move
// behavior rather than displaying an axis-aligned insertion bar in the wrong place.
function straightLayout(el: Element | null): boolean {
  for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
    const cs = getComputedStyle(node)
    const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform)
    if (!m.is2D || Math.abs(m.b) > 0.000001 || Math.abs(m.c) > 0.000001 || m.a <= 0 || m.d <= 0) return false
    if (cs.rotate !== 'none' && parseFloat(cs.rotate) !== 0) return false
  }
  return true
}

function inFlow(el: Element): boolean {
  if (NOT_LAYERS.indexOf(el.tagName) !== -1) return false
  const cs = getComputedStyle(el)
  return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed'
}

/* A box that places its layers by hand, as a design tool's plain frame
   does: no flex or grid, nothing in flow but the moving layer, and it is
   the frame's body, a canvas group, or already holds a layer placed
   absolute (a drawn frame, a pinned group). A layer dropped there is
   placed absolute where it was let go, not put in a flow it does not
   have. An empty card on a page still takes a drop in flow. */
function freeform(el: Element, source: Element): boolean {
  const display = getComputedStyle(el).display
  if (display.indexOf('flex') !== -1 || display.indexOf('grid') !== -1) return false
  const others = Array.prototype.filter.call(el.children, (child: Element) => {
    return child !== source && !child.contains(source) && NOT_LAYERS.indexOf(child.tagName) === -1
  }) as Element[]
  if (others.some(inFlow)) return false
  return el === document.body || el.getAttribute('data-doop-drawing') === 'group' || others.length > 0
}

/* the corner an absolute child of the parent is placed from, in design px,
   and the scale it is drawn at */
export function placementOrigin(parent: Element): PlacementOrigin {
  for (let cb: Element | null = parent; cb && cb !== document.documentElement; cb = cb.parentElement) {
    const cs = getComputedStyle(cb)
    if (cs.position !== 'static' || cs.transform !== 'none' || /paint|layout|strict|content/.test(cs.contain)) {
      const r = designRect(cb)
      const scale = renderScale(cb, r)
      return {
        x: r.x + (parseFloat(cs.borderLeftWidth) || 0) * scale.x,
        y: r.y + (parseFloat(cs.borderTopWidth) || 0) * scale.y,
        scale,
      }
    }
  }
  // the initial containing block: the document's own corner
  return { x: -scrollX, y: -scrollY, scale: { x: 1, y: 1 } }
}

/* at: where the layer is drawn, when the drag shows a copy of it and
   leaves the layer itself where it was */
function absoluteDrop(parent: Element, source: HTMLElement, at?: Rect | null): LayoutDrop {
  const origin = placementOrigin(parent)
  const rect = at || designRect(source)
  const cs = getComputedStyle(source)
  const width = source.offsetWidth !== undefined ? source.offsetWidth : parseFloat(cs.width) || 0
  const height = source.offsetHeight !== undefined ? source.offsetHeight : parseFloat(cs.height) || 0
  // by the centre, which a turn or scale about it leaves where it is; the
  // move its transform makes stays with it, so it is not counted twice
  // (its translate is the drag's, which the drop replaces)
  const shift = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform)
  const cx = (rect.x + rect.width / 2 - origin.x) / origin.scale.x - shift.e
  const cy = (rect.y + rect.height / 2 - origin.y) / origin.scale.y - shift.f
  let last: Element | null = null
  for (let i = parent.children.length - 1; i >= 0 && !last; i--) {
    const child = parent.children[i]!
    if (child !== source && NOT_LAYERS.indexOf(child.tagName) === -1) last = child
  }
  const bounds = designRect(parent)
  return {
    // on top of what the box already holds
    target: last ? { selector: cssPath(last), place: 'after' } : { selector: cssPath(parent), place: 'inside' },
    styles: {
      order: cs.order,
      absolute: {
        left: Math.round(cx - width / 2 - (parseFloat(cs.marginLeft) || 0)),
        top: Math.round(cy - height / 2 - (parseFloat(cs.marginTop) || 0)),
      },
    },
    container: bounds,
    line: null,
    reparent: parent !== source.parentElement && parent !== document.body,
  }
}

/* How a layer moved from the Layers panel sits in its new box, the way a
   canvas drag would put it: a flow item in a flex or grid box, placed
   absolute where it shows now in a box that places its layers by hand,
   and left as authored anywhere else (null). */
export function layerPlacement(selector: unknown, target: DropTarget | null | undefined): FlowPlacement | null {
  const source = styleTarget(selector)
  const at = target && styleTarget(target.selector)
  if (!source || !at || isLocked(source)) return null
  const parent = target.place === 'inside' ? at : at.parentElement
  if (!parent || parent === source || source.contains(parent)) return null
  const display = getComputedStyle(parent).display
  const position = getComputedStyle(source).position
  const floating = position === 'absolute' || position === 'fixed'
  if (display.indexOf('flex') !== -1 || display.indexOf('grid') !== -1) {
    return floating ? { order: '0', flexItem: display.indexOf('flex') !== -1 } : null
  }
  if (!freeform(parent, source)) return null
  // the box's own layers stay put when only their order changes
  if (floating && parent === source.parentElement) return null
  return absoluteDrop(parent, source as HTMLElement).styles
}

interface Slot {
  selector: string
  place: DropPlace
  line: Rect
  order: string
}

export function moveTarget(selector: unknown, x: number, y: number, at: Rect | null | undefined): MoveTarget {
  const source = styleTarget(selector)
  const empty: MoveTarget = { free: false, drop: null }
  if (!source || isLocked(source)) return empty
  const position = getComputedStyle(source).position
  const floating = position === 'absolute' || position === 'fixed'
  if (!straightLayout(source.parentElement)) return { free: true, drop: null }
  if (x < 0 || y < 0 || x >= frameWidth() || y >= frameHeight()) return { free: floating, drop: null }
  const stack = document.elementsFromPoint(viewX(x), viewX(y))
  let hit: Element | null = null
  for (const candidate of stack) {
    if (!source.contains(candidate)) {
      hit = candidate
      break
    }
  }
  if (!hit || isLocked(hit)) return empty
  if (hit === document.documentElement) hit = document.body
  let parent: Element | null = hit
  while (parent && !dropContainer(parent, source)) parent = parent.parentElement
  if (!parent) return empty
  // Near a container's edge, offer a sibling slot; its center accepts children.
  if (parent === hit && parent !== source.parentElement && parent !== document.body) {
    const outer = parent.parentElement
    if (dropContainer(outer, source)) {
      const edgeAxes = dropAxes(outer!)
      const r = designRect(parent)
      const coordinate = edgeAxes.horizontal ? x : y
      const start = edgeAxes.horizontal ? r.x : r.y
      const size = edgeAxes.horizontal ? r.width : r.height
      const edge = Math.min(12, size * 0.2)
      if (coordinate - start < edge || start + size - coordinate < edge) parent = outer!
    }
  }
  if (floating && parent === source.parentElement) return { free: true, drop: null }
  if (!straightLayout(parent)) return empty
  if (freeform(parent, source)) return { free: false, drop: absoluteDrop(parent, source as HTMLElement, at) }
  const axes = dropAxes(parent)
  const bounds = designRect(parent)
  const children = Array.prototype.filter.call(parent.children, (el: Element) => {
    if (el === source || NOT_LAYERS.indexOf(el.tagName) !== -1) return false
    const cs = getComputedStyle(el)
    const rect = designRect(el)
    return (
      cs.display !== 'none' &&
      cs.visibility !== 'hidden' &&
      cs.position !== 'absolute' &&
      cs.position !== 'fixed' &&
      rect.width > 0 &&
      rect.height > 0
    )
  }) as Element[]
  let best: Slot | null = null
  let distance = Infinity
  children.forEach((child) => {
    const rect = designRect(child)
    const start = axes.horizontal ? rect.x : rect.y
    const length = axes.horizontal ? rect.width : rect.height
    const crossStart = axes.horizontal ? rect.y : rect.x
    const crossLength = axes.horizontal ? rect.height : rect.width
    const main = axes.horizontal ? x : y
    const cross = axes.horizontal ? y : x
    ;(['before', 'after'] as const).forEach((place) => {
      const end = (place === 'after') !== axes.reverse
      const edge = start + (end ? length : 0)
      const crossDistance = Math.max(crossStart - cross, 0, cross - crossStart - crossLength)
      const score = Math.abs(main - edge) + crossDistance * 4
      if (score >= distance) return
      distance = score
      const line = axes.horizontal
        ? { x: edge, y: axes.wrapped ? rect.y : bounds.y, width: 0, height: axes.wrapped ? rect.height : bounds.height }
        : { x: axes.wrapped ? rect.x : bounds.x, y: edge, width: axes.wrapped ? rect.width : bounds.width, height: 0 }
      best = { selector: cssPath(child), place, line, order: getComputedStyle(child).order }
    })
  })
  const slot: Slot = best ?? insideSlot(parent, bounds, axes)
  const styles: FlowPlacement = {
    order: slot.order,
    orderChanged: getComputedStyle(source).order !== slot.order,
    fromFlow: !floating,
    flexItem: getComputedStyle(parent).display.indexOf('flex') !== -1,
  }
  const transform = getComputedStyle(source).transform
  if (transform !== 'none') {
    const matrix = new DOMMatrix(transform)
    if (matrix.m41 || matrix.m42 || matrix.m43) {
      matrix.m41 = matrix.m42 = matrix.m43 = 0
      styles.transform = matrix.isIdentity ? 'none' : matrix.toString()
    }
  }
  return {
    free: false,
    drop: {
      target: { selector: slot.selector, place: slot.place },
      styles,
      container: bounds,
      line: slot.line,
      reparent: parent !== source.parentElement,
    },
  }
}

/* a box with no layer to stand beside: the slot at the start of its content */
function insideSlot(parent: Element, bounds: Rect, axes: DropAxes): Slot {
  const cs = getComputedStyle(parent)
  const scale = renderScale(parent, bounds)
  const left = bounds.x + ((parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0)) * scale.x
  const top = bounds.y + ((parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0)) * scale.y
  const right =
    bounds.x + bounds.width - ((parseFloat(cs.borderRightWidth) || 0) + (parseFloat(cs.paddingRight) || 0)) * scale.x
  const bottom =
    bounds.y + bounds.height - ((parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.paddingBottom) || 0)) * scale.y
  return {
    selector: cssPath(parent),
    place: 'inside',
    order: '0',
    line: axes.horizontal
      ? { x: axes.reverse ? right : left, y: top, width: 0, height: Math.max(20, bottom - top) }
      : { x: left, y: axes.reverse ? bottom : top, width: Math.max(20, right - left), height: 0 },
  }
}
