import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useStore, type ComposerSend } from '../lib/store'
import { api, type Allowance } from '../lib/api'
import { posthog } from '../lib/posthog'
import { uploadImageFrames } from '../lib/frameClipboard'
import { isResidentLimit, meterText, useAllowance } from './TeamAllowance'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Note } from './ui/note'
import { Tooltip } from './ui/tooltip'
import { DoopMark } from './Logo'
import { ArrowUpIcon, AttachmentIcon, FrameIcon, XIcon } from './ui/icons'
import { ModelPicker } from './ModelPicker'
import { LayerKindIcon } from './LayerKindIcon'
import { buildLayerTree, findLayer, layerName } from '../lib/layers'
import type { CardScope } from '../../shared/types'
import type { LayerKind } from '../lib/layers'
import { t as translate, useT } from '@/lib/i18n'

/**
 * The canvas's front door to the resident team: the prompt composer
 * docked to the bottom of the Agents tab. It queues a board card without
 * anyone having to discover the board first; the tasks it starts show up in
 * the list above it.
 *
 * Screenshots and images attach via the paperclip (or a paste into the
 * field); on send they land on the canvas as reference frames and the card
 * carries their ids so the agent looks at them before designing.
 */

const MAX_ATTACHMENTS = 4
/** the scope chip's label is cut here so a long text node never eats the row */
const MAX_SCOPE_LABEL = 24
/** the field grows with the draft up to this many lines, then scrolls */
const MAX_COMPOSER_LINES = 6
/** a ⌘K older than this is ignored by a composer that mounts later */
const FOCUS_REQUEST_TTL_MS = 2000

interface ScopeChip {
  scope: CardScope
  /** what the chip reads: an element's "aside.rail", a frame's name */
  label: string
  kind: LayerKind | 'frame'
}

function clip(text: string): string {
  return text.length > MAX_SCOPE_LABEL ? `${text.slice(0, MAX_SCOPE_LABEL - 1).trimEnd()}…` : text
}

