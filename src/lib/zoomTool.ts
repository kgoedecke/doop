/* The Zoom tool (Z held): a click zooms in on the point under the
   pointer, an ⌥-click zooms out from it, and a drag zooms onto the box it
   draws. Points here are stage px (the stage's top-left is 0, 0). */

import type { StageInsets } from './viewFit'

export interface Camera {
  x: number
  y: number
  zoom: number
}

export interface ZoomLimits {
  min: number
  max: number
}

/** one click's step: in doubles the zoom, out halves it */
export const ZOOM_TOOL_STEP = 2

/** a drag shorter than this (screen px, either axis) is a click */
export const ZOOM_DRAG_MIN = 4

/** the camera zoomed by `factor`, the world point under `at` staying put */
export function zoomAtPoint(vp: Camera, at: { x: number; y: number }, factor: number, limits: ZoomLimits): Camera {
  const zoom = Math.min(limits.max, Math.max(limits.min, vp.zoom * factor))
  const scale = zoom / vp.zoom
  return { x: at.x - (at.x - vp.x) * scale, y: at.y - (at.y - vp.y) * scale, zoom }
}

/** the camera that fills the stage's uncovered area with the stage-px box a
 *  drag drew, centred there; unlike a fit, no padding, so what was boxed is
 *  what is seen */
export function zoomToBox(
  vp: Camera,
  box: { x: number; y: number; width: number; height: number },
  stage: { width: number; height: number },
  insets: StageInsets,
  limits: ZoomLimits,
): Camera {
  const width = Math.max(1, stage.width - insets.left - insets.right)
  const height = Math.max(1, stage.height - insets.top - insets.bottom)
  const factor = Math.min(width / Math.max(1, box.width), height / Math.max(1, box.height))
  const zoom = Math.min(limits.max, Math.max(limits.min, vp.zoom * factor))
  /* the box's centre, in world units, lands on the open area's centre */
  const cx = (box.x + box.width / 2 - vp.x) / vp.zoom
  const cy = (box.y + box.height / 2 - vp.y) / vp.zoom
  return {
    x: insets.left + width / 2 - cx * zoom,
    y: insets.top + height / 2 - cy * zoom,
    zoom,
  }
}
