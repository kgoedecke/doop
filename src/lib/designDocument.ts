import { normalizeDesignValue, splitCssList } from './designProperties'

export interface DesignLayer {
  selector: string
  parent: string | null
  name: string
  tag: string
  depth: number
  children: DesignLayer[]
  hidden: boolean
  locked: boolean
  ownLocked: boolean
  text: string
  image?: string
}

const OMIT = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'SOURCE', 'TITLE'])
const NODE_ID = 'data-doop-node'

export function parseDesign(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

export function designSelector(el: Element): string {
  const id = el.getAttribute(NODE_ID)
  if (id && el.ownerDocument.querySelectorAll(`[${NODE_ID}="${CSS.escape(id)}"]`).length === 1) {
    return `[${NODE_ID}="${CSS.escape(id)}"]`
  }
  if (el.id && el.ownerDocument.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
    return `#${CSS.escape(el.id)}`
  }
  if (el === el.ownerDocument.body) return 'body'
  const parts: string[] = []
  let current: Element | null = el
  while (current && current !== el.ownerDocument.documentElement) {
    let nth = 1
    for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.tagName === current.tagName) nth++
    }
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${nth})`)
    current = current.parentElement
  }
  return parts.join(' > ')
}

export function sourceElement(doc: Document, selector: string): HTMLElement | SVGElement | null {
  try {
    const matches = doc.querySelectorAll(selector)
    if (matches.length !== 1) return null
    const el = matches[0]
    if (!doc.body.contains(el) || OMIT.has(el.tagName.toUpperCase()) || !('style' in el)) return null
    return el as HTMLElement | SVGElement
  } catch {
    return null
  }
}

export function layerName(el: Element): string {
  return (
    el.getAttribute('data-doop-name') ||
    el.getAttribute('aria-label') ||
    el.getAttribute('alt') ||
    (el.id ? `#${el.id}` : '') ||
    (el.children.length === 0 ? el.textContent?.trim().slice(0, 64) : '') ||
    (el.tagName === 'BODY' ? 'Frame contents' : el.tagName.toLowerCase())
  )
}

export function readLayers(doc: Document): { layers: DesignLayer[]; truncated: boolean } {
  let count = 0
  let truncated = false
  function visit(el: Element, depth: number, parent: string | null, inheritedLock: boolean): DesignLayer | null {
    if (OMIT.has(el.tagName.toUpperCase())) return null
    if (count >= 3000 || depth > 80) {
      truncated = true
      return null
    }
    count++
    const selector = designSelector(el)
    const ownLocked = el.hasAttribute('data-doop-locked')
    const locked = inheritedLock || ownLocked
    const style = (el as HTMLElement).style
    return {
      selector,
      parent,
      name: layerName(el),
      tag: el.tagName.toLowerCase(),
      depth,
      hidden: el.hasAttribute('hidden') || style?.display === 'none' || style?.visibility === 'hidden',
      locked,
      ownLocked,
      text: el.children.length === 0 ? el.textContent || '' : '',
      image: el.tagName === 'IMG' ? el.getAttribute('src') || undefined : undefined,
      children: [...el.children].flatMap((child) => {
        const layer = visit(child, depth + 1, selector, locked)
        return layer ? [layer] : []
      }),
    }
  }
  const root = visit(doc.body, 0, null, false)
  return { layers: root ? [root] : [], truncated }
}

export function flattenLayers(layers: DesignLayer[]): DesignLayer[] {
  return layers.flatMap((layer) => [layer, ...flattenLayers(layer.children)])
}

export type DesignEdit =
  | { type: 'style'; values: Record<string, string> }
  | { type: 'rename'; name: string }
  | { type: 'text'; text: string }
  | { type: 'image'; src: string; alt?: string }
  | { type: 'visibility' }
  | { type: 'lock' }
  | { type: 'duplicate' }
  | { type: 'delete' }
  | { type: 'reorder'; direction: 'up' | 'down' }
  | { type: 'insert'; kind: 'text' | 'box' | 'image'; src?: string }

function persistIdentity(el: Element): string {
  const current = designSelector(el)
  if (current === 'body' || current.startsWith('#')) return current
  if (!el.hasAttribute(NODE_ID)) el.setAttribute(NODE_ID, crypto.randomUUID())
  return designSelector(el)
}