/** "frame:element" for an element scope, the frame id alone for a frame one */
function scopeKey(scope: CardScope): string {
  return scope.selector ? `${scope.frameId}:${scope.selector}` : scope.frameId
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 // mirrors the server's asset cap

/** How long after a submit a newly created frame still gets the camera. */
const FLY_WINDOW_MS = 3 * 60_000

let cancelPendingFlight: (() => void) | null = null

/**
 * After a submit, the first frame that wasn't on the canvas before gets a
 * camera flight — the deliverable must stream in on-screen, never somewhere
 * off-canvas the user has to go find. A store subscription rather than an
 * effect: the composer lives in a panel tab, and switching tabs (or closing
 * the panel) while the agent works must not cancel the flight. Leaving the
 * canvas does: another canvas's frames are all "new" to this watch, and a
 * flight there would land on something unrelated. A newer submit replaces
 * an older watch.
 */
function flyToNextFrame(canvasId: string, extraKnown: string[]) {
  cancelPendingFlight?.()
  const known = new Set([...(useStore.getState().canvas?.frames ?? []).map((f) => f.id), ...extraKnown])
  const unsubscribe = useStore.subscribe((s) => {
    /* null while a canvas loads — only a different canvas ends the watch */
    if (!s.canvas) return
    if (s.canvas.id !== canvasId) return stop()
    const arrived = s.canvas.frames.find((f) => !known.has(f.id))
    if (!arrived) return
    stop()
    s.requestFlyTo(arrived.id)
  })
  const timer = window.setTimeout(stop, FLY_WINDOW_MS)
  function stop() {
    unsubscribe()
    window.clearTimeout(timer)
    if (cancelPendingFlight === stop) cancelPendingFlight = null
  }
  cancelPendingFlight = stop
}

/** How long the "on it" confirmation stays up after a send. */
const SENT_NOTE_MS = 5000

function setSend(send: ComposerSend | null) {
  useStore.getState().setComposerSend(send)
}

/**
 * The send itself, detached from the component: the composer unmounts with
 * its tab, and a send that fails after the user switched away must still
 * report back when the tab returns. Progress and outcome go to the store;
 * the draft is cleared only once the card is queued, so a failure leaves
 * the text in place for a retry.
 */
async function sendPrompt(args: {
  canvasId: string
  text: string
  files: File[]
  scope: CardScope | undefined
  allowance: Allowance | null
}): Promise<void> {
  const { canvasId, text, files, scope, allowance } = args
  const store = useStore.getState()
  if (store.composerSend?.status === 'busy') return
  /* known-doomed send: no free tasks and no model account. Open the wall
     up front instead of uploading attachments only to 403 — but confirm
     against the server first, since the cached allowance can be stale
     (an account connected in another tab). The server enforces either
     way, so an unreachable check just falls through. Text stays in place. */
  if (allowance && !allowance.byoModel && allowance.used >= allowance.limit) {
    setSend({ canvasId, status: 'busy' })
    const fresh = await api.agentAllowance().catch(() => null)
    setSend(null)
    if (fresh && !fresh.byoModel && fresh.used >= fresh.limit) {
      store.setLimitWall(true)
      return
    }
  }
  setSend({ canvasId, status: 'busy' })
  try {
    /* attachments first: each becomes a reference frame on the canvas, and
       the card carries the frame ids so the agent views them before
       designing. Known-ids include them so the camera saves its flight for
       the agent's deliverable, not the user's own screenshots. */
    const refFrames = await uploadImageFrames(canvasId, files, 'Attached image')
    await api.addCard(
      canvasId,
      text,
      ['doop'],
      refFrames.map((f) => f.id),
      scope,
    )
    posthog.capture('prompt_bar_submitted', {
      attachments: refFrames.length,
      scope: scope ? (scope.selector ? 'element' : 'frame') : 'none',
    })
    flyToNextFrame(
      canvasId,
      refFrames.map((f) => f.id),
    )
    store.setComposerDraft(canvasId, '')
    const sent: ComposerSend = { canvasId, status: 'sent', at: Date.now() }
    setSend(sent)
    window.setTimeout(() => {
      if (useStore.getState().composerSend === sent) setSend(null)
    }, SENT_NOTE_MS)
  } catch (err) {
    if (isResidentLimit(err)) {
      store.setLimitWall(true)
      setSend(null)
    } else {
      console.error(err)
      setSend({
        canvasId,
        status: 'error',
        message: err instanceof Error ? err.message : translate('panels.promptSendFailed'),
        at: Date.now(),
      })
    }
  } finally {
    /* every meter on screen re-reads the allowance, mounted or not */
    useStore.getState().allowanceChanged()
  }
}

/** Size the field to its draft, up to MAX_COMPOSER_LINES. */
function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto'
  if (!ta.scrollHeight) return // not laid out (hidden, or a DOM without layout)
  const line = parseFloat(getComputedStyle(ta).lineHeight) || 20
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(line * MAX_COMPOSER_LINES))}px`
}

interface Attachment {
  file: File
  /** object URL for the thumbnail, revoked on removal/submit */
  preview: string
}

export function PromptBar({ canvasId }: { canvasId: string }) {
  const frames = useStore((s) => s.canvas?.frames)
  const selectedId = useStore((s) => s.selectedId)
  const selectedElement = useStore((s) => s.selectedElement)
  const focusAt = useStore((s) => s.composerFocusAt)
  const text = useStore((s) => s.composerDrafts[canvasId] ?? '')
  const setDraft = useStore((s) => s.setComposerDraft)
  /* this canvas's send only: another canvas's outcome is not ours to show */
  const send = useStore((s) => (s.composerSend?.canvasId === canvasId ? s.composerSend : null))
  const busy = send?.status === 'busy'
  const sent = send?.status === 'sent'
  const sendError = send?.status === 'error' ? send.message : null
  const { allowance } = useAllowance()
  /* the selection is the prompt's scope until the chip is dismissed — × or
     Esc drops it entirely, no stepping up to the frame. Keyed on the scope
     so a new selection brings the chip back. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const chip = useMemo<ScopeChip | null>(() => {
    const frame = frames?.find((f) => f.id === (selectedElement?.frameId ?? selectedId))
    if (!frame) return null
    const scope: CardScope = selectedElement
      ? { frameId: frame.id, selector: selectedElement.selector }
      : { frameId: frame.id }
    if (dismissed === scopeKey(scope)) return null
    if (!selectedElement) return { scope, label: frame.name, kind: 'frame' }
    const node = findLayer(buildLayerTree(frame.html), selectedElement.selector)
    return {
      scope,
      label: node ? layerName(node) : (selectedElement.selector.split(' > ').at(-1) ?? ''),
      kind: node?.kind ?? 'box',
    }
  }, [frames, selectedId, selectedElement, dismissed])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  /* attachment slips (too big, too many) — local and brief, unlike a failed
     send, which the store keeps until the draft changes */
  const [attachError, setAttachError] = useState<string | null>(null)
  const error = attachError ?? sendError
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const t = useT()

  useLayoutEffect(() => {
    if (inputRef.current) autosize(inputRef.current)
  }, [text])

  /* ⌘K: the page has opened the panel on this tab — take the keyboard. The
     request is a timestamp so a composer mounted later (a tab switch some
     minutes on) does not re-run an old one. */
  useEffect(() => {
    if (focusAt && Date.now() - focusAt < FOCUS_REQUEST_TTL_MS) inputRef.current?.focus()
  }, [focusAt])

  /* previews are object URLs — release whatever is still held on unmount
     (via a ref: an empty-deps cleanup would close over the first render) */
  const attachmentsRef = useRef(attachments)
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => () => attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.preview)), [])

  function showError(msg: string) {
    setAttachError(msg)
    window.setTimeout(() => setAttachError(null), 5000)
  }

  function addFiles(list: Iterable<File>) {
    const images = [...list].filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    const oversize = images.find((f) => f.size > MAX_ATTACHMENT_BYTES)
    const fitting = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES)
    const room = MAX_ATTACHMENTS - attachments.length
    if (oversize) showError(t('panels.promptTooBig', { name: oversize.name }))
    else if (fitting.length > room) showError(t('panels.promptTooMany', { count: MAX_ATTACHMENTS }))
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
    const files = attachments.map((a) => a.file)
    await sendPrompt({ canvasId, text: clean, files, scope: chip?.scope, allowance })
    /* the thumbnails go once the card is queued: the files were handed to
       the upload, and a failure keeps the text and the previews for a retry */
    if (useStore.getState().composerDrafts[canvasId] === '') {
      attachments.forEach((a) => URL.revokeObjectURL(a.preview))
      setAttachments([])
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape' && chip) {
      e.preventDefault()
      setDismissed(scopeKey(chip.scope))
      return
    }
    /* Enter sends, ⇧Enter breaks the line; an Enter that commits an IME
       composition is neither */
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit(text)
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-line-soft bg-surface px-3 pt-2.5 pb-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <div key={a.preview} className="relative h-11 w-11 overflow-hidden rounded-[7px] bg-paper shadow-ring">
              <img src={a.preview} alt={a.file.name} className="block h-full w-full object-cover" />
              <Button
                variant="bare"
                className="absolute right-0.5 top-0.5 size-4 justify-center rounded-full bg-black/55 p-0 text-xs leading-none text-white hover:bg-black/70 hover:text-white"
                aria-label={t('panels.promptRemoveAttachment', { name: a.file.name })}
                disabled={busy}
                onClick={() => removeAttachment(a.preview)}
              >
                <XIcon size={10} />
              </Button>
            </div>
          ))}
        </div>
      )}
      <form
        className="rounded-[10px]"
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
        {chip && (
          <div className="mb-2 flex">
            <span
              className="flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-[6px] pr-1 pl-2 text-[12px] text-ink-soft shadow-ring"
              title={
                chip.kind === 'frame'
                  ? t('panels.promptScopedFrame', { name: chip.label })
                  : t('panels.promptScopedElement', { name: chip.label || t('panels.promptElement') })
              }
            >
              <span className="flex-none text-ink-faint">
                {chip.kind === 'frame' ? <FrameIcon className="size-3.5" /> : <LayerKindIcon kind={chip.kind} />}
              </span>
              <span className="min-w-0 truncate">{clip(chip.label || t('panels.promptElement'))}</span>
              <Button
                variant="bare"
                className="size-4 flex-none justify-center rounded-full p-0 text-ink-faint hover:bg-paper-deep hover:text-ink"
                aria-label={
                  chip.kind === 'frame' ? t('panels.promptRemoveFrameScope') : t('panels.promptRemoveElementScope')
                }
                disabled={busy}
                onClick={() => setDismissed(scopeKey(chip.scope))}
              >
                <XIcon className="size-3" aria-hidden />
              </Button>
            </span>
          </div>
        )}
        <Textarea
          ref={inputRef}
          variant="bare"
          rows={1}
          aria-label={t('panels.promptAria')}
          className="block overflow-y-auto px-0.5 text-[12.5px] leading-[1.45] placeholder:text-ink-ghost md:text-[12.5px]"
          value={text}
          disabled={busy}
          placeholder={
            chip
              ? chip.kind === 'frame'
                ? t('panels.promptPlaceholderFrame')
                : t('panels.promptPlaceholderElement')
              : t('panels.promptPlaceholder')
          }
          onKeyDown={onKeyDown}
          onChange={(e) => setDraft(canvasId, e.target.value)}
          onPaste={(e) => {
            const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
            if (images.length) {
              e.preventDefault()
              addFiles(images)
            }
          }}
        />
        <div className="mt-2 flex items-center gap-1">
          <Button
            variant="bare"
            size="icon-sm"
            className="size-7 rounded-[7px] text-ink-faint hover:bg-paper-deep hover:text-ink"
            aria-label={t('panels.promptAttach')}
            title={t('panels.promptAttachTitle')}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <AttachmentIcon className="size-3.5" />
          </Button>
          <span className="flex-1" />
          <ModelPicker disabled={busy} />
          {/* the meter rides on the send button; a disabled button takes no
              pointer events, so the span under it is what the tooltip hangs on */}
          <Tooltip label={meterText(allowance, t) ?? t('panels.promptSendTooltip')} side="top" align="end">
            <span
              className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint"
              /* while the button is disabled the wrapper takes its tab stop,
                 so the meter can be reached and read without a pointer */
              tabIndex={busy || !text.trim() ? 0 : -1}
              aria-label={meterText(allowance, t) ?? undefined}
            >
              <Button
                variant="primary"
                size="icon-sm"
                className="size-7 rounded-full"
                type="submit"
                aria-label={t('panels.promptSend')}
                disabled={busy || !text.trim()}
              >
                {busy ? <span aria-hidden>…</span> : <ArrowUpIcon className="size-3.5" strokeWidth={1.6} />}
              </Button>
            </span>
          </Tooltip>
        </div>
      </form>
      {(error || sent) && (
        <div className="text-[11px] leading-[1.4]">
          {error ? (
            <Note tone="error" size="sm" className="text-[11px]">
              {error}
            </Note>
          ) : (
            <Note size="sm" className="text-[11px] text-ink-soft">
              <DoopMark size={11} /> {t('panels.promptSent')}
            </Note>
          )}
        </div>
      )}
    </div>
  )
}
