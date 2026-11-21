import { canvasPages, framePageId } from '../../shared/pages'
import type { Canvas } from '../../shared/types'

type LinkedCanvas = Pick<Canvas, 'id' | 'pages' | 'frames' | 'landingPageId'>

/** A page link is `/c/<canvas>?page=<page>`. It always names its page, the
 *  default one too, so it keeps meaning that page when the default moves. */
export function pageLink(canvasId: string, pageId: string, origin: string = location.origin): string {
  const url = new URL(`/c/${encodeURIComponent(canvasId)}`, origin)
  url.searchParams.set('page', pageId)
  return url.href
}

/** The page a link naming none opens: a library canvas's components page
 *  (the server says which, as `landingPageId`), else the first page. */
export function defaultPageId(canvas: LinkedCanvas): string {
  const pages = canvasPages(canvas)
  return pages.find((page) => page.id === canvas.landingPageId)?.id ?? pages[0]!.id
}

/** The page a canvas URL's query asks for: the page of the frame it links,
 *  else the page it names, else the default. A frame or page that is not on
 *  the canvas (deleted, mistyped) counts as not named. */
export function openingPageId(canvas: LinkedCanvas, search: string): string {
  const params = new URLSearchParams(search)
  const frameId = params.get('frame')
  const frame = frameId ? canvas.frames.find((candidate) => candidate.id === frameId) : undefined
  if (frame) return framePageId(canvas, frame)
  const pageId = params.get('page')
  if (pageId && canvasPages(canvas).some((page) => page.id === pageId)) return pageId
  return defaultPageId(canvas)
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
