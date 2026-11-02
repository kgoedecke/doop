import type { Canvas, ElementComment, Frame } from '../../shared/types'
import { canvasPages, framePageId } from '../../shared/pages'
import { FRAME_COMMENT_SELECTOR, sameCommentAnchor, type CommentAnchorInput } from '../../shared/comments'
import { useStore } from './store'
import { api } from './api'
import { requestFrame } from './frameBridge'

/**
 * Moving a comment pin. The pin's pointer gesture lives in CommentPin; this
 * module turns the drop point into the thread's new anchor: the element
 * under the pointer in the frame there, the frame as a whole when no element
 * is, or the canvas itself off every frame. A pin can change kind either
 * way — an element comment dropped on empty canvas becomes a canvas comment,
 * a canvas comment dropped on a button becomes that button's comment.
 */

export interface Point {
  x: number
  y: number
}

/** Past this many screen px a press on a pin is a drag, not a click. */
export const DRAG_THRESHOLD_PX = 3

/** What the runtime answers a `doop:probe` with, as far as a pin needs. */
export interface CommentDropHit {
  selector: string
  /** the `data-doop-id` the element already carries, if any */
  elementId?: string
  snippet: string
}

/** A screen point in world px, the way the Stage maps its own presses. */
export function clientToWorld(clientX: number, clientY: number): Point {
  const stage = document.querySelector('.stage')?.getBoundingClientRect()
  const vp = useStore.getState().viewport
  return {
    x: (clientX - (stage?.left ?? 0) - vp.x) / vp.zoom,
    y: (clientY - (stage?.top ?? 0) - vp.y) / vp.zoom,
  }
}

/** The topmost visible frame on the page under a world point. Locked
 *  frames count: they can be commented on, only not edited. */
export function frameAtPoint(
  canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>,
  pageId: string | null,
  point: Point,
): Frame | undefined {
  return [...canvas.frames]
    .reverse()
    .find(
      (f) =>
        !f.hidden &&
        (pageId === null || framePageId(canvas, f) === pageId) &&
        point.x >= f.x &&
        point.y >= f.y &&
        point.x <= f.x + f.width &&
        point.y <= f.y + f.height,
    )
}

/** The anchor a pin dropped at a world point takes. `probe` asks a frame's
 *  document what sits at a design point; it answers null for the frame's
 *  own background, or when the frame cannot be asked. */
export async function resolveCommentDrop(
  canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>,
  pageId: string,
  point: Point,
  probe: (frameId: string, x: number, y: number) => Promise<CommentDropHit | null>,
): Promise<CommentAnchorInput> {
  const frame = frameAtPoint(canvas, pageId, point)
  if (!frame) return { pageId, x: point.x, y: point.y }
  const x = point.x - frame.x
  const y = point.y - frame.y
  const hit = await probe(frame.id, x, y)
  if (hit && hit.selector !== FRAME_COMMENT_SELECTOR) {
    /* the point rides along: should the element not be found in the saved
       HTML, the server pins the thread to the frame there instead */
    return {
      frameId: frame.id,
      selector: hit.selector,
      ...(hit.elementId ? { elementId: hit.elementId } : {}),
      snippet: hit.snippet,
      x,
      y,
    }
  }
  return { frameId: frame.id, snippet: '', x, y }
}

async function probeFrame(frameId: string, x: number, y: number): Promise<CommentDropHit | null> {
  const reply = await requestFrame(frameId, 'doop:probe', { x, y })
  const hit = reply?.hit as CommentDropHit | null | undefined
  if (!hit || typeof hit.selector !== 'string') return null
  return {
    selector: hit.selector,
    ...(typeof hit.elementId === 'string' ? { elementId: hit.elementId } : {}),
    snippet: hit.snippet ?? '',
  }
}

/** Re-pin the thread where its pin was let go. Nothing is sent when the
 *  drop lands where the thread already is; a refused move is reported. */
export async function dropComment(root: ElementComment, point: Point): Promise<void> {
  const s = useStore.getState()
  if (!s.canvas) return
  const pageId = s.activePageId ?? canvasPages(s.canvas)[0]!.id
  const anchor = await resolveCommentDrop(s.canvas, pageId, point, probeFrame)
  if (sameCommentAnchor(root, anchor)) return
  try {
    await api.moveComment(root.id, anchor)
  } catch (err) {
    console.error(err)
    useStore.getState().pushNotice('The comment could not be moved.')
  }
}
