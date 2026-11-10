import { MAX_PDF_FRAMES, pdfRenderBudgetMs } from '../../shared/pdfLimits'
import { DEFAULT_EXPORT_SCALE, exportScaleSuffix, fitExportScale, formatExportScale } from '../../shared/exportScale'
import type { Frame } from '../../shared/types'
import { isDesktopShell } from './shell'
import { inspectElement } from './frameBridge'
import { clipToFrame, cropRaster, frameSvg, rasterizeFrame, type ClipRect } from './frameRaster'
import { useStore } from './store'
import { t } from './i18n'
import { PrivateExportOperation } from './privateExport'
import { privateMediaOperation } from './privateMaterialization'
import { PRIVATE_MEDIA_LIMITS, PrivateMaterializationError } from '../../shared/privateMedia'

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
  const lifetime = privateMediaOperation()
  let url: string
  try {
    url = URL.createObjectURL(blob)
  } catch (error) {
    lifetime.close()
    throw error
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  const revoke = () => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    URL.revokeObjectURL(url)
    lifetime.close()
  }
  lifetime.signal.addEventListener('abort', revoke, { once: true })
  const link = document.createElement('a')
  try {
    link.href = url
    link.download = fileName
    document.body.append(link)
    link.click()
    timer = setTimeout(revoke, BLOB_URL_LIFETIME_MS)
  } catch (error) {
    revoke()
    throw error
  } finally {
    link.remove()
  }
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

/** `note`: something the person should hear with the outcome (a scale the
 *  frame was too big for). */
type Fetched = { ok: true; blob: Blob; fileName: string; note?: string } | { ok: false; message: string }

/* the server's JPEG quality, so both paths agree */
const JPG_QUALITY = 0.9

const rasterType = (format: RasterFormat) => (format === 'jpg' ? 'jpeg' : 'png')

/** The frame drawn by this browser (what the person sees, no server
 *  round trip), or null when it cannot be: an image its host refuses to
 *  share, a document the serializer cannot round-trip. */
async function rasterExport(
  frame: Frame,
  format: RasterFormat,
  scale: number,
  signal: AbortSignal,
  clip?: ClipRect,
): Promise<Blob | null> {
  try {
    return await rasterizeFrame(frame, {
      scale,
      type: rasterType(format),
      quality: JPG_QUALITY,
      signal: AbortSignal.any([signal, AbortSignal.timeout(RASTER_TIMEOUT_MS)]),
      clip,
    })
  } catch (error) {
    // A source/authority/budget failure cannot export a different, older stored
    // design through the fallback route and report the rejected draft as saved.
    if (error instanceof PrivateMaterializationError) throw error
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
async function fetchClipped(
  frame: Frame,
  format: RasterFormat,
  scale: number,
  clip: ClipRect,
  fileName: string,
  signal: AbortSignal,
) {
  const label = FORMAT_LABEL[format]
  const whole = await fetchFile(frameExportUrl(frame, format, scale), label, fileName, EXPORT_TIMEOUT_MS, signal)
  if (!whole.ok) return whole
  try {
    const blob = await cropRaster(whole.blob, clip, {
      scale,
      type: rasterType(format),
      quality: JPG_QUALITY,
    })
    signal.throwIfAborted()
    if (blob.size > PRIVATE_MEDIA_LIMITS.encodedBytes) throw new PrivateMaterializationError('limit')
    return { ok: true as const, blob, fileName }
  } catch {
    return { ok: false as const, message: t('panels.exportFailed', { label }) }
  }
}

/** Render here first; the server's Chromium is the fallback. */
async function fetchExport(
  frame: Frame,
  format: FrameExportFormat,
  wanted: number,
  signal: AbortSignal,
  element?: ElementTarget,
): Promise<Fetched> {
  const clip = element ? await measureElement(frame, element.selector) : undefined
  if (clip === null) return { ok: false, message: t('panels.exportElementMissing') }
  if (format === 'svg') {
    try {
      const blob = await frameSvg(frame, {
        clip,
        signal: AbortSignal.any([signal, AbortSignal.timeout(RASTER_TIMEOUT_MS)]),
      })
      return { ok: true, blob, fileName: `${exportName(frame, element)}.svg` }
    } catch (error) {
      if (error instanceof PrivateMaterializationError) throw error
      return { ok: false, message: t('panels.exportSvgFailed') }
    }
  }
  const scale = fitExportScale(frame, wanted)
  const fileName = `${exportName(frame, element)}${exportScaleSuffix(scale)}.${format}`
  const local = await rasterExport(frame, format, scale, signal, clip)
  signal.throwIfAborted()
  const fetched: Fetched = local
    ? { ok: true, blob: local, fileName }
    : clip
      ? await fetchClipped(frame, format, scale, clip, fileName, signal)
      : await fetchFile(frameExportUrl(frame, format, scale), FORMAT_LABEL[format], fileName, EXPORT_TIMEOUT_MS, signal)
  if (!fetched.ok || scale === wanted) return fetched
  return { ...fetched, note: t('panels.exportScaledDown', { scale: formatExportScale(scale) }) }
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
  signal?: AbortSignal,
): Promise<Fetched> {
  try {
    const timed = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timed]) : timed
    const res = await fetch(url, { signal: combined, credentials: 'same-origin', redirect: 'error' })
    if (!res.ok) return { ok: false, message: await failureOf(res, label) }
    return {
      ok: true,
      blob: await exportBlob(
        res,
        combined,
        label === 'PDF' ? PRIVATE_MEDIA_LIMITS.responseBytes : PRIVATE_MEDIA_LIMITS.encodedBytes,
      ),
      fileName: fileNameOf(res, fallbackName),
    }
  } catch (err) {
    const message =
      err instanceof DOMException && err.name === 'TimeoutError'
        ? t('panels.exportTimedOut', { label })
        : t('panels.exportFailed', { label })
    return { ok: false, message }
  }
}

