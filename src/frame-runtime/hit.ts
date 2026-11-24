import type { ElementMeasure } from '../lib/frameBridge'
import { viewX } from './bleed'
import { isLocked, styleTarget } from './dom'
import { editing } from './edit'
import { cssPath, designRect, elementGeometry, ownRotation, parentBounds, renderedBox, sizable } from './geometry'
import type { Rect, Size } from './types'

/* What is under a point, and what a click there picks. The parent can't see
   into this sandboxed document, so it asks: probe resolves the element at a
   point (for the click toolbar), describe finds a selector's element (the
   Layers panel). Ask the browser which element is actually on top,
   including stacking contexts, clipping, and transformed hit regions. */

/** the element summary the stage selects, outlines and grips by */
export interface HitInfo {
  selector: string
  /** the stable id comments and links use, when something has stamped one */
  elementId: string | undefined
  tag: string
  text: string
  snippet: string
  rect: Rect
  /** the stage's resize grips: shown only where a drag can change the box */
  sizable: boolean
  /** Unsupported transforms use the axis-aligned bounds for selection. */
  rotation: number
  box: Size
  locked: boolean
  snapRects?: Rect[]
}

export interface DrawingHit {
  selector: string
  rect: Rect
  snapRects: Rect[]
  geometry: {
    width: number
    height: number
    offsetX: number
    offsetY: number
    styles: Record<string, string>
  }
}

export interface HoverHit {
  tag: string
  selector: string
  rect: Rect
  href: string | null
  linkRect: Rect | null
}

/** the editor's picked layers: one selector, or every selector of a multi-pick */
export type Selected = unknown

function selectorList(selected: Selected): unknown[] {
  return Array.isArray(selected) ? selected : selected ? [selected] : []
}

export function hitInfo(el: Element): HitInfo {
  let snippet = el.outerHTML || ''
  if (snippet.length > 400) snippet = snippet.slice(0, 397) + '...'
  const canSize = sizable(el)
  return {
    selector: cssPath(el),
    elementId: el.getAttribute('data-doop-id') || undefined,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    snippet,
    rect: designRect(el),
    sizable: canSize,
    rotation: canSize ? ownRotation(el) || 0 : 0,
    box: renderedBox(el, designRect(el)),
    locked: isLocked(el),
  }
}

/* what a moved element lines up with: its parent box and the visible
   elements beside it (the frame itself is the stage's to add) */
function snapRects(el: Element): Rect[] {
  const parent = el.parentElement
  if (!parent) return []
  const rects = parent === document.body || parent === document.documentElement ? [] : [designRect(parent)]
  for (let i = 0; i < parent.children.length && rects.length < 80; i++) {
    const sibling = parent.children[i]!
    if (sibling === el || sibling.hasAttribute('data-doop-defs')) continue
    if (getComputedStyle(sibling).visibility !== 'visible') continue
    const r = designRect(sibling)
    if (r.width > 0 && r.height > 0) rects.push(r)
  }
  return rects
}

/* the picked element that holds the element pressed, so a press on a child
   moves the pick */
function pickedAround(selected: Selected, el: Element): HTMLElement | null {
  for (const selector of selectorList(selected)) {
    const picked = styleTarget(selector)
    if (picked && picked !== el && picked.contains(el) && !isLocked(picked)) return picked
  }
  return null
}

/* the picked layer the point is on itself, not inside */
function pickedAt(selected: Selected, el: Element): HTMLElement | null {
  const selectors: unknown[] = Array.isArray(selected) ? selected : []
  for (let i = 0; i < selectors.length; i++) {
    const picked = styleTarget(selectors[i])
    if (picked === el && !isLocked(picked)) return picked
  }
  return null
}

/* Keep layout dimensions separate from the rendered rectangle so a move
   does not apply scale twice. */
