/**
 * A frame's rotation: degrees clockwise about its centre, as `Frame.rotation`
 * carries it (unset is 0). The stage turns the whole frame with a CSS
 * rotate, so `x`/`y`/`width`/`height` stay the unrotated box, as Figma keeps
 * them; what else the rotation touches lives here, shared by the server
 * (which normalises what it stores) and the client (which drags it).
 */

/** Degrees snapped to while Shift is held, as Figma's rotate does. */
export const ROTATION_SNAP_DEG = 15

/** The rotation to store: a finite number brought into (-180, 180], rounded
 *  to a hundredth of a degree, and `undefined` for anything else (and for
 *  zero, so an unrotated frame keeps no column). */
export function normalizeRotation(deg: unknown): number | undefined {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return undefined
  let r = Math.round(((((deg % 360) + 540) % 360) - 180) * 100) / 100
  if (r === -180) r = 180
  if (Object.is(r, -0)) r = 0
  return r === 0 ? undefined : r
}

/** The angle of the vector from `center` to `point`, in degrees clockwise
 *  from the positive x axis (screen space: y grows downwards). */
export function pointerAngle(center: { x: number; y: number }, point: { x: number; y: number }): number {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI
}

/** Where a rotate gesture leaves the frame: its rotation at the press plus
 *  how far the pointer has swung around the centre since. With `snap` the
 *  result lands on the nearest multiple of ROTATION_SNAP_DEG. */
export function rotatedBy(
  startRotation: number,
  startAngle: number,
  angle: number,
  { snap = false }: { snap?: boolean } = {},
): number {
  const raw = startRotation + angle - startAngle
  const deg = snap ? Math.round(raw / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG : raw
  return normalizeRotation(deg) ?? 0
}

/** The axis-aligned box a rotated rect covers, around the same centre. */
export function rotatedBounds(rect: { x: number; y: number; width: number; height: number }, rotation: number) {
  const rad = (rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const width = rect.width * cos + rect.height * sin
  const height = rect.width * sin + rect.height * cos
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return { x: cx - width / 2, y: cy - height / 2, width, height }
}

/** A point measured from the rotated frame's on-screen bounding box,
 *  mapped back into the unrotated frame: turn it about the centre by the
 *  rotation's inverse. `bounds` is the box the browser reports for the
 *  rotated element; the result is in the same units. */
export function unrotatePoint(
  point: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
  rotation: number,
): { x: number; y: number } {
  const cx = bounds.left + bounds.width / 2
  const cy = bounds.top + bounds.height / 2
  const rad = (-rotation * Math.PI) / 180
  const dx = point.x - cx
  const dy = point.y - cy
  return {
    x: dx * Math.cos(rad) - dy * Math.sin(rad) + size.width / 2,
    y: dx * Math.sin(rad) + dy * Math.cos(rad) + size.height / 2,
  }
}

/** A vector turned by `deg` degrees clockwise (screen space). */
export function rotateVector(v: { x: number; y: number }, deg: number): { x: number; y: number } {
  if (!deg) return v
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos }
}

export interface TurnedRect {
  x: number
  y: number
  width: number
  height: number
  rotation?: number
}

/** A world point inside a frame's design, turning the frame's rotation
 *  back about its centre: where the point lands in the unrotated
 *  document, measured from the frame's top-left. */
export function frameDesignPoint(world: { x: number; y: number }, frame: TurnedRect): { x: number; y: number } {
  const d = { x: world.x - frame.x, y: world.y - frame.y }
  if (!frame.rotation) return d
  const c = { x: frame.width / 2, y: frame.height / 2 }
  const turned = rotateVector({ x: d.x - c.x, y: d.y - c.y }, -frame.rotation)
  return { x: turned.x + c.x, y: turned.y + c.y }
}

/** The inverse of `frameDesignPoint`: a design point's place on the canvas. */
export function frameWorldPoint(design: { x: number; y: number }, frame: TurnedRect): { x: number; y: number } {
  if (!frame.rotation) return { x: frame.x + design.x, y: frame.y + design.y }
  const c = { x: frame.width / 2, y: frame.height / 2 }
  const turned = rotateVector({ x: design.x - c.x, y: design.y - c.y }, frame.rotation)
  return { x: frame.x + c.x + turned.x, y: frame.y + c.y + turned.y }
}

/** The 2D matrix [a, b, c, d, e, f] that turns world points by the frame's
 *  rotation about its centre: the identity for an unturned frame. */
export function frameTurnMatrix(frame: TurnedRect): [number, number, number, number, number, number] {
  const deg = frame.rotation ?? 0
  if (!deg) return [1, 0, 0, 1, 0, 0]
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = frame.x + frame.width / 2
  const cy = frame.y + frame.height / 2
  return [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos]
}
