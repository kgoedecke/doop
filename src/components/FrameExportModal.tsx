import { readingOrder } from '../../shared/frameOrder'
import type { Frame } from '../../shared/types'
import { downloadFrameExport, downloadFramesPdf, type FrameExportFormat } from '../lib/frameExport'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { useT } from '@/lib/i18n'

export function FrameExportModal({
  frame,
  groupFrames = [frame],
  onClose,
}: {
  frame: Frame
  /** the selection the menu acts on; the PDF binds all of it, a page per
   *  frame in reading order */
  groupFrames?: Frame[]
  onClose: () => void
}) {
  const t = useT()

  function download(format: FrameExportFormat) {
    void downloadFrameExport(frame, format)
    onClose()
  }

  function downloadPdf() {
    void downloadFramesPdf(frame.canvasId, readingOrder(groupFrames))
    onClose()
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle className="break-words">{t('panels.frameExportTitle', { name: frame.name })}</ModalTitle>
      <ModalLede>{t('panels.frameExportLede')}</ModalLede>
      <div className="mt-5 grid gap-2">
        <Button variant="ghost" className="justify-start" onClick={() => download('png')}>
          {t('panels.frameExportPng')}
        </Button>
        <Button variant="ghost" className="justify-start" onClick={() => download('jpg')}>
          {t('panels.frameExportJpg')}
        </Button>
        <Button
          variant="ghost"
          className="h-auto flex-col items-start gap-1 whitespace-normal text-left"
          onClick={downloadPdf}
        >
          <span>
            {groupFrames.length > 1
              ? t('panels.frameExportPdfGroup', { count: groupFrames.length })
              : t('panels.exportDownloadPdf')}
          </span>
          <span className="text-xs font-normal text-ink-soft">
            {groupFrames.length > 1 ? t('panels.frameExportPdfGroupHint') : t('panels.frameExportPdfHint')}
          </span>
        </Button>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
