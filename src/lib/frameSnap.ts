/* A frame's document is its own composited layer, scaled by the camera. Where
   its edge falls between device pixels the compositor blends that last pixel
   with whatever is nearby, and any white there (the backdrop behind the
   iframe, or the document's own body under a dark design) shows as a light
   line between a dark design and a dark canvas. So at rest every frame's box
   sits on whole device pixels: the camera's offset is rounded (Stage), and
   each frame is nudged and stretched by at most half a device pixel
   (FrameView). No edge pixel is partly covered, so nothing can blend into it.
   The snap needs the white behind a frame kept one screen pixel inside its
   edge (FrameView's surface): measured in Chrome, a snapped frame with white
   painted to the edge still showed the line, and so did an unsnapped one
   whose own body was white. Together neither does. */

export type SnapBox = { x: number; y: number; width: number; height: number }

/** What a snap depends on besides the frame's own box. The camera's offset is
 *  not part of it: rounded to device pixels, it moves every edge by a whole
 *  number of them. */
export type SnapScale = { zoom: number; dpr: number }

/** A camera offset moved to the nearest one that puts the world's origin on a
 *  device pixel. `origin` is where the stage starts in the window, in CSS px. */
export function snapCameraOffset(offset: number, origin: number, dpr: number): number {
  if (!(dpr > 0)) return offset
  return Math.round((origin + offset) * dpr) / dpr - origin
}

/* corrections smaller than these are float noise, not a snap */
const SHIFT_NOISE = 1e-6
const STRETCH_NOISE = 1e-9

type AxisSnap = { shift: number; stretch: number }

/** One axis of a box, in design px, onto device pixels: both edges are
 *  rounded on their own, so two boxes sharing an edge keep sharing it. */
function snapAxis(start: number, size: number, devicePerDesign: number): AxisSnap {
  const from = start * devicePerDesign
  const to = (start + size) * devicePerDesign
  const snappedFrom = Math.round(from)
  /* never rounded away: a sliver stays one device pixel */
  const snappedTo = Math.max(snappedFrom + 1, Math.round(to))
  return { shift: (snappedFrom - from) / devicePerDesign, stretch: (snappedTo - snappedFrom) / (to - from) }
}

/** The transform (origin top left, in the frame's own design px) that puts a
 *  frame's box on whole device pixels at this zoom, or null when it already
 *  is, or cannot be. */
export function frameSnapTransform(box: SnapBox, scale: SnapScale): string | null {
  const devicePerDesign = scale.zoom * scale.dpr
  if (!(devicePerDesign > 0) || !(box.width > 0) || !(box.height > 0)) return null
  const x = snapAxis(box.x, box.width, devicePerDesign)
  const y = snapAxis(box.y, box.height, devicePerDesign)
  const still = (axis: AxisSnap) => Math.abs(axis.shift) < SHIFT_NOISE && Math.abs(axis.stretch - 1) < STRETCH_NOISE
  if (still(x) && still(y)) return null
  return `translate(${x.shift}px, ${y.shift}px) scale(${x.stretch}, ${y.stretch})`
}

/* The scale frames are snapped for: published by the Stage once the camera's
   zoom settles, read by every FrameView without a render (a snap is a style
   write, and a settle must not re-render every frame). */
let settled: SnapScale | null = null
const listeners = new Set<() => void>()

export function snapScale(): SnapScale | null {
  return settled
}

export function settleSnapScale(next: SnapScale | null): void {
  if (next?.zoom === settled?.zoom && next?.dpr === settled?.dpr) return
  settled = next
  for (const listener of listeners) listener()
}

export function subscribeSnapScale(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Calls back whenever the window's device pixel ratio changes (another
 *  display, browser zoom). A resolution query matches one ratio only, so it
 *  is re-armed after every change. */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  let query: MediaQueryList | null = null
  function arm() {
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener('change', changed, { once: true })
  }
  function changed() {
    arm()
    onChange()
  }
  arm()
  return () => query?.removeEventListener('change', changed)
}
