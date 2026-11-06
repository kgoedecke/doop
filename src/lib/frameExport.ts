import { pdfRenderBudgetMs } from '../../shared/pdfLimits'
import type { Frame } from '../../shared/types'
import { isDesktopShell } from './shell'
import { inspectElement } from './frameBridge'
import { clipToFrame, cropRaster, rasterizeFrame, type ClipRect } from './frameRaster'
import { useStore } from './store'
import { t } from './i18n'

export type FrameExportFormat = 'png' | 'jpg'

/** One element inside a frame, by the selector the live document answers
 *  to; `name` is what the Layers panel calls it, for the file name. */
export interface ElementTarget {
  selector: string
  name: string
}

const FORMAT_LABEL: Record<FrameExportFormat, string> = { png: 'PNG', jpg: 'JPG' }

/* Blob URLs are revoked late: in the desktop shell the save panel opens
   before WebKit reads the blob, and the person may take a while to pick. */
const BLOB_URL_LIFETIME_MS = 10 * 60_000

export function frameExportUrl(frame: Frame, format: FrameExportFormat): string {
  return `/i/${frame.id}.${format}?scale=2&download`
}

/** Frames of one canvas as one multi-page PDF, a page per frame in the order given. */
export function framesPdfUrl(canvasId: string, frames: readonly Frame[]): string {
  const ids = frames.map((frame) => encodeURIComponent(frame.id)).join(',')
  return `/api/canvases/${encodeURIComponent(canvasId)}/export.pdf?frames=${ids}`
}

/** The server names the file; fall back to `fallback` if the header is
 *  missing or unreadable. */
function fileNameOf(res: Response, fallback: string): string {
  const header = res.headers.get('Content-Disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(header)
  return match?.[1] ?? fallback
}

async function failureOf(res: Response, label: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null)
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === 'string' ? error : t('panels.exportFailed', { label })
}

/* A `download` attribute is what makes this a download everywhere: the
   desktop shell's webview ignores Content-Disposition for types it can
   display (PNG and JPG) and would show the file
   in the window instead; with the attribute it opens the native save panel. */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS)
}

/** Starting a download can throw (a blocked blob URL, a sandboxed page);
 *  the export must still settle and report. */
function trySave(blob: Blob, fileName: string): boolean {
  try {
    saveBlob(blob, fileName)
    return true
  } catch {
    return false
  }
}

/* A busy frame renders in seconds; a request still open after
   this is stuck, and must not leave the spinner up forever. */
const EXPORT_TIMEOUT_MS = 2 * 60_000

/* A local render is fetches plus one paint; past this the server is the
   better bet. */
const RASTER_TIMEOUT_MS = 20_000

/* Exports share the one canvas toast, so an outcome must not claim the
   spinner while another export is still rendering. */
let inFlight = 0

/** `outcome` null: nothing to say — the desktop shell's save panel is the
 *  feedback, and it may yet be cancelled, so "ready" would be a claim. */
function report(outcome: string | null) {
  const { notice, pushNotice } = useStore.getState()
  if (inFlight > 0) {
    const more = t('panels.exportingMore', { count: inFlight })
    pushNotice(outcome ? `${outcome} · ${more}` : more, { busy: true })
  } else if (outcome) {
    pushNotice(outcome)
  } else if (notice?.busy) {
    useStore.setState({ notice: null })
  }
}

type Fetched = { ok: true; blob: Blob; fileName: string } | { ok: false; message: string }

/* the server's export density and JPEG quality, so both paths agree */
const EXPORT_SCALE = 2
const JPG_QUALITY = 0.9

const rasterType = (format: FrameExportFormat) => (format === 'jpg' ? 'jpeg' : 'png')

/** The frame drawn by this browser (what the person sees, no server
 *  round trip), or null when it cannot be: an image its host refuses to
 *  share, a document the serializer cannot round-trip. */
