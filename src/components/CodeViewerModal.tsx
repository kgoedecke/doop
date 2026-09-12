import { useEffect, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { Modal, ModalEyebrow, ModalTitle } from './ui/modal'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { formatHtml, HtmlHighlightView } from '../lib/htmlFormatter'
import { XIcon } from './ui/icons'

export function CodeViewerModal({
  open,
  frame,
  code,
  onClose,
  onSaveCode,
}: {
  open: boolean
  frame: Frame
  code: string
  onClose: () => void
  onSaveCode?: (newCode: string) => void
}) {
  const [draft, setDraft] = useState(code)
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [wrapLines, setWrapLines] = useState(false)
  const frameIdRef = useRef(frame.id)

  /* Keep modal draft synchronized with incoming frame updates or frame switching */
  useEffect(() => {
    const switched = frameIdRef.current !== frame.id
    frameIdRef.current = frame.id
    if (switched || (!isEditing && code !== draft)) {
      setDraft(code)
    }
  }, [frame.id, code, isEditing, draft])

  if (!open) return null

  const displayCode = draft
  const linesCount = displayCode ? displayCode.split('\n').length : 0
  const charCount = displayCode.length

  function handleCopy() {
    navigator.clipboard.writeText(draft).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    }, console.error)
  }

  function handleDownload() {
    const blob = new Blob([draft], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${frame.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'frame'}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleFormat() {
    const reformatted = formatHtml(draft)
    setDraft(reformatted)
    if (onSaveCode && reformatted !== code) {
      onSaveCode(reformatted)
    }
  }

  function handleCodeChange(val: string) {
    setDraft(val)
    if (onSaveCode) {
      onSaveCode(val)
    }
  }

  return (
    <Modal size="xl" open={open} onClose={onClose} className="max-w-[960px] p-6 sm:p-7">
      {/* Header Bar following Doop editorial typography & layout */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line-soft pb-4">
        <div>
          <ModalEyebrow>FRAME HTML CODE</ModalEyebrow>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <ModalTitle className="text-2xl font-normal text-ink sm:text-3xl">{frame.name}</ModalTitle>
            <span className="font-mono text-xs text-ink-faint">
              {linesCount} {linesCount === 1 ? 'line' : 'lines'} · {charCount.toLocaleString()} chars
            </span>
          </div>
        </div>

        {/* Toolbar Controls styled with Doop button variants */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" mono onClick={handleFormat} title="Auto-format HTML">
            Format
          </Button>

          <Button
            variant={wrapLines ? 'default' : 'ghost'}
            size="sm"
            mono
            onClick={() => setWrapLines(!wrapLines)}
            title="Toggle word wrapping"
          >
            {wrapLines ? 'Unwrap' : 'Word Wrap'}
          </Button>

          <Button
            variant={isEditing ? 'default' : 'ghost'}
            size="sm"
            mono
            onClick={() => setIsEditing(!isEditing)}
            title={isEditing ? 'View syntax highlighted code' : 'Edit raw HTML'}
          >
            {isEditing ? 'Preview' : 'Edit'}
          </Button>

          <Button variant="ghost" size="sm" mono onClick={handleDownload} title="Download HTML file">
            ↓ Download
          </Button>

          <Button variant="primary" size="sm" mono onClick={handleCopy} title="Copy code to clipboard">
            {copied ? '✓ Copied!' : 'Copy Code'}
          </Button>

          <button
            onClick={onClose}
            className="ml-1 rounded-sm p-1 text-ink-faint hover:bg-paper-deep hover:text-ink"
            aria-label="Close"
          >
            <XIcon className="size-4" strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {/* Main Code View Canvas following Doop ink surface styling */}
      <div className="relative my-4.5 h-[500px] max-h-[60vh] w-full overflow-hidden rounded-[12px] border border-line-soft bg-[#17171b]">
        {isEditing ? (
          <Textarea
            variant="bare"
            className="h-full w-full bg-[#17171b] p-4.5 font-mono text-xs leading-[1.65] text-[#e9e9ee] [tab-size:2] focus:outline-none"
            value={draft}
            spellCheck={false}
            onChange={(e) => handleCodeChange(e.target.value)}
          />
        ) : (
          <div className="h-full w-full overflow-auto p-4.5">
            <HtmlHighlightView code={draft} showLineNumbers wrapLines={wrapLines} />
          </div>
        )}
      </div>

      {/* Footer Status Bar with Doop brand styling */}
      <div className="flex items-center justify-between border-t border-line-soft pt-3.5 font-mono text-xs text-ink-faint">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <span className="inline-block size-2 rounded-full bg-brand" /> HTML5 Complete Page
          </span>
          <span>UTF-8</span>
        </div>
        <span>Press Esc to close</span>
      </div>
    </Modal>
  )
}
