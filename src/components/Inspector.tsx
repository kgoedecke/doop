import { useEffect, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { deleteFrameTracked, recordUpdate } from '../lib/history'

const HTML_OPEN_KEY = 'doop:inspector-html'

export function Inspector({ frame }: { frame: Frame }) {
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

  /* switching frames resets the draft */
  useEffect(() => {
    if (frameId.current !== frame.id) {
      frameId.current = frame.id
      setDraft(frame.html)
      setSaveState('idle')
    }
  }, [frame.id, frame.html])

  /* pull in remote html updates unless the user is typing */
  useEffect(() => {
    if (document.activeElement !== textareaRef.current && frame.html !== draft) {
      setDraft(frame.html)
      setSaveState('idle')
    }
  }, [draft, frame.html])

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
    <div className="side-panel inspector">
      <header>
        Frame
        <button onClick={() => select(null)} title="Close">
          ✕
        </button>
      </header>
      <div className="fields">
        <div className="full">
          <label>Name</label>
          <NumberlessInput
            key={frame.id}
            value={frame.name}
            onCommit={(v) => v.trim() && commitMeta({ name: v.trim() })}
          />
        </div>
        <div>
          <label>X</label>
          <NumInput value={frame.x} onCommit={(v) => commitMeta({ x: v })} />
        </div>
        <div>
          <label>Y</label>
          <NumInput value={frame.y} onCommit={(v) => commitMeta({ y: v })} />
        </div>
        <div>
          <label>Width</label>
          <NumInput value={frame.width} onCommit={(v) => commitMeta({ width: Math.max(120, v) })} />
        </div>
        <div>
          <label>Height</label>
          <NumInput value={frame.height} onCommit={(v) => commitMeta({ height: Math.max(80, v) })} />
        </div>
      </div>
      <div className="export-row">
        <label>Export</label>
        <a className="btn" href={`/i/${frame.id}.png?scale=2&download`} title="Download as PNG (2×)">
          PNG
        </a>
        <a className="btn" href={`/i/${frame.id}.jpg?scale=2&download`} title="Download as JPG (2×)">
          JPG
        </a>
        <button
          className="btn"
          title="Add to design memory — will be used as reference"
          onClick={() => api.pinReference(frame.canvasId, frame.id).catch(console.error)}
        >
          ☆ Pin
        </button>
        <button
          className="btn"
          title="Public image URL — always renders the current design; paste it as og:image or a blog featured image"
          onClick={() => {
            navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=2`)
            setCopiedUrl(true)
            window.setTimeout(() => setCopiedUrl(false), 1500)
          }}
        >
          {copiedUrl ? '✓ copied' : 'Copy image URL'}
        </button>
      </div>
      <button
        className="html-toggle"
        onClick={() => {
          const next = !showHtml
          setShowHtml(next)
          localStorage.setItem(HTML_OPEN_KEY, next ? '1' : '0')
        }}
      >
        <span>{'</>'} HTML</span>
        <span className="html-toggle-arrow">{showHtml ? '▾' : '▸'}</span>
      </button>
      {showHtml && (
        <textarea
          ref={textareaRef}
          className="html-editor"
          value={draft}
          spellCheck={false}
          placeholder="<!doctype html>…"
          onChange={(e) => onHtmlChange(e.target.value)}
        />
      )}
      <footer>
        <span className="save-state">
          {saveState === 'dirty' ? 'saving…' : saveState === 'saved' ? 'saved ✓' : `last edit by ${frame.updatedBy}`}
        </span>
        <button className="danger" onClick={() => deleteFrameTracked(frame)}>
          Delete frame
        </button>
      </footer>
    </div>
  )
}

function NumberlessInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  return (
    <input
      key={value}
      defaultValue={value}
      onBlur={(e) => e.currentTarget.value !== value && onCommit(e.currentTarget.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function NumInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  return (
    <input
      key={value}
      defaultValue={String(value)}
      onBlur={(e) => {
        const input = e.currentTarget
        const n = Math.round(Number(input.value))
        if (!Number.isNaN(n) && n !== value) onCommit(n)
        else input.value = String(value)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}
