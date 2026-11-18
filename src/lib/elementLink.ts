import { canvasPages } from '../../shared/pages'
import type { Canvas, Frame } from '../../shared/types'
import { api } from './api'
import { defaultPageId } from './pageLink'
import { useStore } from './store'

/** An element link names the element by its `data-doop-id`, which lives in the
 *  frame HTML: `/c/<canvas>?frame=<frame>&element=<id>`. Agents find the
 *  attribute in get_frame's HTML; the editor resolves it in the live iframe. */
export function elementLink(frame: Pick<Frame, 'id' | 'canvasId'>, elementId: string): string {
  const url = new URL(`/c/${encodeURIComponent(frame.canvasId)}`, location.origin)
  url.searchParams.set('frame', frame.id)
  url.searchParams.set('element', elementId)
  return url.href
}

/** Where ⌘-clicking a link in a frame goes, as a browser would take it: a
 *  frame of the open canvas (the camera moves there), one of its pages (the
 *  editor switches to it), a spot in the frame's own document (`#section`,
 *  scrolled to) or anything else a browser opens (a new tab, or the mail or
 *  phone app for `mailto:` / `tel:`). */
export type FrameLinkTarget =
  | { kind: 'frame'; frame: Frame; element: string | null }
  | { kind: 'page'; pageId: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'web'; url: string }

/** Schemes a design may hand the browser to open. Anything else (`javascript:`,
 *  `data:`, `blob:`, `file:`) would run or show the design's own content
 *  outside its sandbox, so it is never followed. */
const OPENABLE = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** An iframe can only suggest a destination; the editor decides. Every link
 *  is followed the way a browser would follow it, with two exceptions: a link
 *  into the open canvas naming a frame or page that is gone or hidden goes
 *  nowhere (it would only reopen this canvas; a link to the canvas itself
 *  opens its default page), and so does a scheme that is
 *  not `OPENABLE`. A relative path resolves against Doop's own address, as
 *  it would on a page served from there. */
export function resolveFrameLink(canvas: Omit<Canvas, 'components'>, href: string): FrameLinkTarget | null {
  const raw = href.trim()
  if (raw.startsWith('#')) return { kind: 'anchor', id: raw.slice(1) }
  const url = URL.parse(raw, location.origin)
  if (!url || !OPENABLE.has(url.protocol)) return null
  if (url.origin === location.origin && url.pathname === `/c/${encodeURIComponent(canvas.id)}`) {
    const frameId = url.searchParams.get('frame')
    if (frameId) {
      const frame = canvas.frames.find((candidate) => candidate.id === frameId && !candidate.hidden)
      return frame ? { kind: 'frame', frame, element: url.searchParams.get('element') } : null
    }
    const pageId = url.searchParams.get('page')
    if (pageId) return canvasPages(canvas).some((page) => page.id === pageId) ? { kind: 'page', pageId } : null
    /* the canvas itself: the page that link opens, not a second copy in a tab */
    return { kind: 'page', pageId: defaultPageId(canvas) }
  }
  return { kind: 'web', url: url.href }
}

/** What the editor knows about the element to link: the positional selector
 *  the live document answered with, and the id it already carries if any. */
export interface LinkTarget {
  selector: string
  elementId?: string
  /** the live element's excerpt, when the pick came from the live document:
   *  the server refuses to stamp a saved element that does not match it */
  snippet?: string
}

/** Copy a link to the element, stamping its id into the frame first when it
 *  has none yet (the server does that for anyone who may comment). */
export async function copyElementLink(frame: Pick<Frame, 'id' | 'canvasId'>, target: LinkTarget): Promise<void> {
  try {
    const elementId =
      target.elementId ?? (await api.ensureElementId(frame.id, target.selector, target.snippet)).elementId
    await navigator.clipboard.writeText(elementLink(frame, elementId))
    useStore.getState().pushNotice('Element link copied')
  } catch {
    useStore.getState().pushNotice('Couldn’t copy the element link. Please try again.')
  }
}
