import type { Frame } from '../../shared/types'
import { copyElementLink } from '../lib/elementLink'
import { copyLayer, hasElementClip, pasteLayer } from '../lib/elementClipboard'
import { deleteLayer, duplicateLayer, setLayerHidden, setLayerLocked, shiftLayer } from '../lib/layerEdits'
import { elementHtml, isElementHidden, isElementLocked } from '../lib/layers'
import { MOD_KEY } from '../lib/keys'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { MenuHint } from './ui/menu'

/** Shared by a layer row and the element under a canvas right-click. */
export function ElementContextMenu({ frame, selector }: { frame: Frame; selector: string | null }) {
  return (
    <ContextMenuContent>
      <ElementMenuItems frame={frame} selector={selector} />
    </ContextMenuContent>
  )
}

/** Radix mounts these children only while the menu is open. Closed layer
 *  rows must not parse their frame HTML just to render a dormant menu. */
function ElementMenuItems({ frame, selector }: { frame: Frame; selector: string | null }) {
  const hidden = selector ? isElementHidden(frame.html, selector) : null
  const exists = hidden !== null
  const ownLock = selector ? isElementLocked(frame.html, selector, true) : false
  const locked = !!frame.locked || (selector ? isElementLocked(frame.html, selector) : false)
  return (
    <>
      <ContextMenuItem disabled={!exists} onSelect={() => selector && copyLayer(frame, selector)}>
        Copy
        <MenuHint>{MOD_KEY}C</MenuHint>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={locked || !hasElementClip() || (!!selector && !exists)}
        onSelect={() => pasteLayer(frame, selector)}
      >
        Paste
        <MenuHint>{MOD_KEY}V</MenuHint>
      </ContextMenuItem>
      {selector && exists && (
        <>
          <ContextMenuItem disabled={locked} onSelect={() => duplicateLayer(frame, selector)}>
            Duplicate
            <MenuHint>{MOD_KEY}D</MenuHint>
          </ContextMenuItem>
          <ContextMenuItem disabled={!!frame.locked} onSelect={() => setLayerHidden(frame, selector, !hidden)}>
            {hidden ? 'Show' : 'Hide'}
            <MenuHint>{MOD_KEY}⇧H</MenuHint>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => {
              const html = elementHtml(frame.html, selector)
              if (html) navigator.clipboard.writeText(html).catch(console.error)
            }}
          >
            Copy HTML
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => navigator.clipboard.writeText(selector).catch(console.error)}>
            Copy selector
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyElementLink(frame, selector)}>Copy link to element</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={locked} onSelect={() => shiftLayer(frame, selector, -1)}>
            Move up
            <MenuHint>⌥↑</MenuHint>
          </ContextMenuItem>
          <ContextMenuItem disabled={locked} onSelect={() => shiftLayer(frame, selector, 1)}>
            Move down
            <MenuHint>⌥↓</MenuHint>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!!frame.locked} onSelect={() => setLayerLocked(frame, selector, !ownLock)}>
            {ownLock ? 'Unlock' : 'Lock'}
            <MenuHint>{MOD_KEY}⇧L</MenuHint>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem tone="danger" disabled={locked} onSelect={() => deleteLayer(frame, selector)}>
            Delete element
            <MenuHint>⌫</MenuHint>
          </ContextMenuItem>
        </>
      )}
    </>
  )
}
