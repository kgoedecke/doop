import type { Frame } from '../../shared/types'
import { elementsHtml, insertElements, isElementLocked } from './layers'
import { saveFrameHtml } from './layerEdits'
import { useStore } from './store'
import { ELEMENT_CLIP_KEY, ELEMENT_CLIP_STYLE_KEY, FRAME_CLIP_KEY } from './clipboardKeys'
import { carriedCss, newScope, renameInCss, SCOPE_ATTR, withCarriedCss } from './styleCarry'

export function copyLayer(frame: Frame, selector: string): boolean {
  return copyLayers(frame, [selector])
}

/** Copy the elements in document order; a paste lands them together. */
export function copyLayers(frame: Frame, selectors: string[]): boolean {
  const raw = elementsHtml(frame.html, selectors)
  if (!raw) return false
  /* each copied root wears a scope of its own, with the CSS collected for
     it alone, so two roots from differently themed places keep their own
     values once pasted side by side */
  const roots = outermostInOrder(frame.html, selectors)
  const tpl = document.createElement('template')
  tpl.innerHTML = raw
  const children = [...tpl.content.children]
  if (children.length !== roots.length) return false
  const scopes: string[] = []
  const sheets: string[] = []
  children.forEach((child, i) => {
    const scope = newScope()
    child.setAttribute(SCOPE_ATTR, scope)
    scopes.push(scope)
    const css = carriedCss(frame.html, roots[i]!, scope)
    if (css) sheets.push(css)
  })
  localStorage.setItem(ELEMENT_CLIP_KEY, tpl.innerHTML)
  const styles: ClipStyles = { frameId: frame.id, css: sheets.join('\n'), scopes }
  localStorage.setItem(ELEMENT_CLIP_STYLE_KEY, JSON.stringify(styles))
  localStorage.removeItem(FRAME_CLIP_KEY)
  return true
}

/* the selectors of the outermost picked elements, in document order — the
   order elementsHtml lists them in */
function outermostInOrder(html: string, selectors: string[]): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const found = selectors
    .map((selector) => {
      try {
        return { selector, el: doc.querySelector(selector) }
      } catch {
        return { selector, el: null }
      }
    })
    .filter((x): x is { selector: string; el: Element } => !!x.el)
  return found
    .filter(({ el }) => !found.some((other) => other.el !== el && other.el.contains(el)))
    .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map(({ selector }) => selector)
}

type ClipStyles = { frameId: string; css: string; scopes?: string[] }

function clipStyles(): ClipStyles | null {
  try {
    const raw = localStorage.getItem(ELEMENT_CLIP_STYLE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && 'css' in parsed && typeof parsed.css === 'string')
      return parsed as ClipStyles
  } catch {
    /* an older clip, or a value this code did not write */
  }
  return null
}

export function hasElementClip(): boolean {
  return !!localStorage.getItem(ELEMENT_CLIP_KEY)
}

/** Paste after the picked layer, or at the end of a frame's empty surface;
 *  every pasted layer ends up picked. */
export function pasteLayer(frame: Frame, selector: string | null): boolean {
  const live = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
  const html = localStorage.getItem(ELEMENT_CLIP_KEY)
  if (!live || live.locked || !html || (selector && isElementLocked(live.html, selector))) return false
  /* each paste wears scopes of its own, so two pastes of one copy never
     share rules or animations */
  const styles = clipStyles()
  const fresh = new Map((styles?.scopes ?? []).map((old) => [old, newScope()]))
  const rescope = (text: string) => [...fresh].reduce((t, [old, next]) => t.split(old).join(next), text)
  const inserted = insertElements(live.html, selector, rescope(html))
  if (!inserted) return false
  /* one sheet for every pasted root */
  const pasted = styles
    ? withCarriedCss(inserted.html, renameInCss(rescope(styles.css), inserted.renamed), [...fresh.values()])
    : inserted.html
  saveFrameHtml(live, pasted)
  const store = useStore.getState()
  store.pickElement(null)
  for (const pasted of inserted.selectors) store.toggleElement({ frameId: frame.id, selector: pasted })
  return true
}
