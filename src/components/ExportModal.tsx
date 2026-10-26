import { useState } from 'react'
import type { Frame } from '../../shared/types'
import { readingOrder } from '../../shared/frameOrder'
import { downloadFramesPdf } from '../lib/frameExport'
import { posthog } from '../lib/posthog'
import { ImportStepHeader } from './ImportSources'
import { Button } from './ui/button'
import { FrameThumb } from './FramePreview'
import { Checkbox } from './ui/checkbox'
import { PdfIcon } from './ui/icons'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { SelectionBar, SelectionBarAction } from './ui/selection-bar'

/**
 * The top bar's Export: the page's frames as a checklist (the canvas
 * selection pre-checked, or every frame when nothing is selected), bound
 * into one PDF, a vector page per frame. The pages follow reading order,
 * which the checklist shows and numbers; the outcome lands in the canvas
 * toast. A frame's own PNG and JPG live in its context menu.
 */
export function ExportModal({
  frames,
  initialSelection,
  onClose,
}: {
  /** every frame on the current page, in layer order */
  frames: Frame[]
  /** frame ids checked when the modal opens; empty checks them all */
  initialSelection: string[]
  onClose: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelection.length ? initialSelection : frames.map((frame) => frame.id)),
  )
  /* the PDF takes the checked frames in the listed order (re-sorting only
     the checked ones could regroup the rows) */
  const listed = readingOrder(frames)
  const chosen = listed.filter((frame) => selected.has(frame.id))

  function toggle(frameId: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(frameId)) next.delete(frameId)
      else next.add(frameId)
      return next
    })
  }

  function run() {
    const [first] = chosen
    if (!first) return
    posthog.capture('frames_exported', { destination: 'pdf', frame_count: chosen.length })
    void downloadFramesPdf(first.canvasId, chosen)
    onClose()
  }

  if (!frames.length) {
    return (
      <Modal size="sm" onClose={onClose}>
        <ModalTitle>Nothing to export yet</ModalTitle>
        <ModalLede>Add a frame to this page first.</ModalLede>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </ModalActions>
      </Modal>
    )
  }

  return (
    <Modal size="xl" className="sm:max-w-[820px]" onClose={onClose}>
      <ImportStepHeader icon={<PdfIcon size={22} />} title="Export as PDF" />
      <ModalLede>
        The frames you check become one PDF, a vector page per frame at its own size, in the order below: top to bottom,
        then left to right on the canvas.
      </ModalLede>
      <SelectionBar
        className="mt-5"
        count={chosen.length}
        total={frames.length}
        actions={
          <>
            <SelectionBarAction onClick={() => setSelected(new Set(frames.map((frame) => frame.id)))}>
              Select all
            </SelectionBarAction>
            <SelectionBarAction onClick={() => setSelected(new Set())}>Clear</SelectionBarAction>
          </>
        }
      />
      <div
        className="max-h-[calc(100dvh-390px)] overflow-y-auto rounded-[11px] border border-line bg-paper sm:max-h-[min(350px,calc(100vh-390px))]"
        role="group"
        aria-label="Frames to export"
      >
        {listed.map((frame, index) => (
          <label
            key={frame.id}
            className="relative grid min-h-[58px] cursor-pointer grid-cols-[20px_24px_64px_minmax(0,1fr)] items-center gap-2.5 border-b border-line bg-surface px-3 py-[9px] first:rounded-t-[10px] last:rounded-t-none last:rounded-b-[10px] last:border-b-0 hover:bg-paper"
          >
            <Checkbox checked={selected.has(frame.id)} onChange={() => toggle(frame.id)} />
            <span className="font-mono text-[9.5px] text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
            <FrameThumb frameId={frame.id} />
            <span className="min-w-0">
              <b className="block overflow-hidden whitespace-nowrap text-ellipsis text-[12.5px] text-ink">
                {frame.name || 'Untitled frame'}
              </b>
              <span className="mt-[3px] block font-mono text-[10px] text-ink-faint">
                {Math.round(frame.width)} × {Math.round(frame.height)}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-2.5 border-t border-line-soft pt-[18px]">
        <span className="mr-auto min-w-0 text-label leading-[1.4] text-ink-faint">
          Text stays selectable. A long document can take a few seconds per page.
        </span>
        <Button variant="ghost" className="flex-none" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!chosen.length} onClick={run}>
          {chosen.length > 1 ? `Download PDF (${chosen.length} pages)` : 'Download PDF'}
        </Button>
      </div>
    </Modal>
  )
}