async function rasterExport(frame: Frame, format: FrameExportFormat, clip?: ClipRect): Promise<Blob | null> {
  try {
    return await rasterizeFrame(frame, {
      scale: EXPORT_SCALE,
      type: rasterType(format),
      quality: JPG_QUALITY,
      signal: AbortSignal.timeout(RASTER_TIMEOUT_MS),
      clip,
    })
  } catch {
    return null
  }
}

/** Where an element sits in its frame right now, as the live document
 *  measures it, or null when the frame is not on screen or the element is
 *  gone. The whole document is rendered either way; this only says which
 *  part to keep, so the element's inherited styles and what paints behind
 *  it are exactly what the person sees. */
async function measureElement(frame: Frame, selector: string): Promise<ClipRect | null> {
  const info = await inspectElement(frame.id, selector).catch(() => null)
  return info ? clipToFrame(info.rect, frame) : null
}

/** The server's render of the whole frame, cut down to `clip` here. */
async function fetchClipped(frame: Frame, format: FrameExportFormat, clip: ClipRect, fileName: string) {
  const label = FORMAT_LABEL[format]
  const whole = await fetchFile(frameExportUrl(frame, format), label, fileName)
  if (!whole.ok) return whole
  try {
    const blob = await cropRaster(whole.blob, clip, {
      scale: EXPORT_SCALE,
      type: rasterType(format),
      quality: JPG_QUALITY,
    })
    return { ok: true as const, blob, fileName }
  } catch {
    return { ok: false as const, message: t('panels.exportFailed', { label }) }
  }
}

/** Render here first; the server's Chromium is the fallback. */
async function fetchExport(frame: Frame, format: FrameExportFormat, element?: ElementTarget): Promise<Fetched> {
  const fileName = `${exportName(frame, element)}.${format}`
  const clip = element ? await measureElement(frame, element.selector) : undefined
  if (clip === null) return { ok: false, message: t('panels.exportElementMissing') }
  const local = await rasterExport(frame, format, clip)
  if (local) return { ok: true, blob: local, fileName }
  if (clip) return fetchClipped(frame, format, clip, fileName)
  return fetchFile(frameExportUrl(frame, format), FORMAT_LABEL[format], fileName)
}

/* the server's file naming (server/index.ts, /i/:id.:ext?download) */
function safeName(name: string): string {
  return name.replace(/[^\w\- ]+/g, '').trim()
}

function exportName(frame: Frame, element?: ElementTarget): string {
  const frameName = safeName(frame.name) || 'frame'
  if (!element) return frameName
  return `${frameName} - ${safeName(element.name) || 'element'}`
}

async function fetchFile(
  url: string,
  label: string,
  fallbackName: string,
  timeoutMs = EXPORT_TIMEOUT_MS,
): Promise<Fetched> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, message: await failureOf(res, label) }
    return { ok: true, blob: await res.blob(), fileName: fileNameOf(res, fallbackName) }
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === 'TimeoutError'
        ? t('panels.exportTimedOut', { label })
        : t('panels.exportFailed', { label })
    return { ok: false, message }
  }
}

async function exportOutcome(fetched: Promise<Fetched>): Promise<string | null> {
  const result = await fetched
  if (!result.ok) return result.message
  if (!trySave(result.blob, result.fileName)) return t('panels.exportSaveFailed', { name: result.fileName })
  return isDesktopShell() ? null : t('panels.exportReady', { name: result.fileName })
}

/** Save the frame's document as an .html file — the same text the raw editor
 *  shows, so a draft in progress exports as typed. Nothing to fetch, so it
 *  cannot fail the way the rendered exports can. */
