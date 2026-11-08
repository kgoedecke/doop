import { useState } from 'react'
import type { Frame } from '../../shared/types'
import { readingOrder } from '../../shared/frameOrder'
import { MAX_PDF_FRAMES } from '../../shared/pdfLimits'
import { downloadFramesPdf } from '../lib/frameExport'
import { posthog } from '../lib/posthog'
import { ImportStepHeader } from './ImportSources'
import { Button } from './ui/button'
import { FrameThumb } from './FramePreview'
import { Checkbox } from './ui/checkbox'
import { AppIcon } from './ui/brand-mark'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { SelectionBar, SelectionBarAction } from './ui/selection-bar'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

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
  /* the server refuses a longer PDF: keep the checklist open until it fits */
  const overPdfLimit = chosen.length > MAX_PDF_FRAMES
  const extra = chosen.length - MAX_PDF_FRAMES
  const t = useT()

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
    if (!first || overPdfLimit) return
    posthog.capture('frames_exported', { destination: 'pdf', frame_count: chosen.length })
    void downloadFramesPdf(first.canvasId, chosen)
    onClose()
  }

  if (!frames.length) {
    return (
      <Modal size="sm" onClose={onClose}>
        <ModalTitle>{t('panels.exportNothing')}</ModalTitle>
        <ModalLede>{t('panels.exportNothingLede')}</ModalLede>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </ModalActions>
      </Modal>
    )
  }

  return (
    <Modal size="lg" onClose={onClose}>
      <ImportStepHeader
        icon={<AppIcon brand="pdf" size={40} />}
        title={t('panels.exportPdfTitle')}
        lede={t('panels.exportPdfLede')}
      />
      <SelectionBar
        className="mt-5"
        count={chosen.length}
        total={frames.length}
        actions={
          <>
            <SelectionBarAction onClick={() => setSelected(new Set(frames.map((frame) => frame.id)))}>
              {t('panels.exportSelectAll')}
            </SelectionBarAction>
            <SelectionBarAction onClick={() => setSelected(new Set())}>{t('panels.exportClear')}</SelectionBarAction>
          </>
        }
      />
      <div
        className="max-h-[calc(100dvh-390px)] overflow-y-auto rounded-panel bg-surface shadow-ring sm:max-h-[min(350px,calc(100vh-390px))]"
        role="group"
        aria-label={t('panels.exportFramesAria')}
      >
        {listed.map((frame) => (
          <label
            key={frame.id}
            className="relative grid min-h-[60px] cursor-pointer grid-cols-[20px_64px_minmax(0,1fr)] items-center gap-3 border-b border-line-soft px-4 py-2.5 transition-colors last:border-b-0 hover:bg-sub"
          >
            <Checkbox checked={selected.has(frame.id)} onChange={() => toggle(frame.id)} />
            <FrameThumb frameId={frame.id} />
            <span className="min-w-0">
              <span className="block truncate text-copy font-medium text-ink">
                {frame.name || t('panels.exportUntitled')}
              </span>
              <span className="block font-mono text-caption text-ink-faint">
                {Math.round(frame.width)} × {Math.round(frame.height)}
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className={cn('mt-2 px-0.5 text-caption', overPdfLimit ? 'text-accent-ink' : 'text-ink-faint')}>
        {overPdfLimit
          ? `${t('panels.exportPdfMax', { count: MAX_PDF_FRAMES })} ${t('panels.exportUncheck', { count: extra })}`
          : t('panels.exportPdfHint')}
      </p>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={!chosen.length || overPdfLimit} onClick={run}>
          {chosen.length > 1
            ? t('panels.exportDownloadPdfPages', { count: chosen.length })
            : t('panels.exportDownloadPdf')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
