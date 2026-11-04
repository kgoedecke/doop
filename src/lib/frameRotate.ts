/**
 * The rotate affordance a selected frame wears, the way Figma draws it: a
 * zone just outside each corner that shows a curved double-arrow cursor, and
 * a drag there turns the frame about its centre (`shared/frameRotation.ts`
 * does the angles). The cursor's arrows follow the corner they sit at and
 * the frame's current rotation, so they always curve around the frame.
 */
import type { ResizeHandle } from './elementResize'

export type RotateCorner = Extract<ResizeHandle, 'nw' | 'ne' | 'se' | 'sw'>

export const ROTATE_CORNERS: readonly RotateCorner[] = ['nw', 'ne', 'se', 'sw']

/** On-screen px: the zone is a square whose inner corner touches the
 *  corner grip's hit box, so a pointer just past the grip rotates and one
 *  on it resizes. */
export const ROTATE_ZONE_PX = 18

/** How far the zone's near corner sits from the frame's corner, on screen:
 *  the corner grip's own hit box reaches half that far, and the zone must
 *  not cover it. */
export const ROTATE_ZONE_INSET_PX = 7

/** Where a corner's zone sits relative to the frame: which way it extends
 *  (-1 away towards the top/left, +1 towards the bottom/right). */
export function rotateZoneSide(corner: RotateCorner): { x: -1 | 1; y: -1 | 1 } {
  return { x: corner.endsWith('w') ? -1 : 1, y: corner.startsWith('n') ? -1 : 1 }
}

/** The glyph's turn for a corner: drawn for the north-east corner, where
 *  the arc bows up and to the right, between a head pointing left and a
 *  head pointing down. */
const CORNER_TURN: Record<RotateCorner, number> = { ne: 0, se: 90, sw: 180, nw: 270 }

/** The angle the cursor glyph is drawn at for `corner` on a frame turned by
 *  `rotation` degrees. */
export function rotateCursorAngle(corner: RotateCorner, rotation: number): number {
  return (((CORNER_TURN[corner] + rotation) % 360) + 360) % 360
}

/* The glyph, in a 24px box, as Figma draws it: a head pointing left at the
   top-left (tip 3,7; base the vertical line x=8 from y=4 to y=10), a head
   pointing down at the bottom-right (tip 17,21; base the horizontal line
   y=16 from x=14 to x=20), and a quarter circle of radius 9 from the centre
   of one base to the centre of the other, leaving the first base
   horizontally and arriving at the second vertically, so the line meets
   each head flat and square. Ink over a paper outline; tagged
   data-cursor='rotate' so a test can tell it apart. */
const CURSOR_PX = 24
const GLYPH_ARC = 'M8 7 A9 9 0 0 1 17 16'
const GLYPH_HEADS = 'M3 7 L8 4 L8 10 Z M17 21 L14 16 L20 16 Z'

function rotateCursorSvg(angle: number): string {
  const outlineLine = 'fill="none" stroke="#fff" stroke-width="3.4"'
  const outlineHead = 'fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="miter" stroke-miterlimit="6"'
  const inkLine = 'fill="none" stroke="#17171b" stroke-width="1.5"'
  const inkHead = 'fill="#17171b" stroke="none"'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_PX}" height="${CURSOR_PX}" viewBox="0 0 ${CURSOR_PX} ${CURSOR_PX}" data-cursor="rotate">` +
    `<g transform="rotate(${angle} ${CURSOR_PX / 2} ${CURSOR_PX / 2})">` +
    `<path d="${GLYPH_ARC}" ${outlineLine}/><path d="${GLYPH_HEADS}" ${outlineHead}/>` +
    `<path d="${GLYPH_ARC}" ${inkLine}/><path d="${GLYPH_HEADS}" ${inkHead}/>` +
    `</g></svg>`
  )
}

const cursorCache = new Map<number, string>()

/** The CSS `cursor` for a rotate zone: the glyph turned to curve around
 *  its corner. Angles are rounded to whole degrees so a drag does not
 *  mint a new image on every move. */
export function rotateCursor(corner: RotateCorner, rotation: number): string {
  const angle = Math.round(rotateCursorAngle(corner, rotation)) % 360
  let cursor = cursorCache.get(angle)
  if (!cursor) {
    cursor = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(rotateCursorSvg(angle))}") ${CURSOR_PX / 2} ${CURSOR_PX / 2}, grab`
    cursorCache.set(angle, cursor)
  }
  return cursor
}
