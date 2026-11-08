import { canvasPages, framePageId } from './pages.ts'
import type { Canvas, Frame, FrameHtml } from './types.ts'

/* A canvas is opened on one page. The frames of every other page travel
   without their HTML (`htmlDeferred`) and the client asks for it when the
   page is opened: a canvas of thousands of frames is megabytes of markup the
   person never looks at. The helpers here are the one rule for what is sent
   when, shared by the room, the REST read and the tests. */

/** Most frame ids one `frames:load` may name. */
export const MAX_LOAD_FRAME_IDS = 500

/** Characters of HTML after which a `frames:html` batch is closed, so a big
 *  page reaches the client as a stream of messages it can paint from
 *  instead of one that holds everything back until it has all arrived. */
export const FRAME_HTML_BATCH_CHARS = 1_000_000

/** The page a joining client opens on: the one it names, else the page of the
 *  frame it names (a deep link), else the first. Anything that is not a page
 *  or frame of this canvas is ignored, so a stale link still opens. */
export function openingPageId(canvas: Canvas, wanted: { pageId?: unknown; frameId?: unknown }): string {
  const pages = canvasPages(canvas)
  if (typeof wanted.pageId === 'string' && pages.some((page) => page.id === wanted.pageId)) return wanted.pageId
  const frame = typeof wanted.frameId === 'string' ? canvas.frames.find((f) => f.id === wanted.frameId) : undefined
  return frame ? framePageId(canvas, frame) : pages[0]!.id
}

/** The frame as the client receives one it is not looking at. */
export function deferFrameHtml(frame: Frame): Frame {
  return { ...frame, html: '', htmlDeferred: true }
}

/** The canvas with the HTML of `pageId`'s frames only; the others are deferred. */
export function canvasOpenedOn(canvas: Canvas, pageId: string): Canvas {
  return {
    ...canvas,
    frames: canvas.frames.map((frame) => (framePageId(canvas, frame) === pageId ? frame : deferFrameHtml(frame))),
  }
}

/** HTML of `frames` in batches of about `maxChars`: a frame larger than that
 *  is a batch of its own, none is ever split. */
export function frameHtmlBatches(frames: readonly Frame[], maxChars = FRAME_HTML_BATCH_CHARS): FrameHtml[][] {
  const batches: FrameHtml[][] = []
  let batch: FrameHtml[] = []
  let size = 0
  for (const { id, html } of frames) {
    if (batch.length && size + html.length > maxChars) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push({ id, html })
    size += html.length
  }
  if (batch.length) batches.push(batch)
  return batches
}
