/**
 * The geometry of resizing an element inside a frame from the stage: which
 * grips the selection outline wears, and what size a drag on one of them
 * asks for. The runtime applies the result as inline `width` / `height`,
 * the same properties the Design panel's Size fields write.
 */
import type { StylePatch } from './frameBridge'

/** Four corners draw a grip; the four edges are grabbable but unmarked, the
 *  way Paper's selection reads. Flow layout places an element's left and
 *  top, so a pull on a west or north side still grows the box to the right
 *  or down: the drag changes the size, never the place. */
export type ResizeHandle = 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
export const RESIZE_CORNERS: readonly ResizeHandle[] = ['nw', 'ne', 'sw', 'se']
export const RESIZE_EDGES: readonly ResizeHandle[] = ['n', 'e', 's', 'w']

export interface Size {
  width: number
  height: number
}

export interface ResizeDelta {
  dx: number
  dy: number
}

/** The smallest box a drag can leave behind: hairline, never collapsed. */
export const MIN_ELEMENT_SIZE = 1

export function movesWidth(handle: ResizeHandle): boolean {
  return handle.includes('e') || handle.includes('w')
}

export function movesHeight(handle: ResizeHandle): boolean {
  return handle.includes('n') || handle.includes('s')
}

/** Pulling a west or north side outward is a negative pointer delta that
 *  still means "bigger". */
function signedDelta(handle: ResizeHandle, delta: ResizeDelta): ResizeDelta {
  return {
    dx: movesWidth(handle) ? (handle.includes('w') ? -delta.dx : delta.dx) : 0,
    dy: movesHeight(handle) ? (handle.includes('n') ? -delta.dy : delta.dy) : 0,
  }
}

/** The size a drag asks for: the base size (the element's computed width and
 *  height, which is what the inline value has to express) grown by the drag
 *  along the handle's axes, in whole pixels. With `keepRatio` (Shift) the
 *  other axis follows the base aspect ratio; on a corner the larger move
 *  leads. */
export function resizedSize(
  handle: ResizeHandle,
  base: Size,
  delta: ResizeDelta,
  { keepRatio = false }: { keepRatio?: boolean } = {},
): Size {
  const { dx, dy } = signedDelta(handle, delta)
  const width = base.width + dx
  const height = base.height + dy
  if (!keepRatio || base.width <= 0 || base.height <= 0) return clamp({ width, height })
  const ratio = base.width / base.height
  const widthLeads = !movesHeight(handle) || (movesWidth(handle) && Math.abs(dx) >= Math.abs(dy))
  return widthLeads ? clamp({ width, height: width / ratio }) : clamp({ width: height * ratio, height })
}

function clamp(size: Size): Size {
  return {
    width: Math.max(MIN_ELEMENT_SIZE, Math.round(size.width)),
    height: Math.max(MIN_ELEMENT_SIZE, Math.round(size.height)),
  }
}

/** The inline styles the resize writes: only the axes the gesture changed,
 *  so a width-only drag leaves an auto height alone. */
export function resizePatch(
  handle: ResizeHandle,
  size: Size,
  { keepRatio = false, flexAxis = null }: { keepRatio?: boolean; flexAxis?: 'width' | 'height' | null } = {},
): StylePatch {
  const patch: StylePatch = {}
  if (movesWidth(handle) || keepRatio) patch.width = `${size.width}px`
  if (movesHeight(handle) || keepRatio) patch.height = `${size.height}px`
  // A flex basis or grow/shrink would otherwise override the requested size.
  if (flexAxis && patch[flexAxis]) {
    Object.assign(patch, { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' })
  }
  return patch
}

/** Where a handle sits on the outline, as fractions of the element's box. */
export function handleAnchor(handle: ResizeHandle): { x: number; y: number } {
  return {
    x: handle.includes('w') ? 0 : handle.includes('e') ? 1 : 0.5,
    y: handle.includes('n') ? 0 : handle.includes('s') ? 1 : 0.5,
  }
}

export function handleCursor(handle: ResizeHandle): string {
  switch (handle) {
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
    case 'nw':
    case 'se':
      return 'nwse-resize'
    default:
      return 'nesw-resize'
  }
}

/** The size badge under a selected element: whole pixels of its box. */
export function sizeLabel(size: Size): string {
  return `${Math.round(size.width)} × ${Math.round(size.height)}`
}
