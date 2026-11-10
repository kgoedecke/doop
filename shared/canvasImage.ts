/**
 * An image placed on the canvas is a standalone element: a transparent shell
 * the size of its one image, which the Layers panel lists at the root under
 * its name. The browser builds one for a pasted or dropped file, the server
 * for an agent's upload_asset with `place`; both build it here, so the two
 * cannot drift.
 */

/** Images larger than this are scaled down when placed (a retina screenshot
 *  would otherwise land enormous); the asset keeps its full resolution. */
export const MAX_PLACED_IMAGE_DIM = 900

/** A placed bitmap's shell is never smaller than this a side, so it stays
 *  grabbable. */
const MIN_PLACED_IMAGE_DIM = 40

export interface ImageSize {
  width: number
  height: number
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The whole document of a standalone image element showing `url`. */
export function canvasImageHtml(url: string, name: string): string {
  const fill = 'width:100%;height:100%;margin:0;'
  const image =
    'position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;margin:0;display:block;object-fit:contain;'
  const label = escapeAttribute(name)
  return (
    '<!doctype html>\n' +
    `<html style="${fill}"><head></head><body style="${fill}" data-doop-canvas-element="true">` +
    `<img data-doop-drawing="image" data-name="${label}" src="${escapeAttribute(url)}" alt="${label}" style="${image}">` +
    '</body></html>'
  )
}

/** The shell an image of `natural` size gets: its own size, scaled down to
 *  fit MAX_PLACED_IMAGE_DIM. */
export function placedImageSize(natural: ImageSize): ImageSize {
  const scale = Math.min(1, MAX_PLACED_IMAGE_DIM / Math.max(natural.width, natural.height))
  return {
    width: Math.max(MIN_PLACED_IMAGE_DIM, Math.round(natural.width * scale)),
    height: Math.max(MIN_PLACED_IMAGE_DIM, Math.round(natural.height * scale)),
  }
}
