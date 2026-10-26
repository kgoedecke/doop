import type { Frame } from '../../shared/types'
import { canvasPages } from '../../shared/pages'
import { interactionAttributes, parseInteractions, PROTO_ATTRS, type Interaction } from '../../shared/prototype'
import { api, errorMessage } from './api'
import { saveFrameHtml, isLayerLocked } from './layerEdits'
import { useStore } from './store'
import { trackSave } from './history'

/* ---- reading and writing an element's interactions in frame HTML ---- */

function findElement(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector)
  } catch {
    return null
  }
}

export function readInteractions(el: Element): Interaction[] {
  return parseInteractions({
    on: el.getAttribute(PROTO_ATTRS.on),
    action: el.getAttribute(PROTO_ATTRS.action),
    transition: el.getAttribute(PROTO_ATTRS.transition),
    duration: el.getAttribute(PROTO_ATTRS.duration),
    interactions: el.getAttribute(PROTO_ATTRS.interactions),
  })
}

/** The element's interactions; null when the selector no longer resolves. */
export function elementInteractions(html: string, selector: string): Interaction[] | null {
  const el = findElement(new DOMParser().parseFromString(html, 'text/html'), selector)
  return el ? readInteractions(el) : null
}

/** The frame's HTML with the element's interactions replaced by `list`, in
 *  the canonical form; null when the selector no longer resolves. */
export function withElementInteractions(html: string, selector: string, list: Interaction[]): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const el = findElement(doc, selector)
  if (!el) return null
  for (const [name, value] of Object.entries(interactionAttributes(list))) {
    if (value === null) el.removeAttribute(name)
    else el.setAttribute(name, value)
  }
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

/** Save the element's interactions through the frame save path, as one
 *  undo step. False when the layer is locked or no longer exists. */
export function saveInteractions(frame: Frame, selector: string, list: Interaction[]): boolean {
  if (isLayerLocked(frame, selector)) return false
  const html = withElementInteractions(frame.html, selector, list)
  if (html === null || html === frame.html) return html !== null
  saveFrameHtml(frame, html)
  return true
}

/* ---- flows ---- */

/** Make `frameId` the start of its page's flow, or clear the page's start. */
export function setFlowStart(canvasId: string, pageId: string, frameId: string | null) {
  const s = useStore.getState()
  if (s.canvas?.id !== canvasId) return
  const before = canvasPages(s.canvas)
  const optimistic = before.map((page) => {
    if (page.id !== pageId) return page
    const { startFrameId: _previous, ...rest } = page
    return frameId ? { ...rest, startFrameId: frameId } : rest
  })
  s.setPages(optimistic, canvasId)
  trackSave(
    api
      .setFlowStart(canvasId, pageId, frameId)
      .then((pages) => useStore.getState().setPages(pages, canvasId))
      .catch((err: unknown) => {
        const state = useStore.getState()
        state.setPages(before, canvasId)
        state.pushNotice(errorMessage(err, 'Couldn’t set the flow start'))
      }),
  )
}

/** The full-page player for a canvas, optionally opening on one frame. */
export function prototypePath(canvasId: string, frameId?: string): string {
  return `/c/${canvasId}/proto${frameId ? `?frame=${encodeURIComponent(frameId)}` : ''}`
}
