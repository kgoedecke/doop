import { PrototypePlayer } from './PrototypePlayer'

/* Full-screen presentation over the editor: the prototype player, starting on
   the frame it was launched from, still connected to the room so edits
   streaming in render live. Esc closes (after any open overlay). */
export function PresentMode({ frameId, onClose }: { frameId: string; onClose: () => void }) {
  return <PrototypePlayer key={frameId} startFrameId={frameId} onClose={onClose} />
}
