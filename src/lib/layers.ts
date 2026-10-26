/**
 * The Layers panel's view of a frame: the element tree of its HTML, parsed
 * on the parent side (the iframe is sandboxed, so the panel cannot walk the
 * live document). Every node carries the same selector the frame runtime
 * produces for it (frameRuntime.ts cssPath), which is what lets a row in the
 * panel and an outline in the frame refer to the same element.
 */

export type LayerKind = 'box' | 'text' | 'image' | 'svg'

export interface LayerNode {
  selector: string
  tag: string
  /** what the row shows: a text element shows its text, anything else its tag */
  label: string
  /** the first class (".hero") or id ("#nav") shown faint after the tag */
  detail: string
  kind: LayerKind
  /** switched off through the Layers panel's eye (see setElementHidden) */
  hidden: boolean
  /** carries `data-doop-locked`: the stage neither picks nor edits it */
  locked: boolean
  children: LayerNode[]
}

/** The attribute a locked layer carries in the frame's HTML. It travels with
 *  the markup, so every collaborator (and agent) sees the same lock. */
export const LOCK_ATTR = 'data-doop-locked'

/* markup that renders nothing of its own has no place in a layer list */
const HIDDEN_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR'])
const IMAGE_TAGS = new Set(['IMG', 'PICTURE', 'VIDEO', 'CANVAS'])
/* elements the rail never offers an "inside" drop on: void elements
   (serialization drops anything prepended into them), raw-text elements
   (their content is text by definition) and restricted containers whose
   children the parser rewrites — a <p> dropped into a <select> is discarded
   on the next parse, one dropped into a <table> is hoisted out of it */
const NO_INSIDE_DROP = new Set([
  'AREA',
  'BASE',
  'BR',
  'COL',
  'EMBED',
  'HR',
  'IMG',
  'INPUT',
  'LINK',
  'META',
  'SOURCE',
  'TRACK',
  'WBR',
  'TEXTAREA',
  'SCRIPT',
  'STYLE',
  'TITLE',
  'IFRAME',
  'SELECT',
  'OPTGROUP',
  'OPTION',
  'DATALIST',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'COLGROUP',
])

/** True when any layer element may be dropped into this one. The list is
 *  the rail's hint; `moveElement` re-parses its result and refuses any move
 *  the parser would not preserve, so a tag missing here still cannot lose
 *  content. */
export function holdsChildren(tag: string): boolean {
  return !NO_INSIDE_DROP.has(tag.toUpperCase())
}

function escapeIdent(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id
}

