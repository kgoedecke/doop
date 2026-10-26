import type { CanvasGuide, Frame } from '../../shared/types'

/**
 * Alignment snapping: while a frame moves or resizes, its edges and centers
 * pull onto the matching edges/centers of the other frames on the canvas,
 * and onto the page's ruler guides. Pure math — the Stage draws the returned
 * guides, FrameView applies the snapped rect. Elements and drawings snap to
 * the ruler guides through the same tolerance.
 */

/* how close (in screen px) an edge must be before it locks on */
export const SNAP_PX = 8

export interface SnapGuide {
  /** 'v': vertical line at x=`at` spanning `from`..`to` in y; 'h': the converse */
  axis: 'v' | 'h'
  at: number
  from: number
  to: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

/** A line something can snap onto, with the span it covers along the other
 *  axis (empty for a ruler guide: it crosses the whole canvas, so the drawn
 *  snap line only needs to cover the dragged rect). */
interface Target {
  at: number
  from: number
  to: number
}

/* start / center / end of a span */
const lines = (pos: number, size: number) => [pos, pos + size / 2, pos + size]

function frameTargets(others: readonly Frame[], key: 'x' | 'y'): Target[] {
  return others.flatMap((o) =>
    lines(o[key], key === 'x' ? o.width : o.height).map((at) =>
      key === 'x' ? { at, from: o.y, to: o.y + o.height } : { at, from: o.x, to: o.x + o.width },
    ),
  )
}

function guideTargets(guides: readonly CanvasGuide[], axis: 'v' | 'h'): Target[] {
  return guides.filter((g) => g.axis === axis).map((g) => ({ at: g.at, from: Infinity, to: -Infinity }))
}

function closest(ownOffsets: number[], base: number, targets: readonly Target[], tol: number) {
  let hit: { delta: number; target: Target } | null = null
  for (const target of targets) {
    for (const offset of ownOffsets) {
      const delta = target.at - (base + offset)
      if (Math.abs(delta) <= tol && (!hit || Math.abs(delta) < Math.abs(hit.delta))) hit = { delta, target }
    }
  }
  return hit
}

/** Snap a dragged rect against the other frames and the ruler guides.
 *  Moving considers the frame's start/center/end on both axes; resizing only
 *  the moving right/bottom edges. `zoom` converts the screen-px tolerance to
 *  world units. */
export function snapFrame(
  mode: 'move' | 'resize',
  rect: Rect,
  others: readonly Frame[],
  zoom: number,
  guides: readonly CanvasGuide[] = [],
): Rect & { guides: SnapGuide[] } {
  const tol = SNAP_PX / zoom
  let { x, y, width, height } = rect
  const xTargets = [...frameTargets(others, 'x'), ...guideTargets(guides, 'v')]
  const yTargets = [...frameTargets(others, 'y'), ...guideTargets(guides, 'h')]
  let gx = closest(mode === 'move' ? lines(0, width) : [width], x, xTargets, tol)
  let gy = closest(mode === 'move' ? lines(0, height) : [height], y, yTargets, tol)
  if (mode === 'move') {
    if (gx) x += gx.delta
    if (gy) y += gy.delta
  } else {
    /* a snap that would shrink past the minimum loses to the clamp */
    if (gx && width + gx.delta >= 120) width += gx.delta
    else gx = null
    if (gy && height + gy.delta >= 80) height += gy.delta
    else gy = null
  }
  const shown: SnapGuide[] = []
  if (gx)
    shown.push({
      axis: 'v',
      at: gx.target.at,
      from: Math.min(y, gx.target.from),
      to: Math.max(y + height, gx.target.to),
    })
  if (gy)
    shown.push({
      axis: 'h',
      at: gy.target.at,
      from: Math.min(x, gy.target.from),
      to: Math.max(x + width, gy.target.to),
    })
  return { x, y, width, height, guides: shown }
}

/** How far `value` has to travel to land on the nearest guide of `axis`
 *  within the snap tolerance, or 0 when none is that close. */
export function guideDelta(value: number, guides: readonly CanvasGuide[], axis: 'v' | 'h', zoom: number): number {
  const hit = closest([0], value, guideTargets(guides, axis), SNAP_PX / zoom)
  return hit?.delta ?? 0
}

/** A point pulled onto the nearest vertical and horizontal guides — where a
 *  drawing tool starts, ends or places an anchor. */
export function snapPointToGuides(point: Point, guides: readonly CanvasGuide[], zoom: number): Point {
  return {
    x: point.x + guideDelta(point.x, guides, 'v', zoom),
    y: point.y + guideDelta(point.y, guides, 'h', zoom),
  }
}