function imageUrl(value: string): string {
  const clean = value.trim()
  if (!clean) throw new Error('Enter an image URL.')
  const url = new URL(clean, location.origin)
  if (!['http:', 'https:'].includes(url.protocol) && !/^data:image\/(png|jpeg|webp|gif|avif|svg\+xml);/i.test(clean)) {
    throw new Error('Use an http, https, or image data URL.')
  }
  return clean
}

/** Duplicating IDs must also duplicate local ID-based styling, otherwise a
 * button whose appearance lives in #button would lose its design on copy. */
function copyIdStyles(doc: Document, ids: Map<string, string>) {
  if (!ids.size) return
  const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  function rewrite(rule: CSSRule): string {
    if (rule instanceof CSSStyleRule) {
      const selectors = splitCssList(rule.selectorText).flatMap((original) => {
        let selector = original
        for (const [old, next] of ids)
          selector = selector.replace(
            new RegExp(`#${escapePattern(CSS.escape(old))}(?![\\w-])`, 'g'),
            `#${CSS.escape(next)}`,
          )
        return selector === original ? [] : [selector]
      })
      return selectors.length ? `${selectors.join(', ')} { ${rule.style.cssText} }` : ''
    }
    if ('cssRules' in rule) {
      const nested = [...(rule as CSSGroupingRule).cssRules].map(rewrite).filter(Boolean).join('\n')
      return nested ? `${rule.cssText.slice(0, rule.cssText.indexOf('{') + 1)}\n${nested}\n}` : ''
    }
    return ''
  }
  const copied: string[] = []
  for (const source of doc.querySelectorAll('style')) {
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(source.textContent || '')
      copied.push(...[...sheet.cssRules].map(rewrite).filter(Boolean))
    } catch {
      /* Unsupported stylesheet syntax is left intact. */
    }
  }
  if (copied.length) {
    const style = doc.createElement('style')
    style.setAttribute('data-doop-copy-styles', '')
    style.textContent = copied.join('\n')
    doc.head.append(style)
  }
}