/** Mirror of the runtime's cssPath — keep the two in lockstep. */
export function elementPath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur !== cur.ownerDocument.documentElement) {
    if (cur.id) {
      parts.unshift('#' + escapeIdent(cur.id))
      break
    }
    let nth = 1
    for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName === cur.tagName) nth++
    }
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${nth})`)
    cur = cur.parentElement
  }
  return parts.join(' > ')
}

/** The nodes above the one with `selector`, outermost first — the rows that
 *  must be open for its row to show. Walked on the tree rather than derived
 *  from the selector string: a path anchored on an #id says nothing about the
 *  elements above that id. Null when the selector is not in the tree. */
/** The node a selector names, anywhere in the tree. */
export function findLayer(nodes: LayerNode[], selector: string): LayerNode | null {
  for (const n of nodes) {
    if (n.selector === selector) return n
    const hit = findLayer(n.children, selector)
    if (hit) return hit
  }
  return null
}

/** The name a node shows for itself: "aside.rail", "#nav", or its text. */
export function layerName(node: LayerNode): string {
  return node.detail ? `${node.tag}${node.detail}` : node.label
}

export function ancestorsOf(nodes: LayerNode[], selector: string): LayerNode[] | null {
  for (const node of nodes) {
    if (node.selector === selector) return []
    const below = ancestorsOf(node.children, selector)
    if (below) return [node, ...below]
  }
  return null
}

function ownText(el: Element): string {
  let text = ''
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === Node.TEXT_NODE) text += n.nodeValue ?? ''
  }
  return text.replace(/\s+/g, ' ').trim()
}

function detailOf(el: Element): string {
  if (el.id) return '#' + el.id
  const cls = el.getAttribute('class')?.trim().split(/\s+/)[0]
  return cls ? '.' + cls : ''
}

function toNode(el: Element): LayerNode {
  const tag = el.tagName.toLowerCase()
  const drawingName = el.hasAttribute('data-doop-drawing') ? el.getAttribute('data-name') : null
  const base = {
    selector: elementPath(el),
    tag,
    detail: drawingName ? '' : detailOf(el),
    hidden: el.hasAttribute(HIDDEN_ATTR),
    locked: el.hasAttribute(LOCK_ATTR),
  }
  if (el.namespaceURI === 'http://www.w3.org/2000/svg')
    return { ...base, label: drawingName ?? 'svg', kind: 'svg', children: [] }
  if (IMAGE_TAGS.has(el.tagName)) return { ...base, label: tag, kind: 'image', children: [] }
  const children = layerChildren(el)
  const text = ownText(el)
  if (children.length === 0 && text) {
    return { ...base, label: text.length > 60 ? text.slice(0, 57) + '…' : text, detail: '', kind: 'text', children }
  }
  return { ...base, label: drawingName ?? tag, kind: 'box', children }
}

function layerChildren(el: Element): LayerNode[] {
  const out: LayerNode[] = []
  for (const child of el.children) {
    if (!HIDDEN_TAGS.has(child.tagName)) out.push(toNode(child))
  }
  return out
}

/** The frame's layer tree: the body's children, in document order. */
export function buildLayerTree(html: string): LayerNode[] {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return layerChildren(doc.body)
}

/** Keep the nodes whose label or detail matches `query`, plus their ancestors. */
export function filterLayers(nodes: LayerNode[], query: string): LayerNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes
  const out: LayerNode[] = []
  for (const n of nodes) {
    const children = filterLayers(n.children, q)
    const hit = n.label.toLowerCase().includes(q) || n.detail.toLowerCase().includes(q) || n.tag.includes(q)
    if (hit || children.length) out.push({ ...n, children: hit ? n.children : children })
  }
  return out
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function serialize(doc: Document): string {
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

/** The element's own markup, for the clipboard. */
/* a selector from a stale tree may no longer parse or resolve — both are "gone" */
function find(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector)
  } catch {
    return null
  }
}

export function elementHtml(html: string, selector: string): string | null {
  return find(parse(html), selector)?.outerHTML ?? null
}

/** True when the element, or anything above it, carries the lock — a lock
 *  on a box covers everything inside it, as in Figma. `own` asks about the
 *  element's own attribute only (what a toggle flips). A selector that no
 *  longer resolves is not locked (there is nothing to protect). */
export function isElementLocked(html: string, selector: string, own = false): boolean {
  const el = find(parse(html), selector)
  if (!el) return false
  return own ? el.hasAttribute(LOCK_ATTR) : !!el.closest(`[${LOCK_ATTR}]`)
}

/** The frame's HTML with the element's own lock set or cleared, or null when
 *  the selector no longer resolves. Clearing never touches a lock above it. */
export function setElementLocked(html: string, selector: string, locked: boolean): string | null {
  const doc = parse(html)
  const el = find(doc, selector)
  if (!el) return null
  if (locked) el.setAttribute(LOCK_ATTR, 'true')
  else el.removeAttribute(LOCK_ATTR)
  return serialize(doc)
}

/** The frame's HTML with the element removed, or null when the selector no longer resolves. */
export function removeElement(html: string, selector: string): string | null {
  return removeElements(html, [selector])
}

/* Every selector resolved against one document before anything changes: the
   paths are positional, so removing or inserting one element would shift the
   nth-of-type steps of the others. Null when any of them is gone. */
function findAll(doc: Document, selectors: string[]): Element[] | null {
  const found: Element[] = []
  for (const selector of selectors) {
    const el = find(doc, selector)
    if (!el) return null
    if (!found.includes(el)) found.push(el)
  }
  return found
}

/* the picked elements that are not inside another picked one — a box that
   goes (or is copied) takes its children with it */
function outermost(els: Element[]): Element[] {
  return els.filter((el) => !els.some((other) => other !== el && other.contains(el)))
}

/** The elements in document order, outermost only. */
function inDocumentOrder(els: Element[]): Element[] {
  return outermost(els).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
}

/** The frame's HTML with every element removed, or null when any selector no longer resolves. */
export function removeElements(html: string, selectors: string[]): string | null {
  const doc = parse(html)
  const els = findAll(doc, selectors)
  if (!els?.length) return null
  for (const el of outermost(els)) el.remove()
  return serialize(doc)
}

/** The elements' markup in document order, outermost only, for the clipboard. */
export function elementsHtml(html: string, selectors: string[]): string | null {
  const els = findAll(parse(html), selectors)
  if (!els?.length) return null
  return inDocumentOrder(els)
    .map((el) => el.outerHTML)
    .join('')
}

/** The frame's HTML with the element's markup swapped for `outerHtml`. */
export function replaceElement(html: string, selector: string, outerHtml: string): string | null {
  const doc = parse(html)
  const el = find(doc, selector)
  if (!el) return null
  el.outerHTML = outerHtml
  return serialize(doc)
}

/* The Layers panel's eye on an element. The element stays in the markup,
   marked and switched off with an inline display — so the live frame, every
   export and an agent's screenshot agree it is not there, with no runtime
   rule to carry around. */
export const HIDDEN_ATTR = 'data-doop-hidden'
/* the inline display it had before — value, and "!important" when it
   carried one — so showing it again puts exactly that back */
const DISPLAY_ATTR = 'data-doop-display'

/** Whether the element is hidden; null when the selector no longer resolves. */
export function isElementHidden(html: string, selector: string): boolean | null {
  const el = find(parse(html), selector)
  return el ? el.hasAttribute(HIDDEN_ATTR) : null
}

/** The frame's HTML with the element hidden or shown — the input itself
 *  when it already is, null when the selector no longer resolves. Hiding
 *  sets `display: none !important` inline (author CSS cannot put it back)
 *  and remembers any inline display the element had; showing restores it. */
export function setElementHidden(html: string, selector: string, hidden: boolean): string | null {
  const doc = parse(html)
  const el = find(doc, selector)
  if (!el) return null
  if (el.hasAttribute(HIDDEN_ATTR) === hidden) return html
  const { style } = el as HTMLElement
  if (hidden) {
    if (style.display) {
      const priority = style.getPropertyPriority('display')
      el.setAttribute(DISPLAY_ATTR, priority ? `${style.display} !${priority}` : style.display)
    }
    el.setAttribute(HIDDEN_ATTR, 'true')
    style.setProperty('display', 'none', 'important')
  } else {
    const prior = el.getAttribute(DISPLAY_ATTR)
    el.removeAttribute(HIDDEN_ATTR)
    el.removeAttribute(DISPLAY_ATTR)
    if (prior) {
      const [value = '', priority = ''] = prior.split(' !')
      style.setProperty('display', value, priority)
    } else style.removeProperty('display')
    if (!el.getAttribute('style')) el.removeAttribute('style')
  }
  return serialize(doc)
}

/** The frame's HTML with every element hidden or shown, null when any
 *  selector no longer resolves. */
export function setElementsHidden(html: string, selectors: string[], hidden: boolean): string | null {
  let next = html
  // Hiding marks attributes only, so the positional paths hold between steps.
  for (const selector of selectors) {
    const step = setElementHidden(next, selector, hidden)
    if (step === null) return null
    next = step
  }
  return next
}

/** The frame's HTML with a copy of the element inserted right after it. */
export function duplicateElement(html: string, selector: string): string | null {
  return duplicateElements(html, [selector])?.html ?? null
}

/** The frame's HTML with a copy of each element inserted right after it,
 *  and the copies' paths in document order; a picked element inside another
 *  picked one is copied with its box. The copies share one id renaming, so
 *  a label copied with its input points at the copied input. */
export function duplicateElements(html: string, selectors: string[]): { html: string; selectors: string[] } | null {
  const doc = parse(html)
  const els = findAll(doc, selectors)
  if (!els?.length) return null
  const originals = inDocumentOrder(els)
  const copies = originals.map((el) => el.cloneNode(true) as Element)
  renameIds(doc, copies)
  originals.forEach((el, i) => el.after(copies[i]!))
  return { html: serialize(doc), selectors: copies.map(elementPath) }
}

/** Where a moved element lands relative to its target: as its previous or
 *  next sibling, or as its first child. */
export type DropPlace = 'before' | 'after' | 'inside'

export interface DropTarget {
  selector: string
  place: DropPlace
}

/** Computed in the live document: match the slot's CSS order and remove
 * transform translation without discarding its rotation or scale. */
export interface FlowPlacement {
  order: string
  orderChanged?: boolean
  transform?: string
}

export interface MovedElement {
  html: string
  /** the element's selector after the move — its path changes with its position */
  selector: string
}

/** Insert a clipboard layer as a sibling, keeping ids and SVG references unique. */
export function insertElement(html: string, selector: string | null, outerHtml: string): MovedElement | null {
  const inserted = insertElements(html, selector, outerHtml)
  const [only, ...more] = inserted?.selectors ?? []
  return inserted && only && !more.length ? { html: inserted.html, selector: only } : null
}

/** Insert the clipboard's layers, in order, as siblings after `selector` (or
 *  at the end of the body); null when the markup holds loose text, does not
 *  survive a round trip, or the target is gone. */
export function insertElements(
  html: string,
  selector: string | null,
  outerHtml: string,
): { html: string; selectors: string[] } | null {
  const doc = parse(html)
  const at = selector ? find(doc, selector) : null
  if (selector && (!at || !doc.body.contains(at) || at === doc.body)) return null
  // A row needs a tbody context, a cell needs a tr, and SVG children need
  // their namespace. Parsing a standalone document discards those wrappers.
  const source = (at?.parentElement ?? doc.body).cloneNode(false) as Element
  source.innerHTML = outerHtml
  if (!source.children.length) return null
  if ([...source.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return null
  const copies = [...source.children]
  renameIds(doc, copies)
  let after = at
  for (const copy of copies) {
    if (after) after.after(copy)
    else doc.body.append(copy)
    after = copy
  }
  const next = serialize(doc)
  const selectors = copies.map(elementPath)
  const reparsed = parse(next)
  if (copies.some((copy, i) => find(reparsed, selectors[i]!)?.outerHTML !== copy.outerHTML)) return null
  return { html: next, selectors }
}

/* the neighbouring layer the rail shows: markup that draws nothing is stepped over */
function visibleSibling(el: Element, dir: -1 | 1): Element | null {
  let cur = dir === -1 ? el.previousElementSibling : el.nextElementSibling
  while (cur && HIDDEN_TAGS.has(cur.tagName)) cur = dir === -1 ? cur.previousElementSibling : cur.nextElementSibling
  return cur
}

/** True when the element already sits where the drop would put it, as the
 *  rail shows it — hopping over a hidden <script> is not a move. */
function alreadyAt(el: Element, at: Element, where: DropPlace): boolean {
  if (where === 'before') return visibleSibling(el, 1) === at
  if (where === 'after') return visibleSibling(el, -1) === at
  const first = at.firstElementChild
  return el === (first && HIDDEN_TAGS.has(first.tagName) ? visibleSibling(first, 1) : first)
}

function move(doc: Document, el: Element, at: Element, where: DropPlace, flow?: FlowPlacement): MovedElement | null {
  if (el === at || el.contains(at)) return null
  if (alreadyAt(el, at, where) && !flow?.orderChanged && flow?.transform === undefined) return null
  if (where === 'inside' && !holdsChildren(at.tagName)) return null
  const parent = where === 'inside' ? at : at.parentElement
  if (!parent || parent.closest(`[${LOCK_ATTR}]`) || !doc.body.contains(parent)) return null
  if (where === 'inside') at.prepend(el)
  else if (where === 'before') at.before(el)
  else at.after(el)
  if (flow) {
    // Keep size, rotation and scale, but let DOM order determine layout. Relative
    // positioning also preserves the containing block for positioned descendants.
    const style = (el as HTMLElement | SVGElement).style
    for (const [name, value] of Object.entries({
      position: 'relative',
      inset: 'auto',
      'inset-block': 'auto',
      'inset-inline': 'auto',
      translate: 'none',
      float: 'none',
      order: flow.order,
      'grid-area': 'auto',
    }))
      style.setProperty(name, value, 'important')
    if (flow.transform !== undefined) style.setProperty('transform', flow.transform, 'important')
  }
  const html = serialize(doc)
  const selector = elementPath(el)
  /* the saved markup is what everyone re-parses: a move the parser would
     drop or hoist (into a void element, a <select>, a <table>) is no move */
  if (find(parse(html), selector)?.outerHTML !== el.outerHTML) return null
  return { html, selector }
}

/** The frame's HTML with the element moved next to, or into, the target.
 *  Null when either selector no longer resolves, the target sits inside the
 *  element (a node cannot hold itself), the target cannot hold it (an
 *  <input>, a <select>), or the element is already there. */
export function moveElement(
  html: string,
  selector: string,
  target: DropTarget,
  flow?: FlowPlacement,
): MovedElement | null {
  const doc = parse(html)
  const el = find(doc, selector)
  const at = find(doc, target.selector)
  if (!el || !at) return null
  return move(doc, el, at, target.place, flow)
}

/** The frame's HTML with the element swapped past the layer above (-1) or
 *  below (1) it. Null at either end of the list. */
export function shiftElement(html: string, selector: string, dir: -1 | 1): MovedElement | null {
  const doc = parse(html)
  const el = find(doc, selector)
  const sibling = el && visibleSibling(el, dir)
  if (!el || !sibling) return null
  return move(doc, el, sibling, dir === -1 ? 'before' : 'after')
}

/* attributes whose value is an id, or a space-separated list of ids */
const ID_REF_ATTRS = new Set([
  'for',
  'form',
  'list',
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
])
/* SVG paint servers, clips, masks, filters and markers: url(#id), in any attribute or inline style */
const URL_REF = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g

/** Give every id inside `copies` a fresh name and point the copies' own
 *  references at the new names: label for, #fragment links, aria relations,
 *  SVG use/href and url(#…) paints. Ids must stay unique — a copied id makes
 *  selectors resolve to the original subtree — and a reference left on the
 *  old name would keep wiring the copy to the original. Copies made together
 *  share one renaming, so references between them follow along; references
 *  to ids outside the copies are left alone. */
function renameIds(doc: Document, copies: Element[]) {
  const renamed = new Map<string, string>()
  const taken = new Set<string>()
  const withId = copies.flatMap((copy) => [copy, ...copy.querySelectorAll('[id]')]).filter((n) => n.id)
  for (const node of withId) {
    let next = `${node.id}-copy`
    for (let n = 2; doc.getElementById(next) || taken.has(next); n++) next = `${node.id}-copy-${n}`
    renamed.set(node.id, next)
    taken.add(next)
    node.id = next
  }
  if (renamed.size === 0) return
  const rename = (id: string) => renamed.get(id) ?? id
  for (const node of copies.flatMap((copy) => [copy, ...copy.querySelectorAll('*')])) {
    for (const { name, value } of [...node.attributes]) {
      let next = value
      if (name === 'href' || name === 'xlink:href') {
        if (value.startsWith('#')) next = `#${rename(value.slice(1))}`
      } else if (ID_REF_ATTRS.has(name)) {
        next = value.replace(/\S+/g, rename)
      }
      next = next.replace(URL_REF, (_, quote: string, id: string) => `url(${quote}#${rename(id)}${quote})`)
      if (next !== value) node.setAttribute(name, next)
    }
    /* a <style> carried inside the copy can name its own defs too */
    if (node.tagName === 'STYLE' && node.textContent) {
      const css = node.textContent.replace(
        URL_REF,
        (_, quote: string, id: string) => `url(${quote}#${rename(id)}${quote})`,
      )
      if (css !== node.textContent) node.textContent = css
    }
  }
}
