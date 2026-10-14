import { useState, type MutableRefObject } from 'react'
import type { Frame } from '../../shared/types'
import { api, errorMessage } from '../lib/api'
import { copyFrames, duplicateFrames, hasFrameClip, pasteFrameAtScreen } from '../lib/frameClipboard'
import { deleteFramesTracked } from '../lib/history'
import { useStore } from '../lib/store'
import { MOD_KEY } from '../lib/keys'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { MenuHint } from './ui/menu'
import { FrameExportModal } from './FrameExportModal'

async function copyImageUrl(frame: Frame) {
  const notify = useStore.getState().pushNotice
  try {
    await navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=2`)
    notify('Image URL copied')
  } catch (err) {
    notify(errorMessage(err, 'Couldn’t copy the image URL'))
  }
}

/** Right-click menu for a frame. FrameView owns the trigger, and passes the
 *  point the right-click happened at — Paste lands there. */
export function FrameContextMenu({ frame, at }: { frame: Frame; at: MutableRefObject<{ x: number; y: number }> }) {
  const [showExport, setShowExport] = useState(false)
  /* a right-click inside a multi-selection acts on the whole group */
  const groupSize = useStore((s) => (s.selectedIds.includes(frame.id) ? s.selectedIds.length : 1))
  function groupFrames(): Frame[] {
    const s = useStore.getState()
    const ids = s.selectedIds.includes(frame.id) ? s.selectedIds : [frame.id]
    return s.canvas?.frames.filter((f) => ids.includes(f.id)) ?? [frame]
  }
  function deleteSelection() {
    deleteFramesTracked(groupFrames())
  }
  return (
    <>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          // The export dialog owns focus once the menu closes.
          if (showExport) event.preventDefault()
        }}
      >
        <ContextMenuItem onSelect={() => copyFrames(groupFrames())}>
          {groupSize > 1 ? `Copy ${groupSize} frames` : 'Copy'}
          <MenuHint>{MOD_KEY}C</MenuHint>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasFrameClip()}
          onSelect={() => pasteFrameAtScreen(frame.canvasId, at.current.x, at.current.y)}
        >
          Paste
          <MenuHint>{MOD_KEY}V</MenuHint>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => duplicateFrames(groupFrames())}>
          {groupSize > 1 ? `Duplicate ${groupSize} frames` : 'Duplicate'}
          <MenuHint>{MOD_KEY}D</MenuHint>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => navigator.clipboard.writeText(`${location.origin}/c/${frame.canvasId}?frame=${frame.id}`)}
        >
          Copy link
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyImageUrl(frame)}>Copy image URL</ContextMenuItem>
        <ContextMenuItem onSelect={() => setShowExport(true)}>Export…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          title="Will be used as reference — agents copy its style in new designs"
          onSelect={() => api.pinReference(frame.canvasId, frame.id).catch(console.error)}
        >
          Add to design memory
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem tone="danger" onSelect={deleteSelection}>
          {groupSize > 1 ? `Delete ${groupSize} frames` : 'Delete frame'}
          <MenuHint>⌫</MenuHint>
        </ContextMenuItem>
      </ContextMenuContent>
      {showExport && <FrameExportModal frame={frame} onClose={() => setShowExport(false)} />}
    </>
  )
}
