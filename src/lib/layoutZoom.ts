/* The canvas world is laid out at CSS zoom k and each frame iframe undoes it
   with zoom 1/k (Stage, FrameView). Chromium and WebKit multiply zoom in
   float32, and for about a quarter of all k the plain 1/k leaves the iframe's
   effective zoom at 0.99999994 instead of 1: the frame document then lays out
   a hair off its design size and re-lays out on every such settle. So k is
   snapped to a float32 that has an exact float32 inverse (at most one ulp
   away, ~1e-7 of the zoom), and the iframe gets that inverse. */

const MAX_ULP_STEPS = 4

/** Chromium passes an iframe's CSS zoom into its document as pixel density,
 *  leaving the document's layout at design px, so frames there need no
 *  counter-zoom. Sandboxed frames run out of process in Chromium and ignore
 *  the element's transform when picking a raster scale, so the counter-zoom
 *  left them stretched from 1×. Other engines keep the counter-zoom. */
export const FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY =
  typeof navigator !== 'undefined' && /(Chrome|Chromium|Edg)\//.test(navigator.userAgent)

/** Step a float32 by whole ulps. */
function float32Neighbour(value: number, steps: number): number {
  const bits = new Float32Array([value])
  const word = new Uint32Array(bits.buffer)
  word[0] = (word[0] ?? 0) + steps
  return bits[0] ?? value
}

/** The float32 z with fround(k * z) === 1 exactly, for a float32 k, if any. */
function exactInverse(k: number): number | null {
  const near = Math.fround(1 / k)
  for (const steps of [0, 1, -1]) {
    const z = float32Neighbour(near, steps)
    if (Math.fround(k * z) === 1) return z
  }
  return null
}

/* zooms this close below a whole number count as that number, so float noise
   in a camera zoom of exactly 2 never lays the world out at 3 */
const WHOLE_ZOOM_SLACK = 1e-3

/** The layout zoom for a settled camera zoom, clamped to [1, max]. Where
 *  frames take the zoom as pixel density it is rounded up to a whole number:
 *  the iframe's box is snapped to whole pixels, so only a whole k keeps every
 *  integer design size (and with it the frame's viewport and vh) exact, and
 *  the world's transform then scales the denser raster down, which stays
 *  sharp. Elsewhere it is the nearest float32 the iframes can undo exactly. */
export function layoutZoomFor(zoom: number, max: number, density = FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY): number {
  const clamped = Math.min(max, Math.max(1, zoom))
  if (density) return Math.min(max, Math.ceil(clamped - WHOLE_ZOOM_SLACK))
  const k = Math.fround(clamped)
  for (let step = 0; step <= MAX_ULP_STEPS; step++) {
    for (const candidate of [float32Neighbour(k, step), float32Neighbour(k, -step)]) {
      if (candidate >= 1 && exactInverse(candidate) !== null) return candidate
    }
  }
  return k
}

/** The iframe's zoom that undoes a layout zoom from layoutZoomFor exactly. */
export function counterZoom(k: number): number {
  return exactInverse(Math.fround(k)) ?? 1 / k
}
