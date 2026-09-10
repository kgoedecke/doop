import { useEffect, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { deleteFrameTracked, recordUpdate } from '../lib/history'
import { cn } from '@/lib/utils'
import { Panel, PanelClose, PanelDisclosure, PanelHeader } from './ui/panel'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field } from './ui/field'
import { Textarea } from './ui/textarea'

const HTML_OPEN_KEY = 'doop:inspector-html'

/* the export row's buttons: the standard button, tightened, and tall enough
   to hit on a phone */
const exportBtn = 'px-[11px] py-[5px] text-xs no-underline max-md:min-h-9'

export function Inspector({
  frame,
  surface = 'floating',
  className,
}: {
  frame: Frame
  /* 'inline' when the inspector is filling a mobile Sheet */
  surface?: 'floating' | 'inline'
  className?: string
}) {
  const select = useStore((s) => s.select)
  /* the raw HTML editor is a power tool — collapsed by default so the panel
     reads as frame properties, not a code dump; the choice sticks */
  const [showHtml, setShowHtml] = useState(() => localStorage.getItem(HTML_OPEN_KEY) === '1')
  const [draft, setDraft] = useState(frame.html)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saved'>('idle')
  const [copiedUrl, setCopiedUrl] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<number | null>(null)
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
  }, [frame.id, frame.html, draft])

  function onHtmlChange(value: string) {
    setDraft(value)
    setSaveState('dirty')
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      const before = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)?.html
      if (before !== undefined) recordUpdate(frame.id, { html: before }, { html: value })
      await api.updateFrame(frame.id, { html: value }).catch(console.error)
      setSaveState('saved')
      window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500)
    }, 700)
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
        surface === 'floating' && 'right-3 top-3 max-h-[calc(100%-24px)] w-[340px] transition-[right] duration-150',
        'max-md:overflow-y-auto max-md:overscroll-contain',
        className,
      )}
    >
      <PanelHeader>
        Frame
        <PanelClose onClick={() => select(null)}>✕</PanelClose>
      </PanelHeader>
      <div className="grid grid-cols-2 gap-2.5 border-b border-line-soft px-4 py-3.5">
        <Field label="Name" className="col-span-full">
          <NumberlessInput
            key={frame.id}
            value={frame.name}
            onCommit={(v) => v.trim() && commitMeta({ name: v.trim() })}
          />
        </Field>
        <Field label="X">
          <NumInput value={frame.x} onCommit={(v) => commitMeta({ x: v })} />
        </Field>
        <Field label="Y">
          <NumInput value={frame.y} onCommit={(v) => commitMeta({ y: v })} />
        </Field>
        <Field label="Width">
          <NumInput value={frame.width} onCommit={(v) => commitMeta({ width: Math.max(120, v) })} />
        </Field>
        <Field label="Height">
          <NumInput value={frame.height} onCommit={(v) => commitMeta({ height: Math.max(80, v) })} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
        <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Export</span>
        <Button asChild className={exportBtn} title="Download as PNG (2×)">
          <a href={`/i/${frame.id}.png?scale=2&download`}>PNG</a>
        </Button>
        <Button asChild className={exportBtn} title="Download as JPG (2×)">
          <a href={`/i/${frame.id}.jpg?scale=2&download`}>JPG</a>
        </Button>
        <Button
          className={exportBtn}
          title="Add to design memory — will be used as reference"
          onClick={() => api.pinReference(frame.canvasId, frame.id).catch(console.error)}
        >
          ☆ Pin
        </Button>
        <Button
          className={exportBtn}
          title="Public image URL — always renders the current design; paste it as og:image or a blog featured image"
          onClick={() => {
            navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=2`).then(() => {
              setCopiedUrl(true)
              window.setTimeout(() => setCopiedUrl(false), 1500)
            }, console.error)
          }}
        >
          {copiedUrl ? '✓ copied' : 'Copy image URL'}
        </Button>
      </div>
      <Collapsible
        className="flex min-h-0 flex-col"
        open={showHtml}
        onOpenChange={(next) => {
          setShowHtml(next)
          localStorage.setItem(HTML_OPEN_KEY, next ? '1' : '0')
        }}
      >
        <PanelDisclosure>
          <span>{'</>'} HTML</span>
        </PanelDisclosure>
        <CollapsibleContent className="flex min-h-0 flex-col">
          <Textarea
            ref={textareaRef}
            variant="bare"
            className="h-[320px] flex-none bg-[#17171b] p-3.5 font-mono text-xs leading-[1.55] text-[#e9e9ee] [tab-size:2] max-md:h-auto max-md:min-h-[160px] max-md:flex-1 md:text-xs"
            value={draft}
            spellCheck={false}
            placeholder="<!doctype html>…"
            onChange={(e) => onHtmlChange(e.target.value)}
          />
        </CollapsibleContent>
      </Collapsible>
      <footer className="flex items-center justify-between border-t border-line-soft px-4 py-2.5">
        <span className="font-mono text-[11px] text-ink-faint">
          {saveState === 'dirty' ? 'saving…' : saveState === 'saved' ? 'saved ✓' : `last edit by ${frame.updatedBy}`}
        </span>
        <Button variant="bare-danger" size="sm" onClick={() => deleteFrameTracked(frame)}>
          Delete frame
        </Button>
      </footer>
    </Panel>
  )
}

function NumberlessInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  /* a committed or remote value replaces whatever was being typed */
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <Input
      variant="mono"
      inputSize="sm"
      className="font-sans font-semibold max-md:min-h-10"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function NumInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(String(value))
  }
  return (
    <Input
      variant="mono"
      inputSize="sm"
      className="max-md:min-h-10"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Math.round(Number(draft))
        if (!Number.isNaN(n) && n !== value) onCommit(n)
        else setDraft(String(value))
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}
