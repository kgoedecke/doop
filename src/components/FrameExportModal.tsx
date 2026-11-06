import { readingOrder } from '../../shared/frameOrder'
import type { Frame } from '../../shared/types'
import {
  downloadElementExport,
  downloadFrameExport,
  downloadFramesPdf,
  FORMAT_LABEL,
  type ElementTarget,
} from '../lib/frameExport'
import { setExportSettings, useExportSettings } from '../lib/exportSettings'
import { ExportOptions } from './ExportOptions'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { useT } from '@/lib/i18n'

export function FrameExportModal({
  frame,
  groupFrames = [frame],
  element,
  onClose,
}: {
  frame: Frame
  /** the selection the menu acts on; the PDF binds all of it, a page per
   *  frame in reading order */
  groupFrames?: Frame[]
  /** one element of the frame instead of the whole of it: no PDF, and no
   *  size shown until the export measures it */
  element?: ElementTarget
  onClose: () => void
}) {
  const t = useT()
  const settings = useExportSettings()

  function download() {
    if (element) void downloadElementExport(frame, element, settings.format, settings.scale)
    else void downloadFrameExport(frame, settings.format, settings.scale)
    onClose()
  }

  function downloadPdf() {
    void downloadFramesPdf(frame.canvasId, readingOrder(groupFrames))
    onClose()
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle className="break-words">
        {t('panels.frameExportTitle', { name: element?.name ?? frame.name })}
      </ModalTitle>
      <ModalLede>{element ? t('panels.elementExportLede') : t('panels.frameExportLede')}</ModalLede>
      <div className="mt-5 grid gap-3">
        <ExportOptions value={settings} onChange={setExportSettings} />
        {settings.format === 'svg' && <p className="text-caption text-ink-soft">{t('panels.exportSvgHint')}</p>}
        <Button variant="primary" onClick={download}>
          {t('panels.exportDownloadFormat', { label: FORMAT_LABEL[settings.format] })}
        </Button>
        {!element && (
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
        )}
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
