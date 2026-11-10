import type { Frame } from '../../shared/types'
import { elementsHtml, insertElements, isElementLocked } from './layers'
import { isStandalonePick, saveFrameHtml } from './layerEdits'
import { copyFrames } from './frameClipboard'
import { useStore } from './store'
import { ELEMENT_CLIP_KEY, ELEMENT_CLIP_STYLE_KEY, FRAME_CLIP_KEY } from './clipboardKeys'
import { carriedCss, newScope, renameInCss, SCOPE_ATTR, withCarriedCss } from './styleCarry'
import { api, errorMessage } from './api'

export function copyLayer(frame: Frame, selector: string): boolean {
  return copyLayers(frame, [selector])
}

/** Copy what is picked in `frame`. A standalone element's shape is the
 *  element itself, so picking it and copying copies the frame it is: the
 *  paste then lands a second element on the canvas, at the root, rather than
 *  a second shape inside the original's shell. */
export function copyPicked(frame: Frame, selectors: string[]): boolean {
  if (isStandalonePick(frame, selectors)) {
    copyFrames([frame])
    return true
  }
  return copyLayers(frame, selectors)
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
  const styles: ClipStyles = {
    frameId: frame.id,
    canvasId: frame.canvasId,
    sourceVersion: frame.updatedAt,
    css: sheets.join('\n'),
    scopes,
  }
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

type ClipStyles = { frameId: string; canvasId: string; sourceVersion: number; css: string; scopes: string[] }

function clipStyles(): ClipStyles | null {
  try {
    const raw = localStorage.getItem(ELEMENT_CLIP_STYLE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      const value = parsed as Partial<ClipStyles>
      if (
        typeof value.frameId === 'string' &&
        value.frameId.length > 0 &&
        typeof value.canvasId === 'string' &&
        value.canvasId.length > 0 &&
        Number.isSafeInteger(value.sourceVersion) &&
        (value.sourceVersion ?? -1) >= 0 &&
        typeof value.css === 'string' &&
        Array.isArray(value.scopes) &&
        value.scopes.every((scope) => typeof scope === 'string')
      )
        return value as ClipStyles
    }
  } catch {
    /* invalid current clipboard data; no legacy shape is adopted */
  }
  return null
}

export function hasElementClip(): boolean {
  return !!localStorage.getItem(ELEMENT_CLIP_KEY) && !!clipStyles()
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
  if (!styles) return false
  if (styles.canvasId !== live.canvasId) {
    const canvasId = live.canvasId
    const pageId = useStore.getState().activePageId
    const version = live.updatedAt
    void api
      .copyResources(canvasId, [
        { sourceFrameId: styles.frameId, sourceVersion: styles.sourceVersion, html, css: styles.css },
      ])
      .then((result) => {
        const state = useStore.getState()
        const current = state.canvas?.frames.find((f) => f.id === live.id)
        if (
          state.canvas?.id !== canvasId ||
          state.activePageId !== pageId ||
          !current ||
          current.updatedAt !== version ||
          current.locked ||
          (selector && isElementLocked(current.html, selector))
        )
          throw new Error('The destination changed. Paste again where you want the content.')
        if (result.canvasId !== canvasId || result.entries.length !== 1)
          throw new Error('The copied files did not match this destination.')
        if (!pasteContent(current, selector, result.entries[0]!.html, { ...styles, css: result.entries[0]!.css ?? '' }))
          throw new Error('The destination layer is no longer available. Choose where to paste again.')
      })
      .catch((error: unknown) =>
        useStore.getState().pushNotice(errorMessage(error, 'The content could not be pasted.')),
      )
    return true
  }
  return pasteContent(live, selector, html, styles)
}

function pasteContent(live: Frame, selector: string | null, html: string, styles: ClipStyles): boolean {
  const fresh = new Map(styles.scopes.map((old) => [old, newScope()]))
  const rescope = (text: string) => [...fresh].reduce((t, [old, next]) => t.split(old).join(next), text)
  const inserted = insertElements(live.html, selector, rescope(html))
  if (!inserted) return false
  /* one sheet for every pasted root */
  const pasted = withCarriedCss(inserted.html, renameInCss(rescope(styles.css), inserted.renamed), [...fresh.values()])
  saveFrameHtml(live, pasted)
  const store = useStore.getState()
  store.pickElement(null)
  for (const pasted of inserted.selectors) store.toggleElement({ frameId: live.id, selector: pasted })
  return true
}
