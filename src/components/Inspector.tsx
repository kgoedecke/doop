import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import { api, errorMessage } from '../lib/api'
import { beginFrameSave } from '../lib/frameSaves'
import { copyFramePng, downloadFrameExport, downloadFrameHtml } from '../lib/frameExport'
import { deleteFrameTracked, recordUpdate } from '../lib/history'
import { setFramesLocked } from '../lib/layerEdits'
import { FrameHistoryModal } from './FrameHistoryModal'
import { FrameApprovalControl } from './FrameApproval'
import { cn } from '@/lib/utils'
import { Panel, PanelClose, PanelHeader } from './ui/panel'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { CopyIcon, DownloadIcon, FrameIcon, LockIcon } from './ui/icons'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'

const HTML_OPEN_KEY = 'doop:inspector-html'

/* the rail's filled buttons: a grey well, 28px, tall enough to hit on a phone */
const fillBtn = 'h-7 rounded-[7px] bg-sub px-2 text-[12px] font-normal text-ink hover:bg-paper-deep max-md:min-h-10'

export function Inspector({
  frame,
  surface = 'floating',
  className,
  style,
}: {
  frame: Frame
  /* 'inline' when the inspector is filling a mobile Sheet */
  surface?: 'floating' | 'inline'
  className?: string
  style?: CSSProperties
}) {
  const select = useStore((s) => s.select)
  /* the raw HTML editor is a power tool — collapsed by default so the panel
     reads as frame properties, not a code dump; the choice sticks */
  const [showHtml, setShowHtml] = useState(() => localStorage.getItem(HTML_OPEN_KEY) === '1')
  const [draft, setDraft] = useState(frame.html)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saved'>('idle')
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [htmlCopy, setHtmlCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const queuedSave = useRef<{ timer: number; finish: () => void } | null>(null)
  const copyTimer = useRef<number | null>(null)
  const frameId = useRef(frame.id)

  /* switching frames resets the draft; otherwise pull in remote html
     updates unless the user is typing */
  useEffect(() => {
    const switched = frameId.current !== frame.id
    frameId.current = frame.id
    const typing = document.activeElement === textareaRef.current
    if (switched || (!typing && frame.html !== draft)) {
      setDraft(frame.html)
      setSaveState('idle')
    }
    /* a copy confirmation belongs to the frame it was copied from */
    if (switched) setHtmlCopy('idle')
  }, [frame.id, frame.html, draft])

  /* the confirmation timer must not fire after the panel is gone */
  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  function onHtmlChange(value: string) {
    setDraft(value)
    setSaveState('dirty')
    if (queuedSave.current) {
      window.clearTimeout(queuedSave.current.timer)
      queuedSave.current.finish()
    }
    const finish = beginFrameSave(frame.id)
    const timer = window.setTimeout(async () => {
      if (queuedSave.current?.timer === timer) queuedSave.current = null
      const before = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)?.html
      if (before !== undefined) recordUpdate(frame.id, { html: before }, { html: value })
      try {
        await api.updateFrame(frame.id, { html: value })
        setSaveState('saved')
        window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500)
      } catch (err) {
        setSaveState('dirty')
        useStore.getState().pushNotice(errorMessage(err, 'Couldn’t save the design. Please try again.'))
      } finally {
        finish()
      }
    }, 700)
    queuedSave.current = { timer, finish }
  }

  async function copyHtml() {
    /* one timer only, so an older copy can't clear the newest tick early */
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    try {
      await navigator.clipboard.writeText(draft)
      setHtmlCopy('copied')
      copyTimer.current = window.setTimeout(() => setHtmlCopy('idle'), 1500)
    } catch (caught) {
      console.error(caught)
      /* a failure stays up until the next attempt, so it can be read */
      setHtmlCopy('failed')
    }
  }

  /* the choice to show the raw HTML editor sticks across frames and visits */
  function toggleHtml(next: boolean) {
    setShowHtml(next)
    localStorage.setItem(HTML_OPEN_KEY, next ? '1' : '0')
  }

  function commitMeta(patch: Partial<Frame>) {
    recordUpdate(frame.id, frame, patch)
    useStore.getState().patchFrameLocal(frame.id, patch)
    api.updateFrame(frame.id, patch).catch(console.error)
  }

  return (
    <Panel
      surface={surface}
      className={cn(
        surface === 'floating' && 'top-2.5 bottom-3.5 w-[244px] transition-[right] duration-150',
        'max-md:overflow-y-auto max-md:overscroll-contain',
        className,
      )}
      style={style}
    >
      <PanelHeader className="pl-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <FrameIcon className="size-3.5 flex-none text-ink-faint" />
          <NameInput key={frame.id} value={frame.name} onCommit={(v) => v.trim() && commitMeta({ name: v.trim() })} />
        </span>
        <PanelClose onClick={() => select(null)} />
      </PanelHeader>
      {frame.locked && (
        <div className="flex items-center justify-between gap-2 border-b border-line-soft bg-sub py-1.5 pr-2 pl-3">
          <span
            className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-soft"
            title="Locked — can’t be moved, resized or deleted on the canvas"
          >
            <LockIcon className="size-3 flex-none" />
            Locked
          </span>
          <Button
            variant="bare"
            className="h-6 rounded-[6px] bg-surface px-2 text-[12px] font-normal text-ink shadow-ring"
            onClick={() => setFramesLocked([frame], false)}
          >
            Unlock
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <InspectorGroup title="Development">
          <FrameApprovalControl key={frame.id} frame={frame} hasUnsavedChanges={saveState === 'dirty'} />
        </InspectorGroup>
        <InspectorGroup title="Position">
          <div className="grid grid-cols-2 gap-1.5">
            <NumInput label="X" value={frame.x} onCommit={(v) => commitMeta({ x: v })} />
            <NumInput label="Y" value={frame.y} onCommit={(v) => commitMeta({ y: v })} />
          </div>
        </InspectorGroup>
        <InspectorGroup title="Layout">
          <div className="grid grid-cols-2 gap-1.5">
            <NumInput label="W" value={frame.width} onCommit={(v) => commitMeta({ width: Math.max(120, v) })} />
            <NumInput label="H" value={frame.height} onCommit={(v) => commitMeta({ height: Math.max(80, v) })} />
          </div>
        </InspectorGroup>
        <InspectorGroup title="Export">
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant="bare"
              className={fillBtn}
              title="Download as PNG (2×)"
              onClick={() => void downloadFrameExport(frame, 'png')}
            >
              PNG
            </Button>
            <Button
              variant="bare"
              className={fillBtn}
              title="Download as JPG (2×)"
              onClick={() => void downloadFrameExport(frame, 'jpg')}
            >
              JPG
            </Button>
            <Button
              variant="bare"
              className={cn(fillBtn, 'col-span-2')}
              title="Copy the image (2×) to paste anywhere"
              onClick={() => void copyFramePng(frame)}
            >
              Copy as PNG
            </Button>
            <Button
              variant="bare"
              className={cn(fillBtn, 'col-span-2')}
              title="Public image URL — always renders the current design; paste it as og:image or a blog featured image"
              onClick={() => {
                navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=2`).then(() => {
                  setCopiedUrl(true)
                  window.setTimeout(() => setCopiedUrl(false), 1500)
                }, console.error)
              }}
            >
              {copiedUrl ? 'Copied' : 'Copy image URL'}
            </Button>
          </div>
        </InspectorGroup>
        <InspectorGroup title="Memory">
          <Button
            variant="bare"
            className={cn(fillBtn, 'w-full')}
            title="Add to design memory — will be used as reference"
            onClick={() => api.pinReference(frame.canvasId, frame.id).catch(console.error)}
          >
            Pin as reference
          </Button>
        </InspectorGroup>
        <Collapsible className="flex min-h-0 flex-col" open={showHtml} onOpenChange={toggleHtml}>
          <div className="border-b border-line-soft px-3 py-2">
            {/* the heading folds the raw editor; the buttons take the HTML out */}
            <button
              type="button"
              aria-expanded={showHtml}
              title={showHtml ? 'Hide the HTML editor' : 'Edit the HTML'}
              onClick={() => toggleHtml(!showHtml)}
              className="mb-1.5 -ml-1 flex h-5 items-center gap-1 rounded-[5px] px-1 text-[12px] text-ink-soft hover:text-ink"
            >
              Code
            </button>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant="bare"
                className={cn(fillBtn, 'gap-1.5')}
                title="Copy the frame's HTML"
                onClick={copyHtml}
              >
                <CopyIcon className="size-3.5" />
                {htmlCopy === 'copied' ? 'Copied' : 'Copy'}
              </Button>
              <Button
                variant="bare"
                className={cn(fillBtn, 'gap-1.5')}
                title="Save the frame's HTML as a file"
                onClick={() => downloadFrameHtml(frame, draft)}
              >
                <DownloadIcon className="size-3.5" />
                Export
              </Button>
            </div>
            {htmlCopy === 'failed' && (
              <p className="pt-2 text-[11px] text-accent-ink">
                Couldn’t copy the HTML. Select it in the editor and copy it by hand.
              </p>
            )}
          </div>
          <CollapsibleContent className="relative flex min-h-0 flex-col">
            <Textarea
              ref={textareaRef}
              variant="code"
              className="h-[320px] flex-none max-md:h-auto max-md:min-h-[160px] max-md:flex-1"
              value={draft}
              spellCheck={false}
              placeholder="<!doctype html>…"
              onChange={(e) => onHtmlChange(e.target.value)}
            />
          </CollapsibleContent>
        </Collapsible>
      </div>
      <footer className="flex flex-none items-center justify-between gap-2 border-t border-line-soft py-2 pr-2 pl-3">
        <span className="min-w-0 truncate text-[11px] text-ink-faint">
          {saveState === 'dirty' ? 'saving…' : saveState === 'saved' ? 'saved' : `last edit by ${frame.updatedBy}`}
        </span>
        <span className="flex flex-none items-center gap-0.5">
          <Button
            variant="bare"
            size="sm"
            className="h-7 rounded-[7px] px-2 text-[12px] font-normal"
            onClick={() => setHistoryOpen(true)}
          >
            History
          </Button>
          <Button
            variant="bare-danger"
            size="sm"
            className="h-7 rounded-[7px] px-2 text-[12px] font-normal"
            disabled={!!frame.locked}
            title={frame.locked ? 'Unlock the frame to delete it' : undefined}
            onClick={() => deleteFrameTracked(frame)}
          >
            Delete
          </Button>
        </span>
      </footer>
      {historyOpen && <FrameHistoryModal frame={frame} onClose={() => setHistoryOpen(false)} />}
    </Panel>
  )
}

/** One titled block of the rail: a 12px grey heading over its controls. */
function InspectorGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line-soft px-3 py-2">
      <h3 className="mb-1.5 flex h-5 items-center text-[12px] font-normal text-ink-soft">{title}</h3>
      {children}
    </section>
  )
}

/** The frame's name, edited in place in the panel header. */
function NameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  /* a committed or remote value replaces whatever was being typed */
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <Input
      variant="bare"
      inputSize="auto"
      aria-label="Frame name"
      className="h-7 min-w-0 flex-1 truncate rounded-[6px] px-1 text-[12.5px] font-medium hover:bg-sub focus:bg-surface focus:shadow-elevation-1-focus md:text-[12.5px] max-md:min-h-10"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function NumInput({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(String(value))
  }
  return (
    <label className="flex h-7 min-w-0 items-center gap-[7px] rounded-[7px] bg-sub px-2 focus-within:bg-surface focus-within:shadow-elevation-1-focus max-md:h-10">
      <span className="flex-none text-[10.5px] text-ink-ghost">{label}</span>
      <input
        aria-label={{ X: 'X position', Y: 'Y position', W: 'Width', H: 'Height' }[label] ?? label}
        className="w-full min-w-0 bg-transparent font-mono text-[11px] text-ink outline-none"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Math.round(Number(draft))
          if (!Number.isNaN(n) && n !== value) onCommit(n)
          else setDraft(String(value))
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  )
}
