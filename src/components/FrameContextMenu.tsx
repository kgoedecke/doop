import type { MutableRefObject } from 'react'
import type { Frame } from '../../shared/types'
import { api } from '../lib/api'
import { copyFrames, duplicateFrames, hasFrameClip, pasteFrameAtScreen } from '../lib/frameClipboard'
import { deleteFramesTracked } from '../lib/history'
import { useStore } from '../lib/store'
import { MOD_KEY } from '../lib/keys'
import { formatHtml } from '../lib/htmlFormatter'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { MenuHint } from './ui/menu'

/** Right-click menu for a frame. FrameView owns the trigger, and passes the
 *  point the right-click happened at — Paste lands there. */
export function FrameContextMenu({ frame, at }: { frame: Frame; at: MutableRefObject<{ x: number; y: number }> }) {
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
    <ContextMenuContent>
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
      <ContextMenuItem onSelect={() => navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=2`)}>
        Copy image URL
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          const formatted = formatHtml(frame.html)
          navigator.clipboard.writeText(formatted).catch(console.error)
        }}
      >
        Copy HTML
      </ContextMenuItem>
      <ContextMenuItem asChild>
        <a href={`/i/${frame.id}.png?scale=2&download`}>Download PNG</a>
      </ContextMenuItem>
      <ContextMenuItem asChild>
        <a href={`/i/${frame.id}.jpg?scale=2&download`}>Download JPG</a>
      </ContextMenuItem>
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
  )
}
