/* Fitting world boxes into the part of the stage nothing covers. The stage
   spans the whole window, but the top bar and the floating panels sit over
   its edges; a fit measured against the full stage centres the selection
   under them. The insets say how far in from each edge the open canvas
   begins. */

export interface StageInsets {
  top: number
  right: number
  bottom: number
  left: number
}

export const NO_INSETS: StageInsets = { top: 0, right: 0, bottom: 0, left: 0 }

export interface WorldBox {
  x: number
  y: number
  width: number
  height: number
}

/** the room the fitted box keeps from the visible area's edges, in screen px */
export const FIT_PAD = 80

/** the room left between two insets along one axis: where it starts and how
 *  long it is. A window too narrow for the panels falls back to the whole
 *  axis rather than fitting into nothing. */
function span(size: number, start: number, end: number): { from: number; length: number } {
  const length = size - start - end
  return length > FIT_PAD * 2 ? { from: start, length } : { from: 0, length: size }
}

/** the camera that fits `box` into the stage's uncovered area, centred there,
 *  with its zoom clamped to `limits` */
export function fitBox(
  box: WorldBox,
  stage: { width: number; height: number },
  insets: StageInsets,
  limits: { min: number; max: number },
): { x: number; y: number; zoom: number } {
  const across = span(stage.width, insets.left, insets.right)
  const down = span(stage.height, insets.top, insets.bottom)
  const fits = Math.min(
    (across.length - FIT_PAD * 2) / Math.max(1, box.width),
    (down.length - FIT_PAD * 2) / Math.max(1, box.height),
  )
  const zoom = Math.min(limits.max, Math.max(limits.min, fits))
  return {
    x: across.from + (across.length - box.width * zoom) / 2 - box.x * zoom,
    y: down.from + (down.length - box.height * zoom) / 2 - box.y * zoom,
    zoom,
  }
}
