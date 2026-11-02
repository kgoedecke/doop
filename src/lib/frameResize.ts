/**
 * The geometry of resizing a frame from the stage: a grip in each corner and
 * a grabbable edge on each side, like an element's (`elementResize.ts`). A
 * frame sits at an absolute place on the canvas, so pulling a west or north
 * side moves that edge and keeps the far one still — the drag changes the
 * box, not where its other corner was.
 */
import { movesHeight, movesWidth, resizedSize, type ResizeDelta, type ResizeHandle } from './elementResize'
import type { SnapGuide } from './snap'

export interface FrameRect {
  x: number
  y: number
  width: number
  height: number
}

/** The smallest frame a drag or the Inspector can leave behind: one pixel. */
export const MIN_FRAME_SIZE = 1

/** The rect a drag on `handle` asks for, in whole world px: the size grows
 *  along the handle's axes (Shift keeps the aspect ratio), and a west or
 *  north edge moves so the opposite edge stays where it was. */
export function resizeFrameRect(
  handle: ResizeHandle,
  orig: FrameRect,
  delta: ResizeDelta,
  { keepRatio = false }: { keepRatio?: boolean } = {},
): FrameRect {
  const size = resizedSize(handle, orig, delta, { keepRatio })
  return {
    x: handle.includes('w') ? orig.x + orig.width - size.width : orig.x,
    y: handle.includes('n') ? orig.y + orig.height - size.height : orig.y,
    width: Math.max(MIN_FRAME_SIZE, size.width),
    height: Math.max(MIN_FRAME_SIZE, size.height),
  }
}

/** Which edge of each axis a handle drags, if any: the snapping edge. */
export function movingEdges(handle: ResizeHandle): { x: 'start' | 'end' | null; y: 'start' | 'end' | null } {
  return {
    x: movesWidth(handle) ? (handle.includes('w') ? 'start' : 'end') : null,
    y: movesHeight(handle) ? (handle.includes('n') ? 'start' : 'end') : null,
  }
}

/** A Shift resize after snapping: a snap moves one axis on its own, so the
 *  axis that snapped leads and the other follows the original ratio, with
 *  the frame re-anchored the way the handle anchors it. Only the leading
 *  axis's guide is kept; a snap on both axes lets the width lead. With no
 *  snap the rect comes back as it was. */
export function keepRatioAfterSnap(
  handle: ResizeHandle,
  orig: FrameRect,
  raw: FrameRect,
  snapped: FrameRect & { guides: SnapGuide[] },
): FrameRect & { guides: SnapGuide[] } {
  if (orig.width <= 0 || orig.height <= 0) return snapped
  const lead = snapped.width !== raw.width ? 'width' : snapped.height !== raw.height ? 'height' : null
  if (!lead) return snapped
  const ratio = orig.width / orig.height
  const width = lead === 'width' ? snapped.width : Math.max(MIN_FRAME_SIZE, Math.round(snapped.height * ratio))
  const height = lead === 'height' ? snapped.height : Math.max(MIN_FRAME_SIZE, Math.round(snapped.width / ratio))
  return {
    x: handle.includes('w') ? orig.x + orig.width - width : orig.x,
    y: handle.includes('n') ? orig.y + orig.height - height : orig.y,
    width,
    height,
    guides: snapped.guides.filter((g) => g.axis === (lead === 'width' ? 'v' : 'h')),
  }
}
