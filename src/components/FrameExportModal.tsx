import { readingOrder } from '../../shared/frameOrder'
import type { Frame } from '../../shared/types'
import { downloadFrameExport, downloadFramesPdf, type FrameExportFormat } from '../lib/frameExport'
import { AppIcon } from './ui/brand-mark'
import { Button } from './ui/button'
import { ChoiceList, ChoiceRow } from './ui/choice-list'
import { ImportIcon } from './ui/icons'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { useT } from '@/lib/i18n'

/** A frame's own export: its formats as a list, each row downloads. */
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

  const downloadMark = <ImportIcon size="rail" />
  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle className="break-words">{t('panels.frameExportTitle', { name: frame.name })}</ModalTitle>
      <ModalLede>{t('panels.frameExportLede')}</ModalLede>
      <ChoiceList className="mt-5">
        <ChoiceRow
          icon={<AppIcon brand="png" />}
          title={t('panels.frameExportPng')}
          description={t('panels.frameExportPngHint')}
          trailing={downloadMark}
          onClick={() => download('png')}
        />
        <ChoiceRow
          icon={<AppIcon brand="jpg" />}
          title={t('panels.frameExportJpg')}
          description={t('panels.frameExportJpgHint')}
          trailing={downloadMark}
          onClick={() => download('jpg')}
        />
        <ChoiceRow
          icon={<AppIcon brand="pdf" />}
          title={
            groupFrames.length > 1
              ? t('panels.frameExportPdfGroup', { count: groupFrames.length })
              : t('panels.exportDownloadPdf')
          }
          description={groupFrames.length > 1 ? t('panels.frameExportPdfGroupHint') : t('panels.frameExportPdfHint')}
          trailing={downloadMark}
          onClick={downloadPdf}
        />
      </ChoiceList>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
