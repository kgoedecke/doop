import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { uploadImageFrames } from '../lib/frameClipboard'
import { MeterLine, isResidentLimit, useAllowance } from './TeamAllowance'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Note } from './ui/note'

/**
 * The canvas's front door to the resident team: a prompt bar that queues a
 * board card without anyone having to discover the board first.
 *
 * Screenshots and images attach via the paperclip (or a paste into the
 * input); on send they land on the canvas as reference frames and the card
 * carries their ids so the agent looks at them before designing.
 */

const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 // mirrors the server's asset cap

/** How long after a submit a newly created frame still gets the camera. */
const FLY_WINDOW_MS = 3 * 60_000

function openFlyWindow(extraKnown: string[] = []): { known: Set<string>; until: number } {
  return {
    known: new Set([...(useStore.getState().canvas?.frames ?? []).map((f) => f.id), ...extraKnown]),
    until: Date.now() + FLY_WINDOW_MS,
  }
}

interface Attachment {
  file: File
  /** object URL for the thumbnail, revoked on removal/submit */
  preview: string
}

export function PromptBar({ canvasId }: { canvasId: string }) {
  const frames = useStore((s) => s.canvas?.frames)
  const { allowance, refresh } = useAllowance()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /* after a submit, the first frame that wasn't on the canvas before gets a
     camera flight — the deliverable must stream in on-screen, never somewhere
     off-canvas the user has to go find */
  const awaiting = useRef<{ known: Set<string>; until: number } | null>(null)
  useEffect(() => {
    const a = awaiting.current
    if (!a || !frames) return
    if (Date.now() > a.until) {
      awaiting.current = null
      return
    }
    const arrived = frames.find((f) => !a.known.has(f.id))
    if (arrived) {
      awaiting.current = null
      useStore.getState().requestFlyTo(arrived.id)
    }
  }, [frames])

  /* previews are object URLs — release whatever is still held on unmount
     (via a ref: an empty-deps cleanup would close over the first render) */
  const attachmentsRef = useRef(attachments)
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => () => attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.preview)), [])

  function showError(msg: string) {
    setError(msg)
    window.setTimeout(() => setError(null), 5000)
  }

  function addFiles(list: Iterable<File>) {
    const images = [...list].filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    const oversize = images.find((f) => f.size > MAX_ATTACHMENT_BYTES)
    const fitting = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES)
    const room = MAX_ATTACHMENTS - attachments.length
    if (oversize) showError(`“${oversize.name}” exceeds the 5 MB limit`)
    else if (fitting.length > room) showError(`Up to ${MAX_ATTACHMENTS} images per request`)
    const ok = fitting.slice(0, Math.max(0, room))
    if (ok.length)
      setAttachments((cur) => [...cur, ...ok.map((file) => ({ file, preview: URL.createObjectURL(file) }))])
  }

  function removeAttachment(preview: string) {
    URL.revokeObjectURL(preview)
    setAttachments((cur) => cur.filter((a) => a.preview !== preview))
  }

  async function submit(prompt: string) {
    const clean = prompt.trim()
    if (!clean || busy) return
    /* known-doomed send: no free tasks and no model account. Open the wall
       up front instead of uploading attachments only to 403 — but confirm
       against the server first, since the cached allowance can be stale
       (an account connected in another tab). The server enforces either
       way, so an unreachable check just falls through. Text stays in place. */
    if (allowance && !allowance.byoModel && allowance.used >= allowance.limit) {
      setBusy(true)
      const fresh = await api.agentAllowance().catch(() => null)
      setBusy(false)
      if (fresh && !fresh.byoModel && fresh.used >= fresh.limit) {
        useStore.getState().setLimitWall(true)
        return
      }
      refresh()
    }
    setBusy(true)
    try {
      /* attachments first: each becomes a reference frame on the canvas, and
         the card carries the frame ids so the agent views them before
         designing. Known-ids include them so the camera saves its flight for
         the agent's deliverable, not the user's own screenshots. */
      const refFrames = await uploadImageFrames(
        canvasId,
        attachments.map((a) => a.file),
        'Attached image',
      )
      await api.addCard(
        canvasId,
        clean,
        ['doop'],
        refFrames.map((f) => f.id),
      )
      posthog.capture('prompt_bar_submitted', { attachments: refFrames.length })
      awaiting.current = openFlyWindow(refFrames.map((f) => f.id))
      attachments.forEach((a) => URL.revokeObjectURL(a.preview))
      setAttachments([])
      setText('')
      setSent(true)
      window.setTimeout(() => setSent(false), 5000)
    } catch (err) {
      if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
      else {
        console.error(err)
        showError(err instanceof Error ? err.message : 'Something went wrong — try again')
      }
    } finally {
      setBusy(false)
      refresh()
    }
  }

  return (
    <div className="absolute bottom-[68px] left-1/2 z-30 flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2 max-md:bottom-[calc(76px+env(safe-area-inset-bottom))] max-md:w-[calc(100vw-16px)] max-md:gap-1.5">
      {attachments.length > 0 && (
        <div className="flex gap-2 px-0.5">
          {attachments.map((a) => (
            <div
              key={a.preview}
              className="relative h-[52px] w-[52px] overflow-hidden rounded-[8px] border border-line bg-surface shadow-card"
            >
              <img src={a.preview} alt={a.file.name} className="block h-full w-full object-cover" />
              <Button
                variant="bare"
                className="absolute right-0.5 top-0.5 size-4 justify-center rounded-full bg-black/55 p-0 text-xs leading-none text-white hover:bg-black/70 hover:text-white"
                aria-label={`Remove ${a.file.name}`}
                disabled={busy}
                onClick={() => removeAttachment(a.preview)}
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-2 rounded-[12px] border border-line bg-surface p-1.5 shadow-pop max-md:gap-[3px] max-md:p-[5px]"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(text)
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files ?? [])
            e.target.value = '' // same file can be re-picked after removal
          }}
        />
        <Button
          variant="bare"
          className="ml-0 size-10 justify-center p-2 text-ink-faint hover:bg-paper hover:text-ink-soft sm:ml-0.5 sm:size-auto sm:p-1.5"
          aria-label="Attach images"
          title="Attach screenshots or images"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </Button>
        <Input
          ref={inputRef}
          variant="bare"
          inputSize="auto"
          className="flex-1 px-1 py-1.5 md:px-2 md:text-sm"
          value={text}
          disabled={busy}
          placeholder="Ask the Doop Agent to design something…"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
            if (images.length) {
              e.preventDefault()
              addFiles(images)
            }
          }}
        />
        <Button
          variant="primary"
          className="min-h-10 flex-none rounded-lg border-transparent px-2.5 py-2 shadow-none hover:translate-x-0 hover:translate-y-0 hover:shadow-none sm:min-h-0 sm:px-3.5 sm:py-[7px]"
          type="submit"
          disabled={busy || !text.trim()}
        >
          {busy ? '…' : 'Design it'}
        </Button>
      </form>
      <div className="flex min-h-4 justify-center">
        {error ? (
          <Note tone="error" size="sm" className="text-xs">
            {error}
          </Note>
        ) : sent ? (
          <Note size="sm" className="text-xs text-ink-soft">
            ✦ The Doop Agent is on it — watch the canvas
          </Note>
        ) : (
          <MeterLine allowance={allowance} />
        )}
      </div>
    </div>
  )
}
