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

/** The server names the file after the frame; fall back to that if the
 *  header is missing or unreadable. */
function fileNameOf(res: Response, frame: Frame, format: FrameExportFormat): string {
  const header = res.headers.get('Content-Disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(header)
  return match?.[1] ?? `${frame.name || 'frame'}.${format}`
}

async function failureOf(res: Response, format: FrameExportFormat): Promise<string> {
  const body: unknown = await res.json().catch(() => null)
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === 'string' ? error : `Couldn’t export the ${FORMAT_LABEL[format]}`
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

/* An image of a busy frame renders in seconds; a request still open after
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

async function exportOutcome(frame: Frame, format: FrameExportFormat): Promise<string | null> {
  try {
    const res = await fetch(frameExportUrl(frame, format), { signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) })
    if (!res.ok) return await failureOf(res, format)
    const fileName = fileNameOf(res, frame, format)
    saveBlob(await res.blob(), fileName)
    return isDesktopShell() ? null : `“${fileName}” is ready`
  } catch (err) {
    return err instanceof DOMException && err.name === 'TimeoutError'
      ? `The ${FORMAT_LABEL[format]} export timed out — try again`
      : `Couldn’t export the ${FORMAT_LABEL[format]}`
  }
}

/** Render and download a frame export, reporting through the canvas toast:
 *  a spinner while the server renders (rendering can take several seconds),
 *  then the outcome. Fired from surfaces that close on click, so the
 *  toast in the store is the only place the result can land. */
export async function downloadFrameExport(frame: Frame, format: FrameExportFormat): Promise<void> {
  inFlight += 1
  useStore.getState().pushNotice(`Exporting ${FORMAT_LABEL[format]}…`, { busy: true })
  const outcome = await exportOutcome(frame, format)
  inFlight -= 1
  report(outcome)
}
