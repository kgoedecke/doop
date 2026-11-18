import type { ElementComment } from '../../shared/types'
import { useStore } from './store'
import { t } from './i18n'

/** A link that opens the canvas with this comment's thread expanded: on its
 *  frame for a frame or element comment, on its page for a canvas comment.
 *  Always the ROOT's id, since only roots have pins. The same shape as the
 *  comment email's link (server/links.ts). */
export function commentLink(
  comment: Pick<ElementComment, 'id' | 'parentId' | 'canvasId' | 'frameId' | 'pageId'>,
  origin = location.origin,
): string {
  const url = new URL(`/c/${encodeURIComponent(comment.canvasId)}`, origin)
  if (comment.frameId) url.searchParams.set('frame', comment.frameId)
  else if (comment.pageId) url.searchParams.set('page', comment.pageId)
  url.searchParams.set('comment', comment.parentId ?? comment.id)
  return url.href
}

/** Copy the thread's link and say so. */
export async function copyCommentLink(
  comment: Pick<ElementComment, 'id' | 'parentId' | 'canvasId' | 'frameId' | 'pageId'>,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(commentLink(comment))
    useStore.getState().pushNotice(t('stage.commentLinkCopied'))
  } catch {
    useStore.getState().pushNotice(t('stage.commentLinkFailed'))
  }
}