export function drawingHit(x: number, y: number, standalone: unknown, selected: Selected): DrawingHit | null {
  // Inside an entered standalone the press is a layer's, as in a frame.
  if (standalone && enteredStandalone(selected)) return null
  const top = elementAt(x, y, selected)
  // A press inside a group drags the group, as a click there picks it.
  const el = standalone
    ? document.body.firstElementChild
    : top && groupLevel(top.closest('[data-doop-drawing]:not([data-doop-drawing="group"])') || top, selected, false)
  if (!el || !el.matches('[data-doop-drawing]') || isLocked(el)) return null
  // A drawing inside a box (a group) moves as a layer: its box may lay it
  // out, and a drop reorders it there or places it where it lands.
  if (!standalone && el.parentElement !== document.body) return null
  const picked = pickedAround(selected, el)
  if (!standalone && picked && elementGeometry(picked).enabled) return null
  // A drawing picked with other layers moves with them, through the layer
  // gesture, not on its own.
  if (
    !standalone &&
    Array.isArray(selected) &&
    selected.length > 1 &&
    elementGeometry(el).enabled &&
    selected.some((sel) => styleTarget(sel) === el)
  )
    return null
  const rect = designRect(el)
  const css = getComputedStyle(el)
  const width = parseFloat(css.width)
  const height = parseFloat(css.height)
  if (!isFinite(width) || !isFinite(height)) return null
  const styles: Record<string, string> = {}
  const properties = ['transform', 'transform-origin', 'translate', 'rotate', 'scale', 'box-sizing']
  properties.forEach((key) => {
    styles[key] = css.getPropertyValue(key)
  })
  const drawn = el as HTMLElement
  const originalStyle = drawn.getAttribute('style')
  let untransformed: Rect
  try {
    // This measurement is synchronous; the temporary styles never paint.
    ;['transform', 'translate', 'rotate', 'scale', 'transition'].forEach((key) => {
      drawn.style.setProperty(key, 'none', 'important')
    })
    untransformed = designRect(drawn)
  } finally {
    if (originalStyle === null) drawn.removeAttribute('style')
    else drawn.setAttribute('style', originalStyle)
  }
  return {
    selector: cssPath(el),
    rect,
    snapRects: snapRects(el),
    geometry: {
      width,
      height,
      offsetX: rect.x - untransformed.x,
      offsetY: rect.y - untransformed.y,
      styles,
    },
  }
}

/* a standalone element (a shape on the canvas with no frame around it)
   is one thing to point at: whatever is under the pointer, the hit is
   its root, until a double-click enters it the way a group is entered */
function standaloneRoot(): Element | null {
  if (editing || !document.body.hasAttribute('data-doop-canvas-element')) return null
  return document.body.firstElementChild
}

/* a layer inside the standalone's root is picked: the root has been
   entered, so a press inside it is at that level, as in a group */
function enteredStandalone(selected: Selected): boolean {
  const root = standaloneRoot()
  if (!root) return false
  return selectorList(selected).some((sel) => {
    const picked = styleTarget(sel)
    return !!picked && picked !== root && root.contains(picked)
  })
}

/* the topmost unlocked element under a design-space point: a click on a
   locked element falls through to whatever sits beneath it, as in Figma */
function elementAt(x: number, y: number, selected: Selected): Element | null {
  const stack = document.elementsFromPoint(viewX(x), viewX(y))
  const root = enteredStandalone(selected) ? null : standaloneRoot()
  for (let el of stack) {
    if (el === document.documentElement || el === document.body) return null
    if (root && root.contains(el)) el = root
    if (!isLocked(el)) return el
  }
  return null
}

/* Groups pick as a whole, as in a design tool: a click lands on the
   outermost group around the hit, unless something inside that group is
   already picked, which puts the click at that level (the picked layer's
   siblings). Deeper (a double-click) steps one level into a picked
   group. Only groups made on the canvas (⌘G, ⇧A, an SVG import) count. */
function groupLevel(el: Element, selected: Selected, deeper: boolean): Element {
  const chain = [el]
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (p.matches('[data-doop-drawing="group"]') && !isLocked(p)) chain.unshift(p)
  }
  // a press sends the one picked layer as a string, several as a list
  const picked = (Array.isArray(selected) ? selected : typeof selected === 'string' ? [selected] : [])
    .map(styleTarget)
    .filter(Boolean) as Element[]
  for (let i = 0; i < chain.length - 1; i++) {
    const group = chain[i]!
    const within = picked.some((s) => s !== group && group.contains(s))
    const entering = deeper && picked.indexOf(group) !== -1
    if (!within && !entering) return group
  }
  return chain[chain.length - 1]!
}

