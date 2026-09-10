import type { Frame } from '../../shared/types'
import { useStore } from './store'
import { api } from './api'
import { recordUpdate } from './history'
import { duplicateElement, removeElement, replaceElement } from './layers'

/* ---- element edits shared by the Layers rail and the element panel ---- */

export function saveFrameHtml(frame: Frame, html: string) {
  recordUpdate(frame.id, { html: frame.html }, { html })
  useStore.getState().patchFrameLocal(frame.id, { html })
  api.updateFrame(frame.id, { html }).catch(console.error)
}

export function deleteLayer(frame: Frame, selector: string) {
  const html = removeElement(frame.html, selector)
  if (html === null) return
  const store = useStore.getState()
  store.setSelectedElement(null)
  store.setElementPanelOpen(false)
  saveFrameHtml(frame, html)
}

export function duplicateLayer(frame: Frame, selector: string) {
  const html = duplicateElement(frame.html, selector)
  if (html !== null) saveFrameHtml(frame, html)
}

/** Swap one element's markup; false when the selector no longer resolves. */
export function replaceLayerHtml(frame: Frame, selector: string, outerHtml: string): boolean {
  const html = replaceElement(frame.html, selector, outerHtml)
  if (html === null) return false
  saveFrameHtml(frame, html)
  return true
}
