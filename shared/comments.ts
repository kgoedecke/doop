import type { ElementComment } from './types.ts'

/** A comment pinned to a point on the canvas rather than to an element. */
export type CanvasComment = ElementComment & { frameId?: undefined; pageId: string; x: number; y: number }

export function isCanvasComment(c: ElementComment): c is CanvasComment {
  return c.frameId === undefined && c.pageId !== undefined && c.x !== undefined && c.y !== undefined
}

/** What the frame runtime answers for a click on the frame's own background,
 *  where no element sits under the pointer; the server reads it, like an
 *  empty selector, as "no element": the comment goes on the frame at the point. */
export const FRAME_COMMENT_SELECTOR = 'body'

/** A comment on one element inside a frame, found again by its `data-doop-id`. */
export type ElementAnchoredComment = ElementComment & { frameId: string; elementId: string }

export function isElementComment(c: ElementComment): c is ElementAnchoredComment {
  return c.frameId !== undefined && c.elementId !== undefined
}

/** A comment on a frame as a whole, pinned at the point clicked (design px
 *  from the frame's top-left): a Comment-tool click on the frame's own
 *  background, where no element sits under the pointer. */
export type FrameComment = ElementComment & { frameId: string; elementId?: undefined; x: number; y: number }

export function isFrameComment(c: ElementComment): c is FrameComment {
  return c.frameId !== undefined && c.elementId === undefined && c.x !== undefined && c.y !== undefined
}

/** Where a thread is pinned after a move. On a frame, `selector` is the
 *  positional path of the element under the pointer in the live document
 *  (the server stamps its `data-doop-id` from it), `elementId` the id it
 *  already carries if any, and the point is where the pin was let go, which
 *  the frame-wide pin sits at when there is no element. Off every frame it is
 *  a page and a world point. The root and every reply take the new anchor
 *  together, so a thread never straddles two. */
export type CommentAnchorInput =
  | { frameId: string; selector?: string; elementId?: string; snippet?: string; x: number; y: number }
  | { pageId: string; x: number; y: number }

/** Whether a dropped anchor is where the thread already sits: the same
 *  element, or a frame-wide or canvas pin at the same point. */
export function sameCommentAnchor(c: ElementComment, anchor: CommentAnchorInput): boolean {
  if ('frameId' in anchor) {
    if (c.frameId !== anchor.frameId) return false
    if (anchor.selector || anchor.elementId) return c.elementId !== undefined && c.elementId === anchor.elementId
    return c.elementId === undefined && c.x === anchor.x && c.y === anchor.y
  }
  return c.frameId === undefined && c.pageId === anchor.pageId && c.x === anchor.x && c.y === anchor.y
}
