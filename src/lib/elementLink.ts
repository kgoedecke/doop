import type { Frame } from '../../shared/types'
import { api } from './api'
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
