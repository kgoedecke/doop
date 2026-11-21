import { pdfRenderBudgetMs } from '../../shared/pdfLimits'
import {
  DEFAULT_EXPORT_SCALE,
  exportScaleSuffix,
  fitExportScale,
  formatExportScale,
  fullFrameRenderScale,
} from '../../shared/exportScale'
import { MAX_LAYER_SELECTOR_CHARS } from '../../shared/elementId'
import type { Frame } from '../../shared/types'
import { isDesktopShell } from './shell'
import { inspectElement } from './frameBridge'
import { composeFrame } from './frameCompose'
import { clipToFrame, cropRaster, frameSvg, rasterizeFrame, type ClipRect } from './frameRaster'
import { useSyncExternalStore } from 'react'
import { useStore } from './store'
import { t } from './i18n'

export type FrameExportFormat = 'png' | 'jpg' | 'svg'
/** the formats with a pixel density, which the server can render too */
export type RasterFormat = Exclude<FrameExportFormat, 'svg'>

/** One element inside a frame, by the selector the live document answers
 *  to; `name` is what the Layers panel calls it, for the file name. */
export interface ElementTarget {
  selector: string
  name: string
}

export const FORMAT_LABEL: Record<FrameExportFormat, string> = { png: 'PNG', jpg: 'JPG', svg: 'SVG' }

/* Blob URLs are revoked late: in the desktop shell the save panel opens
   before WebKit reads the blob, and the person may take a while to pick. */
const BLOB_URL_LIFETIME_MS = 10 * 60_000