export function probeTarget(
  x: number,
  y: number,
  grouped: boolean,
  selected: Selected,
  deeper: boolean,
): Element | null {
  let el = elementAt(x, y, selected)
  if (el) el = el.closest('[data-doop-drawing]:not([data-doop-drawing="group"])') || el
  return el && grouped ? groupLevel(el, selected, deeper) : el
}

export function probe(x: number, y: number, grouped: boolean, selected: Selected): HitInfo | null {
  const el = probeTarget(x, y, grouped, selected, false)
  return el ? hitInfo(el) : null
}

function linkAt(x: number, y: number): Element | null {
  const el = document.elementFromPoint(viewX(x), viewX(y))
  return el && el.closest('a[href]')
}

export function linkHrefAt(x: number, y: number): string | null {
  const link = linkAt(x, y)
  return link && link.getAttribute('href')
}

/* Right-click can reach a lock so the menu can unlock it. SVGs are one
   layer in the rail, and their paths share that same context menu. A
   right-click inside a layer of the multi-pick it is sent is that layer's,
   so the pick is kept and the menu acts on all of it. */
export function contextHit(x: number, y: number, selected: Selected): HitInfo | null {
  let el = document.elementFromPoint(viewX(x), viewX(y))
  if (!el || el === document.body || el === document.documentElement) return null
  const picked = pickedAt(selected, el) || pickedAround(selected, el)
  if (picked) return hitInfo(picked)
  el = el.closest('[data-doop-locked]') || el.closest('[data-doop-drawing]') || el.closest('svg') || el
  return hitInfo(el)
}

export function moveHit(x: number, y: number, selected: Selected): HitInfo | null {
  let el = elementAt(x, y, selected)
  // A selected group moves as a whole even when the press hits a child.
  const picked = el && pickedAround(selected, el)
  if (picked) el = picked
  else if (el) el = groupLevel(el, selected, false)
  while (el && el !== document.body && el !== document.documentElement) {
    if (elementGeometry(el).enabled) {
      const info = hitInfo(el)
      info.snapRects = snapRects(el)
      return info
    }
    // Inline text and SVG paths move with their containing box/SVG.
    el = el.parentElement
  }
  return null
}

/* the Layers panel selects by selector rather than by point */
export function describe(selector: unknown): HitInfo | null {
  const el = styleTarget(selector)
  if (!el || el === document.documentElement || el === document.body) return null
  return hitInfo(el)
}

/* hover inspection, fired on every (throttled) pointer move: outlines what
   a click there would pick (a drawing is hovered as a whole, the way
   probe() picks it, so the hover and the pick agree) */
export function hoverProbe(x: number, y: number, selected: Selected): HoverHit | null {
  const el = probeTarget(x, y, true, selected, false)
  if (!el) return null
  /* the link around the pointer, so the editor can outline the link itself
     (not the span inside it) while its follow modifier is held */
  const link = linkAt(x, y)
  return {
    tag: el.tagName.toLowerCase(),
    selector: cssPath(el),
    rect: designRect(el),
    href: link ? link.getAttribute('href') : null,
    linkRect: link ? designRect(link) : null,
  }
}

/* ⌥ measuring: where the picked elements are, the box around the primary
   one, and what the pointer is over when that is none of them */
export function measure(selector: unknown, x: number, y: number, selected: Selected): ElementMeasure | null {
  const picked: Element[] = []
  ;[selector].concat(Array.isArray(selected) ? selected : []).forEach((sel) => {
    const found = styleTarget(sel)
    if (found && found !== document.documentElement && found !== document.body && picked.indexOf(found) === -1)
      picked.push(found)
  })
  const el = picked[0]
  if (!el || !el.matches(selector as string)) return null
  const over = probeTarget(x, y, true, selected, false)
  return {
    rects: picked.map((p) => designRect(p)),
    parent: parentBounds(el),
    over: over && picked.indexOf(over) === -1 ? designRect(over) : null,
  }
}
