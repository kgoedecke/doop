import type { Frame } from '../../shared/types'
import { downloadFrameExport, type FrameExportFormat } from '../lib/frameExport'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'

export function FrameExportModal({ frame, onClose }: { frame: Frame; onClose: () => void }) {
  function download(format: FrameExportFormat) {
    void downloadFrameExport(frame, format)
    onClose()
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle className="break-words">Export “{frame.name}”</ModalTitle>
      <ModalLede>Download this frame as a PNG or JPG image.</ModalLede>
      <div className="mt-5 grid gap-2">
        <Button variant="ghost" className="justify-start" onClick={() => download('png')}>
          Download PNG
        </Button>
        <Button variant="ghost" className="justify-start" onClick={() => download('jpg')}>
          Download JPG
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
