import { readingOrder } from '../../shared/frameOrder'
import type { Frame } from '../../shared/types'
import {
  downloadElementExport,
  downloadFrameExport,
  downloadFramesPdf,
  type ElementTarget,
  type FrameExportFormat,
} from '../lib/frameExport'
import { setExportSettings, useExportSettings } from '../lib/exportSettings'
import { ExportOptions } from './ExportOptions'
import { AppIcon } from './ui/brand-mark'
import { Button } from './ui/button'
import { ChoiceList, ChoiceRow } from './ui/choice-list'
import { ImportIcon } from './ui/icons'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { useT } from '@/lib/i18n'

/** A frame's own export, or one element's: the scale to render at, then
 *  its formats as a list, each row downloads. */
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
  /** one element of the frame instead of the whole of it: no PDF */
  element?: ElementTarget
  onClose: () => void
}) {
  const t = useT()
  const settings = useExportSettings()

  /* the row picked is remembered as the format, so the Inspector's Export
     starts from it too */
  function download(format: FrameExportFormat) {
    setExportSettings({ format })
    if (element) void downloadElementExport(frame, element, format, settings.scale)
    else void downloadFrameExport(frame, format, settings.scale)
    onClose()
  }

  function downloadPdf() {
    void downloadFramesPdf(frame.canvasId, readingOrder(groupFrames))
    onClose()
  }

  const downloadMark = <ImportIcon size="rail" />
  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle className="break-words">
        {t('panels.frameExportTitle', { name: element?.name ?? frame.name })}
      </ModalTitle>
      <ModalLede>{element ? t('panels.elementExportLede') : t('panels.frameExportLede')}</ModalLede>
      <div className="mt-5">
        <ExportOptions value={settings} onChange={setExportSettings} withFormat={false} />
      </div>
      <ChoiceList className="mt-3">
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
          icon={<AppIcon brand="svg" />}
          title={t('panels.frameExportSvg')}
          description={t('panels.frameExportSvgHint')}
          trailing={downloadMark}
          onClick={() => download('svg')}
        />
        {!element && (
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
        )}
      </ChoiceList>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