/** Bound streamed export bytes before buffering, including absent/false lengths. */
async function exportBlob(res: Response, signal: AbortSignal, maximum: number): Promise<Blob> {
  if (Number(res.headers.get('content-length') ?? 0) > maximum) {
    await res.body?.cancel().catch(() => {})
    throw new PrivateMaterializationError('limit')
  }
  const reader = res.body?.getReader()
  const parts: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader?.read()
      if (!part || part.done) break
      total += part.value.byteLength
      if (total > maximum) throw new PrivateMaterializationError('limit')
      parts.push(new Uint8Array(part.value))
    }
    signal.throwIfAborted()
    return new Blob(parts, { type: res.headers.get('content-type') ?? '' })
  } catch (error) {
    await reader?.cancel().catch(() => {})
    throw error
  } finally {
    reader?.releaseLock()
  }
}

async function exportOutcome(fetched: Promise<Fetched>, verify: () => Promise<void>): Promise<string | null> {
  try {
    const result = await fetched
    if (!result.ok) return result.message
    await verify()
    if (!trySave(result.blob, result.fileName)) return t('panels.exportSaveFailed', { name: result.fileName })
    if (isDesktopShell()) return result.note ?? null
    const ready = t('panels.exportReady', { name: result.fileName })
    return result.note ? `${ready} · ${result.note}` : ready
  } catch (error) {
    return error instanceof PrivateMaterializationError ? error.message : t('panels.exportFailed', { label: '' })
  }
}

/** Export the current draft with its authorized private files embedded. */
export async function downloadFrameHtml(frame: Frame, html = frame.html): Promise<void> {
  const operation = new PrivateExportOperation(frame, AbortSignal.timeout(EXPORT_TIMEOUT_MS))
  inFlight += 1
  useStore.getState().pushNotice(t('panels.exportingFormat', { label: 'HTML' }), { busy: true })
  let outcome: string | null = null
  try {
    const prepared = await operation.document(html)
    const blob = new Blob([prepared.html], { type: 'text/html;charset=utf-8' })
    outcome = await exportOutcome(Promise.resolve({ ok: true, blob, fileName: `${frame.name || 'frame'}.html` }), () =>
      operation.revalidate(),
    )
  } catch (error) {
    outcome = error instanceof Error ? error.message : t('panels.exportFailed', { label: 'HTML' })
  } finally {
    operation.close()
    inFlight -= 1
    report(outcome)
  }
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
  const operation = new PrivateExportOperation(frame)
  inFlight += 1
  useStore.getState().pushNotice(t('panels.exportingFormat', { label: FORMAT_LABEL[format] }), { busy: true })
  let outcome: string | null = null
  try {
    outcome = await exportOutcome(fetchExport(frame, format, scale, operation.signal, element), () =>
      operation.revalidate(),
    )
  } finally {
    operation.close()
    inFlight -= 1
    report(outcome)
  }
}

/** Render frames of one canvas into a single PDF (a page per frame, in the
 *  order given) and download it, reporting through the canvas toast like the
 *  other exports. One request, so no batch pacing, but it waits as long as
 *  the server may take to print that many frames. */
export async function downloadFramesPdf(canvasId: string, frames: readonly Frame[]): Promise<void> {
  const [first] = frames
  if (!first) return
  if (frames.length > MAX_PDF_FRAMES || frames.some((frame) => frame.canvasId !== canvasId)) {
    useStore.getState().pushNotice(t('panels.exportFailed', { label: 'PDF' }))
    return
  }
  const operations = frames.map((frame) => new PrivateExportOperation(frame))
  const signal = AbortSignal.any(operations.map((operation) => operation.signal))
  inFlight += 1
  useStore
    .getState()
    .pushNotice(
      frames.length === 1 ? t('panels.exportingPdf') : t('panels.exportingPdfFrames', { count: frames.length }),
      { busy: true },
    )
  const fallback = `${(frames.length === 1 && first.name) || 'frames'}.pdf`
  const timeoutMs = Math.max(EXPORT_TIMEOUT_MS, pdfRenderBudgetMs(frames.length))
  let outcome: string | null = null
  try {
    outcome = await exportOutcome(
      fetchFile(framesPdfUrl(canvasId, frames), 'PDF', fallback, timeoutMs, signal),
      async () => {
        for (const operation of operations) await operation.revalidate()
        signal.throwIfAborted()
      },
    )
  } finally {
    for (const operation of operations) operation.close()
    inFlight -= 1
    report(outcome)
  }
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
  const operation = new PrivateExportOperation(frame)
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
    const local = await rasterExport(frame, 'png', scale, operation.signal, clip)
    operation.signal.throwIfAborted()
    if (local) {
      await operation.revalidate()
      return local
    }
    try {
      const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(EXPORT_TIMEOUT_MS)])
      const res = await fetch(frameExportUrl(frame, 'png', scale), {
        signal,
        credentials: 'same-origin',
        redirect: 'error',
      })
      if (res.ok) {
        const whole = await exportBlob(res, signal, PRIVATE_MEDIA_LIMITS.encodedBytes)
        const result = clip ? await cropRaster(whole, clip, { scale, type: 'png' }) : whole
        if (result.size > PRIVATE_MEDIA_LIMITS.encodedBytes) throw new PrivateMaterializationError('limit')
        await operation.revalidate()
        return result
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
  } finally {
    operation.close()
  }
  inFlight -= 1
  report(outcome)
}
