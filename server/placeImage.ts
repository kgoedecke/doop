import { canvasImageHtml, placedImageSize } from '../shared/canvasImage.ts'
import { canvasPages } from '../shared/pages.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import * as actions from './actions.ts'
import { imageSize } from './imageSize.ts'
import { pageListText } from './pageTools.ts'

/**
 * Placing an uploaded image on the canvas, as dropping a file on it does: a
 * standalone image element (shared/canvasImage.ts) the size of the picture.
 * upload_asset's `place` asks for it, in the tool call for a remote or base64
 * image and on the upload ticket for a local file.
 */

/** Where an uploaded image lands. Everything is optional: unplaced, it goes
 *  to the right of the page's frames at its own size. */
export interface ImagePlacement {
  x?: number
  y?: number
  pageId?: string
  name?: string
  /** design px; the height follows the picture's proportions */
  width?: number
}

const DEFAULT_IMAGE_NAME = 'Image'
const MAX_IMAGE_NAME = 80

/** Why `placement` cannot be honoured on `canvas`, said before any bytes are
 *  stored, or undefined when it can. */
export function placementError(canvas: Canvas, placement: ImagePlacement): string | undefined {
  if (placement.pageId !== undefined && !canvasPages(canvas).some((page) => page.id === placement.pageId))
    return `no page ${placement.pageId} on this canvas — the pages are: ${pageListText(canvas)}`
  return undefined
}

/** The name a file at `url` is known by: its last path segment without the
 *  extension. */
export function imageNameFromUrl(url: string): string | undefined {
  try {
    const segment = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return segment.replace(/\.[a-z0-9]+$/i, '').trim() || undefined
  } catch {
    return undefined
  }
}

function placedSize(buf: Buffer, mime: string, width: number | undefined) {
  const natural = imageSize(buf, mime)
  if (width === undefined) return placedImageSize(natural)
  return { width, height: Math.max(1, Math.round((width * natural.height) / natural.width)) }
}

/** What an agent is told once its upload was asked onto the canvas. */
export function placedImageResult(frame: Frame | undefined) {
  if (!frame)
    return {
      note: 'Uploaded, but not placed: the canvas or page is gone, or you can no longer edit it. The permanent public URL still works.',
    }
  const { id, pageId, name, x, y, width, height } = frame
  return {
    frame: { id, pageId, name, x, y, width, height },
    note: 'Uploaded and placed on the canvas as a standalone image element (frame id above): move or resize it with update_frame, remove it with delete_frame. The permanent public URL also works in any frame HTML.',
  }
}

/** Put the stored image at `url` on the canvas. Undefined when the canvas or
 *  the page is gone, which a ticket redeemed minutes later can meet. */
export function placeImage(
  canvasId: string,
  image: { url: string; buf: Buffer; mime: string },
  placement: ImagePlacement,
  actor: Actor,
): Frame | undefined {
  const name = (placement.name?.trim() || DEFAULT_IMAGE_NAME).slice(0, MAX_IMAGE_NAME)
  return actions.createFrame(
    canvasId,
    {
      name,
      pageId: placement.pageId,
      x: placement.x,
      y: placement.y,
      ...placedSize(image.buf, image.mime, placement.width),
      html: canvasImageHtml(image.url, name),
    },
    actor,
    { reveal: false },
  )
}
