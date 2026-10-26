import { readingOrder } from '../../shared/frameOrder'
import type { Frame } from '../../shared/types'
import { downloadFrameExport, downloadFramesPdf, type FrameExportFormat } from '../lib/frameExport'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'

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
      <ModalTitle className="break-words">Export “{frame.name}”</ModalTitle>
      <ModalLede>Download this frame as a PNG or JPG image, or as a vector PDF.</ModalLede>
      <div className="mt-5 grid gap-2">
        <Button variant="ghost" className="justify-start" onClick={() => download('png')}>
          Download PNG
        </Button>
        <Button variant="ghost" className="justify-start" onClick={() => download('jpg')}>
          Download JPG
        </Button>
        <Button
          variant="ghost"
          className="h-auto flex-col items-start gap-1 whitespace-normal text-left"
          onClick={downloadPdf}
        >
          <span>{groupFrames.length > 1 ? `Download PDF of ${groupFrames.length} frames` : 'Download PDF'}</span>
          <span className="text-xs font-normal text-ink-soft">
            {groupFrames.length > 1
              ? 'One vector page per frame, top to bottom then left to right'
              : 'Vector page the size of the frame, text stays selectable'}
          </span>
        </Button>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </ModalActions>
    </Modal>
  )
}
