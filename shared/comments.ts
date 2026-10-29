import type { ElementComment } from './types.ts'

/** A comment pinned to a point on the canvas rather than to an element. */
export type CanvasComment = ElementComment & { frameId?: undefined; pageId: string; x: number; y: number }

export function isCanvasComment(c: ElementComment): c is CanvasComment {
  return c.frameId === undefined && c.pageId !== undefined && c.x !== undefined && c.y !== undefined
}

/** The anchor of a comment on a frame as a whole: a Comment-tool click on the
 *  frame's own background, where no element sits under the pointer. */
export const FRAME_COMMENT_SELECTOR = 'body'

/** A comment on a frame as a whole, pinned at the point clicked (design px
 *  from the frame's top-left). */
export type FrameComment = ElementComment & { frameId: string; x: number; y: number }

export function isFrameComment(c: ElementComment): c is FrameComment {
  return c.frameId !== undefined && c.selector === FRAME_COMMENT_SELECTOR && c.x !== undefined && c.y !== undefined
}

/** Where a thread is pinned after a move: on an element (frame + selector),
 *  on a frame as a whole (`FRAME_COMMENT_SELECTOR` plus the point in design
 *  px), or on the canvas (a page and a world point). The root and every
 *  reply take the new anchor together, so a thread never straddles two. */
export type CommentAnchorInput =
  | { frameId: string; selector: string; snippet: string; x?: number; y?: number }
  | { pageId: string; x: number; y: number }

/** Whether a dropped anchor is where the thread already sits: the same
 *  element, or a frame-wide or canvas pin at the same point. */
export function sameCommentAnchor(c: ElementComment, anchor: CommentAnchorInput): boolean {
  if ('frameId' in anchor) {
    if (c.frameId !== anchor.frameId || c.selector !== anchor.selector) return false
    return anchor.selector !== FRAME_COMMENT_SELECTOR || (c.x === anchor.x && c.y === anchor.y)
  }
  return c.frameId === undefined && c.pageId === anchor.pageId && c.x === anchor.x && c.y === anchor.y
}
