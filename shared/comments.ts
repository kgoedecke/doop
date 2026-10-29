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
