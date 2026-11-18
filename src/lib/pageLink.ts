import { defaultPageId, framePageId, openingPageId, type LinkedCanvas } from '../../shared/pages'

export { defaultPageId, openingPageId }

/** A page link is `/c/<canvas>?page=<page>`. It always names its page, the
 *  default one too, so it keeps meaning that page when the default moves. */
export function pageLink(canvasId: string, pageId: string, origin: string = location.origin): string {
  const url = new URL(`/c/${encodeURIComponent(canvasId)}`, origin)
  url.searchParams.set('page', pageId)
  return url.href
}

/** The query the address bar should carry while `activePageId` is showing:
 *  `search` changed as little as makes it open that page. The default page
 *  needs no `page`, a frame link on the page is left as it is, and a frame,
 *  element or comment link to somewhere else is dropped, since it would win
 *  over the page on a reload. Every other parameter is kept. */
export function pageSearch(canvas: LinkedCanvas, search: string, activePageId: string): string {
  const params = new URLSearchParams(search)
  const frameId = params.get('frame')
  const frame = frameId ? canvas.frames.find((candidate) => candidate.id === frameId) : undefined
  const onLinkedFrame = !!frame && framePageId(canvas, frame) === activePageId
  if (openingPageId(canvas, search) !== activePageId) params.delete('comment')
  if (!onLinkedFrame) {
    params.delete('frame')
    params.delete('element')
  }
  if (onLinkedFrame || activePageId === defaultPageId(canvas)) params.delete('page')
  else params.set('page', activePageId)
  const next = params.toString()
  return next ? `?${next}` : ''
}
