/* Where the canvas-comment composer hangs off its pin. It is screen UI (the
   pin counter-scales), so everything here is in screen pixels. */

/** the composer's box (CommentComposer is w-[240px]) */
export const COMPOSER_WIDTH = 240
/** between the pin and the composer */
export const COMPOSER_GAP = 20
/** breathing room to the stage edge */
const EDGE_MARGIN = 12

export interface ComposerPlacement {
  side: 'left' | 'right'
  /** screen px to slide the composer along x so it stays on the stage when
   *  neither side has room — 0 when a side fits */
  shift: number
}

/**
 * The right of the pin is preferred, then the left; when neither fits, the
 * side with more room, slid back onto the stage. `left`/`right` bound the
 * visible stage (the open side panel overlays its right edge, so the caller
 * takes that off `right`); `x` is the pin.
 */
export function placeComposer(x: number, left: number, right: number): ComposerPlacement {
  const need = COMPOSER_GAP + COMPOSER_WIDTH + EDGE_MARGIN
  const roomRight = right - x
  const roomLeft = x - left
  if (roomRight >= need) return { side: 'right', shift: 0 }
  if (roomLeft >= need) return { side: 'left', shift: 0 }
  if (roomRight >= roomLeft) {
    /* overflowing the right edge: slide left, but never past the left edge */
    const overflow = x + COMPOSER_GAP + COMPOSER_WIDTH + EDGE_MARGIN - right
    return { side: 'right', shift: -Math.min(overflow, Math.max(0, x + COMPOSER_GAP - left - EDGE_MARGIN)) }
  }
  const underflow = left + EDGE_MARGIN - (x - COMPOSER_GAP - COMPOSER_WIDTH)
  return { side: 'left', shift: Math.min(underflow, Math.max(0, right - EDGE_MARGIN - (x - COMPOSER_GAP))) }
}
