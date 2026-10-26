import { pdfRenderBudgetMs } from '../../shared/pdfLimits'
import type { Frame } from '../../shared/types'
import { isDesktopShell } from './shell'
import { useStore } from './store'

export type FrameExportFormat = 'png' | 'jpg'

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
  return typeof error === 'string' ? error : `Couldn’t export the ${label}`
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

/* Exports share the one canvas toast, so an outcome must not claim the
   spinner while another export is still rendering. */
let inFlight = 0

/** `outcome` null: nothing to say — the desktop shell's save panel is the
 *  feedback, and it may yet be cancelled, so "ready" would be a claim. */
function report(outcome: string | null) {
  const { notice, pushNotice } = useStore.getState()
  if (inFlight > 0) {
    const more = `Exporting ${inFlight} more…`
    pushNotice(outcome ? `${outcome} · ${more}` : more, { busy: true })
  } else if (outcome) {
    pushNotice(outcome)
  } else if (notice?.busy) {
    useStore.setState({ notice: null })
  }
}

type Fetched = { ok: true; blob: Blob; fileName: string } | { ok: false; message: string }

async function fetchExport(frame: Frame, format: FrameExportFormat): Promise<Fetched> {
  return fetchFile(frameExportUrl(frame, format), FORMAT_LABEL[format], `${frame.name || 'frame'}.${format}`)
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
        ? `The ${label} export timed out — try again`
        : `Couldn’t export the ${label}`
    return { ok: false, message }
  }
}

async function exportOutcome(fetched: Promise<Fetched>): Promise<string | null> {
  const result = await fetched
  if (!result.ok) return result.message
  if (!trySave(result.blob, result.fileName)) return `Couldn’t save “${result.fileName}”`
  return isDesktopShell() ? null : `“${result.fileName}” is ready`
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
  inFlight += 1
  useStore.getState().pushNotice(`Exporting ${FORMAT_LABEL[format]}…`, { busy: true })
  const outcome = await exportOutcome(fetchExport(frame, format))
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
  const count = frames.length === 1 ? '' : ` of ${frames.length} frames`
  useStore.getState().pushNotice(`Exporting PDF${count}…`, { busy: true })
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
  /* no async clipboard outside a secure context (a self-hosted instance on
     plain http) or in older engines: say so before spending a render */
  if (!('clipboard' in navigator) || typeof ClipboardItem === 'undefined') {
    useStore.getState().pushNotice('This browser can’t copy images')
    return
  }
  inFlight += 1
  useStore.getState().pushNotice('Copying PNG…', { busy: true })
  /* engines differ in what the write rejects with when the blob fails, so
     the render's reason is kept here rather than read off the error */
  let failure = 'Couldn’t copy the PNG'
  const png = (async () => {
    try {
      const res = await fetch(frameExportUrl(frame, 'png'), { signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) })
      if (res.ok) return await res.blob()
      failure = await failureOf(res, 'png')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') failure = 'The PNG copy timed out — try again'
    }
    throw new Error(failure)
  })()
  /* the clipboard can refuse without ever reading it */
  png.catch(() => {})
  let outcome: string
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    outcome = 'PNG copied'
  } catch {
    outcome = failure
  }
  inFlight -= 1
  report(outcome)
}
