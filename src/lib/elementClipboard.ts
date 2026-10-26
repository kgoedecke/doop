import type { Frame } from '../../shared/types'
import { elementsHtml, insertElements, isElementLocked } from './layers'
import { saveFrameHtml } from './layerEdits'
import { useStore } from './store'
import { ELEMENT_CLIP_KEY, FRAME_CLIP_KEY } from './clipboardKeys'

export function copyLayer(frame: Frame, selector: string): boolean {
  return copyLayers(frame, [selector])
}

/** Copy the elements in document order; a paste lands them together. */
export function copyLayers(frame: Frame, selectors: string[]): boolean {
  const html = elementsHtml(frame.html, selectors)
  if (!html) return false
  localStorage.setItem(ELEMENT_CLIP_KEY, html)
  localStorage.removeItem(FRAME_CLIP_KEY)
  return true
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
  const inserted = insertElements(live.html, selector, html)
  if (!inserted) return false
  saveFrameHtml(live, inserted.html)
  const store = useStore.getState()
  store.pickElement(null)
  for (const pasted of inserted.selectors) store.toggleElement({ frameId: frame.id, selector: pasted })
  return true
}
