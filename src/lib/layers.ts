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
  children: LayerNode[]
}

/* markup that renders nothing of its own has no place in a layer list */
const HIDDEN_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR'])
const IMAGE_TAGS = new Set(['IMG', 'PICTURE', 'VIDEO', 'CANVAS'])

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
  const base = { selector: elementPath(el), tag, detail: detailOf(el) }
  if (el.namespaceURI === 'http://www.w3.org/2000/svg') return { ...base, label: 'svg', kind: 'svg', children: [] }
  if (IMAGE_TAGS.has(el.tagName)) return { ...base, label: tag, kind: 'image', children: [] }
  const children = layerChildren(el)
  const text = ownText(el)
  if (children.length === 0 && text) {
    return { ...base, label: text.length > 60 ? text.slice(0, 57) + '…' : text, detail: '', kind: 'text', children }
  }
  return { ...base, label: tag, kind: 'box', children }
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

/** The frame's HTML with the element removed, or null when the selector no longer resolves. */
export function removeElement(html: string, selector: string): string | null {
  const doc = parse(html)
  const el = find(doc, selector)
  if (!el) return null
  el.remove()
  return serialize(doc)
}

/** The frame's HTML with a copy of the element inserted right after it. */
export function duplicateElement(html: string, selector: string): string | null {
  const doc = parse(html)
  const el = find(doc, selector)
  if (!el) return null
  const copy = el.cloneNode(true) as Element
  renameIds(doc, copy)
  el.after(copy)
  return serialize(doc)
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

/** Give every id inside `copy` a fresh name and point the copy's own
 *  references at the new names: label for, #fragment links, aria relations,
 *  SVG use/href and url(#…) paints. Ids must stay unique — a copied id makes
 *  selectors resolve to the original subtree — and a reference left on the
 *  old name would keep wiring the copy to the original. References to ids
 *  outside the copy are left alone. */
function renameIds(doc: Document, copy: Element) {
  const renamed = new Map<string, string>()
  const taken = new Set<string>()
  const withId = [copy, ...copy.querySelectorAll('[id]')].filter((n) => n.id)
  for (const node of withId) {
    let next = `${node.id}-copy`
    for (let n = 2; doc.getElementById(next) || taken.has(next); n++) next = `${node.id}-copy-${n}`
    renamed.set(node.id, next)
    taken.add(next)
    node.id = next
  }
  if (renamed.size === 0) return
  const rename = (id: string) => renamed.get(id) ?? id
  for (const node of [copy, ...copy.querySelectorAll('*')]) {
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
