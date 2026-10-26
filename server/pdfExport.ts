import { PDFDocument } from 'pdf-lib'
import type { Canvas, Frame } from '../shared/types.ts'
import { readingOrder } from '../shared/frameOrder.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import { MAX_PDF_FRAMES, PDF_RENDER_CONCURRENCY } from '../shared/pdfLimits.ts'
import { findBrowserPath, loadFramePage } from './screenshot.ts'

/**
 * Vector PDF export: each frame prints through headless Chrome onto one page
 * the size of the frame, so text stays selectable and shapes stay sharp, and
 * the pages are joined into one document in the order the frames were picked
 * (canvas reading order for a whole page).
 */

export { MAX_PDF_FRAMES }

/** Chrome's paper limit is 200 inches (19,200 CSS px) a side; larger frames
 *  print scaled down to fit rather than split or clip. */
const MAX_PAGE_PX = 19_200

/** Chrome's own print-scale floor. */
const MIN_PRINT_SCALE = 0.1

const FONT_WAIT_MS = 3000

export const PDF_UNAVAILABLE_MESSAGE =
  'PDF export is unavailable: this server has no Chrome or Chromium to render with (set CHROME_PATH)'

/** Thrown when the server has no browser to print with. */
export class PdfRendererUnavailableError extends Error {
  constructor() {
    super(PDF_UNAVAILABLE_MESSAGE)
    this.name = 'PdfRendererUnavailableError'
  }
}

export function pdfRendererAvailable(): boolean {
  return findBrowserPath() !== null
}

interface PageSize {
  width: number
  height: number
  scale: number
}

/** The paper for a frame, in CSS px, and the print scale that lays the
 *  frame out at its own width on it. */
export function pageSizeFor(frame: Pick<Frame, 'width' | 'height'>): PageSize {
  const width = Math.max(1, Math.round(frame.width))
  const height = Math.max(1, Math.round(frame.height))
  const scale = Math.max(MIN_PRINT_SCALE, Math.min(1, MAX_PAGE_PX / Math.max(width, height)))
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale }
}

async function waitForFonts(page: Awaited<ReturnType<typeof loadFramePage>>['page']): Promise<void> {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, FONT_WAIT_MS))
  const ready = page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined)
  await Promise.race([ready, timeout])
}

/** One frame as a single-page PDF. */
export async function renderFramePdfPage(frame: Frame): Promise<Uint8Array> {
  if (!pdfRendererAvailable()) throw new PdfRendererUnavailableError()
  const loaded = await loadFramePage(frame)
  const { page } = loaded
  try {
    const size = pageSizeFor(frame)
    await page.setViewport({
      width: Math.max(1, Math.round(frame.width)),
      height: Math.max(1, Math.round(frame.height)),
      deviceScaleFactor: 1,
    })
    await page.emulateMediaType('screen')
    await waitForFonts(page)
    return await page.pdf({
      width: `${size.width}px`,
      height: `${size.height}px`,
      scale: size.scale,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true,
      preferCSSPageSize: false,
      /* content running past the frame's bottom edge would spill onto a
         second sheet; the frame is the first one only */
      pageRanges: '1',
      timeout: 30_000,
    })
  } finally {
    await loaded.close()
  }
}

/**
 * `run` over `items`, at most `limit` at once, results in input order. After
 * the first failure no further item starts, and the rejection waits for the
 * runs already under way to settle, so none is left rendering (or holding a
 * browser page) once the caller has given up.
 */
export async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await run(items[index]!)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker))
  const rejected = settled.find((outcome) => outcome.status === 'rejected')
  if (rejected) throw rejected.reason
  return results
}

/** Frames as one PDF, a page per frame (each sized to its frame), in the
 *  order given; `selectPdfFrames` decides that order. */
export async function renderFramesPdf(frames: readonly Frame[]): Promise<Buffer> {
  if (!frames.length) throw new Error('No frames to export')
  if (frames.length > MAX_PDF_FRAMES) throw new Error(`A PDF holds at most ${MAX_PDF_FRAMES} frames`)
  if (!pdfRendererAvailable()) throw new PdfRendererUnavailableError()
  /* snapshots: an edit landing mid-render must not mix two versions */
  const snapshots = frames.map((frame) => ({ ...frame }))
  const pages = await mapLimited(snapshots, PDF_RENDER_CONCURRENCY, renderFramePdfPage)
  const merged = await PDFDocument.create()
  for (const bytes of pages) {
    const source = await PDFDocument.load(bytes)
    const [copied] = await merged.copyPages(source, [0])
    if (copied) merged.addPage(copied)
  }
  merged.setProducer('Doop')
  merged.setCreator('Doop')
  return Buffer.from(await merged.save())
}

export type PdfFrameSelection = { ok: true; frames: Frame[] } | { ok: false; status: 400 | 404; error: string }

/**
 * The frames a PDF of `canvas` covers, in page order: the listed ids in the
 * order listed (any page, hidden ones included, since they were asked for by
 * name), or else every visible frame on `pageId`, the first page when that is
 * unset too, in reading order (rows top to bottom, each row left to right).
 */
export function selectPdfFrames(canvas: Canvas, request: { frameIds?: string[]; pageId?: string }): PdfFrameSelection {
  let frames: Frame[]
  if (request.frameIds?.length) {
    const ids = [...new Set(request.frameIds)]
    const byId = new Map(canvas.frames.map((frame) => [frame.id, frame]))
    frames = ids.flatMap((id) => byId.get(id) ?? [])
    if (frames.length !== ids.length) return { ok: false, status: 404, error: 'Some frames are not on this canvas' }
  } else {
    const pages = canvasPages(canvas)
    const pageId = request.pageId ?? pages[0]!.id
    if (!pages.some((page) => page.id === pageId)) return { ok: false, status: 404, error: 'No such page' }
    frames = readingOrder(pageFrames(canvas, pageId).filter((frame) => !frame.hidden))
  }
  if (!frames.length) return { ok: false, status: 400, error: 'There are no frames to export' }
  if (frames.length > MAX_PDF_FRAMES)
    return { ok: false, status: 400, error: `A PDF holds at most ${MAX_PDF_FRAMES} frames — export fewer at once` }
  return { ok: true, frames }
}

/* Every page is a full browser render: meter exports per account. */
const PDF_EXPORTS_PER_MIN = 6
const exportHits = new Map<string, number[]>()

/** Claims one export from `key`'s per-minute budget; false when it is spent. */
export function takePdfExportSlot(key: string, now = Date.now()): boolean {
  const hits = (exportHits.get(key) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= PDF_EXPORTS_PER_MIN) {
    exportHits.set(key, hits)
    return false
  }
  hits.push(now)
  exportHits.set(key, hits)
  return true
}

/** A download name for the PDF: the frame's name for one frame, else the canvas's. */
export function pdfFileName(canvas: Canvas, frames: readonly Frame[]): string {
  const name = frames.length === 1 ? frames[0]!.name : canvas.name
  return `${name.replace(/[^\w\- ]+/g, '').trim() || 'doop'}.pdf`
}
