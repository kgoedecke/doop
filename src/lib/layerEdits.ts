import type { Frame } from '../../shared/types'
import { useStore } from './store'
import { api } from './api'
import { recordUpdate } from './history'
import {
  duplicateElement,
  moveElement,
  removeElement,
  replaceElement,
  shiftElement,
  type DropTarget,
  type MovedElement,
} from './layers'

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

/* a moved element keeps the selection: its selector changes with its
   position, so the rail and the frame outline have to be pointed at the new one */
function commitMove(frame: Frame, moved: MovedElement | null): boolean {
  if (!moved) return false
  saveFrameHtml(frame, moved.html)
  const store = useStore.getState()
  store.select(frame.id)
  store.setSelectedElement({ frameId: frame.id, selector: moved.selector })
  return true
}

/** Drop the element next to, or into, another; false when nothing moved. */
export function moveLayer(frame: Frame, selector: string, target: DropTarget): boolean {
  return commitMove(frame, moveElement(frame.html, selector, target))
}

/** Step the element one layer up (-1) or down (1) among its siblings. */
export function shiftLayer(frame: Frame, selector: string, dir: -1 | 1): boolean {
  return commitMove(frame, shiftElement(frame.html, selector, dir))
}
