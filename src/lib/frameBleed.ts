/**
 * A standalone shape's stroke spills past its box, as in Figma: its iframe
 * reaches a margin past the frame on every side (the runtime asks for it with
 * `doop:bleed-want`). The runtime keeps talking in the frame's own design px,
 * so code that measures the iframe element takes the margin back off here.
 */
import { useStore } from './store'

/** The box of the document a frame's iframe shows, on screen: the iframe
 *  less the margin a standalone shape's stroke bleeds into. */
export function documentRect(iframe: HTMLIFrameElement | null): DOMRect | null {
  if (!iframe) return null
  const rect = iframe.getBoundingClientRect()
  const margin = iframeBleed(iframe) * useStore.getState().viewport.zoom
  return new DOMRect(rect.left + margin, rect.top + margin, rect.width - 2 * margin, rect.height - 2 * margin)
}

/** The margin, in design px, an iframe reaches past its frame's box. */
export function iframeBleed(iframe: HTMLIFrameElement): number {
  return Number(iframe.dataset.bleed) || 0
}
