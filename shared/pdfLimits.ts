/**
 * The PDF export's render budget, shared so the browser waits as long as the
 * server may take: frames print a few at a time, each through its own
 * headless Chrome page.
 */

/** The most frames one PDF may hold; each costs a full browser render. */
export const MAX_PDF_FRAMES = 40

/** Frames printed at once. Every render holds its own browser context. */
export const PDF_RENDER_CONCURRENCY = 3

/** The longest one frame's render may take: the page load (8s), the font
 *  wait (3s) and the print (30s) the server allows it, with room to spare. */
export const PDF_FRAME_RENDER_MS = 60_000

/** How long a PDF of `frameCount` frames may take to render end to end. */
export function pdfRenderBudgetMs(frameCount: number): number {
  const waves = Math.ceil(Math.max(1, frameCount) / PDF_RENDER_CONCURRENCY)
  return waves * PDF_FRAME_RENDER_MS
}