/** Mutate an inert copy of stored HTML, never the running iframe document. */
export function editDesign(html: string, selector: string, edit: DesignEdit): { html: string; selector: string } {
  const doc = parseDesign(html)
  const el = sourceElement(doc, selector)
  if (!el) throw new Error('This layer changed or only exists at runtime. Select a source layer in Layers.')
  const locked = el.closest('[data-doop-locked]')
  if (locked && !(edit.type === 'lock' && locked === el)) throw new Error('Unlock this layer or its parent first.')
  let target: Element = el
  switch (edit.type) {
    case 'style': {
      // Validate the whole batch before touching the source.
      const probe = doc.createElement('div').style
      const values = Object.entries(edit.values).map(([key, raw]) => {
        const value = normalizeDesignValue(key, raw)
        probe.removeProperty(key)
        if (value) {
          probe.setProperty(key, value)
          if (!probe.getPropertyValue(key)) throw new Error(`Invalid ${key} value. Try a CSS value such as 16px.`)
        }
        return [key, value] as const
      })
      for (const [key, value] of values) {
        if (value) el.style.setProperty(key, value, 'important')
        else el.style.removeProperty(key)
      }
      if (!el.getAttribute('style')) el.removeAttribute('style')
      break
    }
    case 'rename':
      if (!edit.name.trim()) throw new Error('Give the layer a name.')
      el.setAttribute('data-doop-name', edit.name.trim().slice(0, 160))
      break
    case 'text':
      if (el.children.length) throw new Error('Select a text-only child to preserve the nested markup.')
      el.textContent = edit.text
      break
    case 'image':
      if (el.tagName !== 'IMG') throw new Error('Select an image layer.')
      if (el.parentElement?.tagName === 'PICTURE')
        throw new Error('This image uses picture sources. Edit its sources in HTML.')
      el.setAttribute('src', imageUrl(edit.src))
      el.removeAttribute('srcset')
      el.removeAttribute('sizes')
      if (edit.alt !== undefined) el.setAttribute('alt', edit.alt)
      break
    case 'visibility': {
      const previous = el.getAttribute('data-doop-display')
      if (previous !== null) {
        const [value, priority] = JSON.parse(previous) as [string, string]
        el.style.removeProperty('display')
        if (value) el.style.setProperty('display', value, priority)
        el.removeAttribute('data-doop-display')
      } else if (el.hasAttribute('hidden') || el.style.display === 'none' || el.style.visibility === 'hidden') {
        el.removeAttribute('hidden')
        if (el.style.display === 'none') el.style.removeProperty('display')
        if (el.style.visibility === 'hidden') el.style.removeProperty('visibility')
      } else {
        el.setAttribute(
          'data-doop-display',
          JSON.stringify([el.style.display, el.style.getPropertyPriority('display')]),
        )
        el.style.setProperty('display', 'none', 'important')
      }
      break
    }
    case 'lock':
      el.toggleAttribute('data-doop-locked')
      break
    case 'duplicate': {
      if (el === doc.body) throw new Error('Duplicate the frame to copy all its contents.')
      const clone = el.cloneNode(true) as Element
      // New IDs, including references inside SVG/labels, avoid targeting the original.
      const nodes = [clone, ...clone.querySelectorAll('*')]
      const ids = new Map<string, string>()
      for (const node of nodes) {
        node.removeAttribute(NODE_ID)
        if (node.id) {
          const next = `copy-${crypto.randomUUID()}`
          ids.set(node.id, next)
          node.id = next
        }
      }
      for (const node of nodes)
        for (const attr of [...node.attributes]) {
          let value = attr.value
          for (const [old, next] of ids) {
            value = value.replaceAll(`url(#${old})`, `url(#${next})`)
            if (['href', 'xlink:href'].includes(attr.name) && value === `#${old}`) value = `#${next}`
            if (['for', 'aria-labelledby', 'aria-describedby'].includes(attr.name))
              value = value
                .split(' ')
                .map((part) => (part === old ? next : part))
                .join(' ')
          }
          if (value !== attr.value) node.setAttribute(attr.name, value)
        }
      copyIdStyles(doc, ids)
      clone.setAttribute('data-doop-name', `${layerName(el)} copy`)
      el.after(clone)
      target = clone
      break
    }
    case 'delete':
      if (el === doc.body) throw new Error('Delete the frame to remove all its contents.')
      target = el.parentElement!
      el.remove()
      break
    case 'reorder': {
      if (el === doc.body) throw new Error('Frame contents cannot be reordered.')
      const sibling = edit.direction === 'up' ? el.previousElementSibling : el.nextElementSibling
      if (!sibling) return { html, selector }
      if (sibling.hasAttribute('data-doop-locked') || OMIT.has(sibling.tagName))
        throw new Error('Cannot move past this layer.')
      if (edit.direction === 'up') sibling.before(el)
      else sibling.after(el)
      break
    }
    case 'insert': {
      if (
        ['IMG', 'INPUT', 'BR', 'HR', 'VIDEO', 'SVG', 'PATH'].includes(el.tagName.toUpperCase()) ||
        el.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      ) {
        throw new Error('Select a container to insert a layer.')
      }
      const node = doc.createElement(edit.kind === 'text' ? 'p' : edit.kind === 'image' ? 'img' : 'div')
      node.setAttribute('data-doop-name', edit.kind === 'text' ? 'Text' : edit.kind === 'image' ? 'Image' : 'Container')
      if (edit.kind === 'text') {
        node.textContent = 'Your text'
        node.style.cssText = 'font-size:24px;color:#17171b;margin:0'
      }
      if (edit.kind === 'box') node.style.cssText = 'width:160px;height:120px;background:#eeeef2;border-radius:12px'
      if (edit.kind === 'image') {
        node.setAttribute('src', imageUrl(edit.src || ''))
        node.setAttribute('alt', '')
        node.style.cssText = 'width:240px;height:160px;object-fit:cover'
      }
      el.append(node)
      target = node
      break
    }
  }
  const nextSelector = persistIdentity(target)
  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) + '\n' : ''
  return { html: doctype + doc.documentElement.outerHTML, selector: nextSelector }
}