export function frameExportUrl(frame: Frame, format: RasterFormat, scale = DEFAULT_EXPORT_SCALE): string {
  return `/i/${frame.id}.${format}?scale=${scale}&download`
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

/* The frames with a download rendering, so a control can say so wherever it
   is mounted (the Inspector remounts on every selection) and whichever
   surface started it. A count per frame, since one frame may export twice. */
const exportingFrames = new Map<string, number>()
const exportListeners = new Set<() => void>()

function markExporting(frameIds: readonly string[], delta: 1 | -1) {
  for (const id of frameIds) {
    const next = (exportingFrames.get(id) ?? 0) + delta
    if (next > 0) exportingFrames.set(id, next)
    else exportingFrames.delete(id)
  }
  for (const listener of exportListeners) listener()
}

function subscribeExporting(listener: () => void) {
  exportListeners.add(listener)
  return () => exportListeners.delete(listener)
}

export function isFrameExporting(frameId: string): boolean {
  return exportingFrames.has(frameId)
}

/** Whether a download of this frame is rendering right now. */
export function useFrameExporting(frameId: string): boolean {
  return useSyncExternalStore(subscribeExporting, () => isFrameExporting(frameId))
}

/** Run one export with its frames marked busy and counted in the shared
 *  toast, both undone however the export ends. */
async function tracked<T>(frameIds: readonly string[], run: () => Promise<T>): Promise<T> {
  inFlight += 1
  markExporting(frameIds, 1)
  try {
    return await run()
  } finally {
    inFlight -= 1
    markExporting(frameIds, -1)
  }
}

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

/** `note`: something the person should hear with the outcome (a scale the
 *  frame was too big for). */
type Fetched = { ok: true; blob: Blob; fileName: string; note?: string } | { ok: false; message: string }

/* the server's JPEG quality, so both paths agree */
const JPG_QUALITY = 0.9

const rasterType = (format: RasterFormat) => (format === 'jpg' ? 'jpeg' : 'png')

/** The frame drawn by this browser (what the person sees, no server
 *  round trip), or null when it cannot be: an image its host refuses to
 *  share, a document the serializer cannot round-trip. */
async function rasterExport(frame: Frame, format: RasterFormat, scale: number, clip?: ClipRect): Promise<Blob | null> {
  try {
    return await rasterizeFrame(frame, {
      scale,
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

/** If a full screenshot would shrink a small selection, let Chromium capture
 *  the layer directly at its original density. Otherwise keep the live
 *  document's measured crop, including selectors too long for a public URL. */
function serverRasterTarget(
  frame: Frame,
  format: RasterFormat,
  scale: number,
  clip?: ClipRect,
  element?: ElementTarget,
) {
  const url = frameExportUrl(frame, format, scale)
  const fullScale = fullFrameRenderScale(frame, scale)
  if (
    fullScale < scale &&
    clip &&
    element &&
    element.selector.length <= MAX_LAYER_SELECTOR_CHARS &&
    fullFrameRenderScale(clip, scale) === scale
  ) {
    return { url: `${url}&selector=${encodeURIComponent(element.selector)}`, scale }
  }
  return { url, scale: fullScale, clip }
}

/** Render here first; the server's Chromium is the fallback. Use the scale
 *  of the renderer that produced the file for its name and download notice. */
async function fetchExport(
  frame: Frame,
  format: FrameExportFormat,
  wanted: number,
  element?: ElementTarget,
): Promise<Fetched> {
  const clip = element ? await measureElement(frame, element.selector) : undefined
  if (clip === null) return { ok: false, message: t('panels.exportElementMissing') }
  if (format === 'svg') return svgExport(frame, element, clip)
  let scale = fitExportScale(frame, wanted)
  let blob = await rasterExport(frame, format, scale, clip)
  let fileName = ''
  if (!blob) {
    const target = serverRasterTarget(frame, format, scale, clip, element)
    scale = target.scale
    const fetched = await fetchFile(target.url, FORMAT_LABEL[format], '')
    if (!fetched.ok) return fetched
    fileName = element ? '' : fetched.fileName
    blob = fetched.blob
    if (target.clip) {
      try {
        blob = await cropRaster(blob, target.clip, { scale, type: rasterType(format), quality: JPG_QUALITY })
      } catch {
        return { ok: false, message: t('panels.exportFailed', { label: FORMAT_LABEL[format] }) }
      }
    }
  }
  return {
    ok: true,
    blob,
    fileName: fileName || `${exportName(frame, element)}${exportScaleSuffix(scale)}.${format}`,
    note: scale === wanted ? undefined : t('panels.exportScaledDown', { scale: formatExportScale(scale) }),
  }
}

/** An SVG has no server fallback: the server's Chromium paints pixels, and
 *  the file is the document this browser inlines. */
async function svgExport(
  frame: Frame,
  element: ElementTarget | undefined,
  clip: ClipRect | undefined,
): Promise<Fetched> {
  try {
    const blob = await frameSvg(frame, { clip, signal: AbortSignal.timeout(RASTER_TIMEOUT_MS) })
    return { ok: true, blob, fileName: `${exportName(frame, element)}.svg` }
  } catch {
    return { ok: false, message: t('panels.exportSvgFailed') }
  }
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
  if (isDesktopShell()) return result.note ?? null
  const ready = t('panels.exportReady', { name: result.fileName })
  return result.note ? `${ready} · ${result.note}` : ready
}

/** Save the frame's document as an .html file — the same text the raw editor
 *  shows, so a draft in progress exports as typed. Nothing to fetch, so it
 *  cannot fail the way the rendered exports can. */
export function downloadFrameHtml(frame: Frame, html = frame.html): void {
  /* a file opened by itself: the canvas's token values and component styles go with it */
  saveBlob(new Blob([composeFrame(html)], { type: 'text/html;charset=utf-8' }), `${frame.name || 'frame'}.html`)
}

/** Render and download a frame export, reporting through the canvas toast:
 *  a spinner while the server renders (it can take several seconds), then
 *  the outcome. Fired from surfaces that close on click, so the toast in
 *  the store is the only place the result can land. */
export async function downloadFrameExport(
  frame: Frame,
  format: FrameExportFormat,
  scale = DEFAULT_EXPORT_SCALE,
): Promise<void> {
  return downloadExport(frame, format, scale)
}

/** Download one element of a frame as an image: the frame rendered whole,
 *  cut to the element's box, so a style it inherits from the document or a
 *  background it sits on is in the picture, as Figma's export of a layer
 *  would show it. */
export async function downloadElementExport(
  frame: Frame,
  element: ElementTarget,
  format: FrameExportFormat,
  scale = DEFAULT_EXPORT_SCALE,
): Promise<void> {
  return downloadExport(frame, format, scale, element)
}

async function downloadExport(
  frame: Frame,
  format: FrameExportFormat,
  scale: number,
  element?: ElementTarget,
): Promise<void> {
  const outcome = await tracked([frame.id], () => {
    useStore.getState().pushNotice(t('panels.exportingFormat', { label: FORMAT_LABEL[format] }), { busy: true })
    return exportOutcome(fetchExport(frame, format, scale, element))
  })
  report(outcome)
}

/** Render frames of one canvas into a single PDF (a page per frame, in the
 *  order given) and download it, reporting through the canvas toast like the
 *  other exports. One request, so no batch pacing, but it waits as long as
 *  the server may take to print that many frames. */
export async function downloadFramesPdf(canvasId: string, frames: readonly Frame[]): Promise<void> {
  const [first] = frames
  if (!first) return
  const outcome = await tracked(
    frames.map((frame) => frame.id),
    () => {
      useStore
        .getState()
        .pushNotice(
          frames.length === 1 ? t('panels.exportingPdf') : t('panels.exportingPdfFrames', { count: frames.length }),
          { busy: true },
        )
      const fallback = `${(frames.length === 1 && first.name) || 'frames'}.pdf`
      const timeoutMs = Math.max(EXPORT_TIMEOUT_MS, pdfRenderBudgetMs(frames.length))
      return exportOutcome(fetchFile(framesPdfUrl(canvasId, frames), 'PDF', fallback, timeoutMs))
    },
  )
  report(outcome)
}

/** Render the frame and put the PNG itself on the clipboard, reporting
 *  through the canvas toast like the downloads. ClipboardItem gets the
 *  pending blob, not an awaited one: WebKit allows the write only while the
 *  click's user activation is live, and the render can take seconds. */
export async function copyFramePng(frame: Frame, scale = DEFAULT_EXPORT_SCALE): Promise<void> {
  return copyPng(frame, scale)
}

/** Put one element of a frame on the clipboard as a PNG, rendered the way
 *  `downloadElementExport` renders it. */
export async function copyElementPng(
  frame: Frame,
  element: ElementTarget,
  scale = DEFAULT_EXPORT_SCALE,
): Promise<void> {
  return copyPng(frame, scale, element)
}

async function copyPng(frame: Frame, wanted: number, element?: ElementTarget): Promise<void> {
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
    const scale = fitExportScale(frame, wanted)
    const local = await rasterExport(frame, 'png', scale, clip)
    if (local) return local
    try {
      const target = serverRasterTarget(frame, 'png', scale, clip, element)
      const res = await fetch(target.url, { signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) })
      if (res.ok) {
        const whole = await res.blob()
        return target.clip ? await cropRaster(whole, target.clip, { scale: target.scale, type: 'png' }) : whole
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
