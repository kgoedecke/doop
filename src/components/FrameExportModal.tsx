import type { Frame } from '../../shared/types'
import { Button } from './ui/button'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'

export function FrameExportModal({ frame, onClose }: { frame: Frame; onClose: () => void }) {
  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle className="break-words">Export “{frame.name}”</ModalTitle>
      <ModalLede>Download this frame as a PNG or JPG image.</ModalLede>
      <div className="mt-5 grid gap-2">
        <Button asChild variant="ghost" className="justify-start" onClick={onClose}>
          <a href={`/i/${frame.id}.png?scale=2&download`}>Download PNG</a>
        </Button>
        <Button asChild variant="ghost" className="justify-start" onClick={onClose}>
          <a href={`/i/${frame.id}.jpg?scale=2&download`}>Download JPG</a>
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
