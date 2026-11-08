/**
 * A turned element's selection furniture. The runtime reports an element's
 * rendered bounds (`rect`, axis-aligned), its own turn (`rotation`, degrees
 * clockwise) and its box before that turn (`box`); the grips, the outline
 * and the rotate zones are drawn on the box and turned with it about the
 * centre of the bounds, as Figma draws a rotated layer's selection.
 */

export interface Box {
  width: number
  height: number
}

export interface Bounds extends Box {
  x: number
  y: number
}

/** Where the selection furniture of an element sits: its unturned box,
 *  centred on its rendered bounds and turned by its rotation. An unturned
 *  element's furniture is its bounds, untransformed. */
export function selectionBox(
  rect: Bounds,
  rotation = 0,
  box: Box = rect,
): { left: number; top: number; width: number; height: number; transform?: string } {
  if (!rotation) return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
  return {
    left: rect.x + rect.width / 2,
    top: rect.y + rect.height / 2,
    width: box.width,
    height: box.height,
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
  }
}

/** A pointer's travel turned into a turned element's own axes, so a pull
 *  on its east side grows its width whichever way it points on screen. */
export function derotateDelta(delta: { dx: number; dy: number }, rotation: number): { dx: number; dy: number } {
  if (!rotation) return delta
  const rad = (-rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { dx: delta.dx * cos - delta.dy * sin, dy: delta.dx * sin + delta.dy * cos }
}