export function downloadFrameHtml(frame: Frame, html = frame.html): void {
  saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${frame.name || 'frame'}.html`)
}

/** Render and download a frame export, reporting through the canvas toast:
 *  a spinner while the server renders (it can take several seconds), then
 *  the outcome. Fired from surfaces that close on click, so the toast in
 *  the store is the only place the result can land. */
export async function downloadFrameExport(frame: Frame, format: FrameExportFormat): Promise<void> {
  return downloadExport(frame, format)
}

/** Download one element of a frame as an image: the frame rendered whole,
 *  cut to the element's box, so a style it inherits from the document or a
 *  background it sits on is in the picture, as Figma's export of a layer
 *  would show it. */
export async function downloadElementExport(
  frame: Frame,
  element: ElementTarget,
  format: FrameExportFormat,
): Promise<void> {
  return downloadExport(frame, format, element)
}

async function downloadExport(frame: Frame, format: FrameExportFormat, element?: ElementTarget): Promise<void> {
  inFlight += 1
  useStore.getState().pushNotice(t('panels.exportingFormat', { label: FORMAT_LABEL[format] }), { busy: true })
  const outcome = await exportOutcome(fetchExport(frame, format, element))
  inFlight -= 1
  report(outcome)
}

/** Render frames of one canvas into a single PDF (a page per frame, in the
 *  order given) and download it, reporting through the canvas toast like the
 *  other exports. One request, so no batch pacing, but it waits as long as
 *  the server may take to print that many frames. */
export async function downloadFramesPdf(canvasId: string, frames: readonly Frame[]): Promise<void> {
  const [first] = frames
  if (!first) return
  inFlight += 1
  useStore
    .getState()
    .pushNotice(
      frames.length === 1 ? t('panels.exportingPdf') : t('panels.exportingPdfFrames', { count: frames.length }),
      { busy: true },
    )
  const fallback = `${(frames.length === 1 && first.name) || 'frames'}.pdf`
  const timeoutMs = Math.max(EXPORT_TIMEOUT_MS, pdfRenderBudgetMs(frames.length))
  const outcome = await exportOutcome(fetchFile(framesPdfUrl(canvasId, frames), 'PDF', fallback, timeoutMs))
  inFlight -= 1
  report(outcome)
}

/** Render the frame and put the PNG itself on the clipboard, reporting
 *  through the canvas toast like the downloads. ClipboardItem gets the
 *  pending blob, not an awaited one: WebKit allows the write only while the
 *  click's user activation is live, and the render can take seconds. */
export async function copyFramePng(frame: Frame): Promise<void> {
  return copyPng(frame)
}

/** Put one element of a frame on the clipboard as a PNG, rendered the way
 *  `downloadElementExport` renders it. */
export async function copyElementPng(frame: Frame, element: ElementTarget): Promise<void> {
  return copyPng(frame, element)
}

async function copyPng(frame: Frame, element?: ElementTarget): Promise<void> {
  /* no async clipboard outside a secure context (a self-hosted instance on
     plain http) or in older engines: say so before spending a render */
  if (!('clipboard' in navigator) || typeof ClipboardItem === 'undefined') {
    useStore.getState().pushNotice(t('panels.copyPngUnsupported'))
    return
  }
  inFlight += 1
  useStore.getState().pushNotice(t('panels.copyingPng'), { busy: true })
  /* engines differ in what the write rejects with when the blob fails, so
     the render's reason is kept here rather than read off the error */
  let failure = t('panels.copyPngFailed')
  const png = (async () => {
    /* measured inside the pending blob: the clipboard write below must
       start while the click's activation is live, before any await */
    const clip = element ? await measureElement(frame, element.selector) : undefined
    if (clip === null) {
      failure = t('panels.exportElementMissing')
      throw new Error(failure)
    }
    const local = await rasterExport(frame, 'png', clip)
    if (local) return local
    try {
      const res = await fetch(frameExportUrl(frame, 'png'), { signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) })
      if (res.ok) {
        const whole = await res.blob()
        return clip ? await cropRaster(whole, clip, { scale: EXPORT_SCALE, type: 'png' }) : whole
      }
      failure = await failureOf(res, 'png')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') failure = t('panels.copyPngTimedOut')
    }
    throw new Error(failure)
  })()
  /* the clipboard can refuse without ever reading it */
  png.catch(() => {})
  let outcome: string
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    outcome = t('panels.copyPngDone')
  } catch {
    outcome = failure
  }
  inFlight -= 1
  report(outcome)
}
