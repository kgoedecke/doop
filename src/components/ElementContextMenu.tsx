import type { Frame } from '../../shared/types'
import { copyElementLink } from '../lib/elementLink'
import { copyLayer, hasElementClip, pasteLayer } from '../lib/elementClipboard'
import { deleteLayer, duplicateLayer, setLayerHidden, setLayerLocked, shiftLayer } from '../lib/layerEdits'
import { elementHtml, isElementHidden, isElementLocked } from '../lib/layers'
import { MOD_KEY } from '../lib/keys'
import { useT } from '../lib/i18n'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { MenuHint } from './ui/menu'

/** What the live document said about a right-clicked element; a Layers row
 *  has none, its selector comes from the saved HTML itself. */
export interface LiveHit {
  snippet: string
  elementId?: string
}

/** Shared by a layer row and the element under a canvas right-click. */
export function ElementContextMenu({ frame, selector, hit }: { frame: Frame; selector: string | null; hit?: LiveHit }) {
  return (
    <ContextMenuContent>
      <ElementMenuItems frame={frame} selector={selector} hit={hit} />
    </ContextMenuContent>
  )
}

/** Radix mounts these children only while the menu is open. Closed layer
 *  rows must not parse their frame HTML just to render a dormant menu. */
function ElementMenuItems({ frame, selector, hit }: { frame: Frame; selector: string | null; hit?: LiveHit }) {
  const hidden = selector ? isElementHidden(frame.html, selector) : null
  const exists = hidden !== null
  const ownLock = selector ? isElementLocked(frame.html, selector, true) : false
  const locked = !!frame.locked || (selector ? isElementLocked(frame.html, selector) : false)
  const t = useT()
  return (
    <>
      <ContextMenuItem disabled={!exists} onSelect={() => selector && copyLayer(frame, selector)}>
        {t('common.copy')}
        <MenuHint>{MOD_KEY}C</MenuHint>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={locked || !hasElementClip() || (!!selector && !exists)}
        onSelect={() => pasteLayer(frame, selector)}
      >
        {t('stage.paste')}
        <MenuHint>{MOD_KEY}V</MenuHint>
      </ContextMenuItem>
      {selector && exists && (
        <>
          <ContextMenuItem disabled={locked} onSelect={() => duplicateLayer(frame, selector)}>
            {t('stage.duplicate')}
            <MenuHint>{MOD_KEY}D</MenuHint>
          </ContextMenuItem>
          <ContextMenuItem disabled={!!frame.locked} onSelect={() => setLayerHidden(frame, selector, !hidden)}>
            {hidden ? t('stage.show') : t('stage.hide')}
            <MenuHint>{MOD_KEY}⇧H</MenuHint>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => {
              const html = elementHtml(frame.html, selector)
              if (html) navigator.clipboard.writeText(html).catch(console.error)
            }}
          >
            {t('stage.copyHtml')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => navigator.clipboard.writeText(selector).catch(console.error)}>
            {t('stage.copySelector')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyElementLink(frame, { selector, ...hit })}>
            {t('stage.copyLinkToElement')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={locked} onSelect={() => shiftLayer(frame, selector, -1)}>
            {t('stage.moveUp')}
            <MenuHint>⌥↑</MenuHint>
          </ContextMenuItem>
          <ContextMenuItem disabled={locked} onSelect={() => shiftLayer(frame, selector, 1)}>
            {t('stage.moveDown')}
            <MenuHint>⌥↓</MenuHint>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!!frame.locked} onSelect={() => setLayerLocked(frame, selector, !ownLock)}>
            {ownLock ? t('stage.unlock') : t('stage.lock')}
            <MenuHint>{MOD_KEY}⇧L</MenuHint>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem tone="danger" disabled={locked} onSelect={() => deleteLayer(frame, selector)}>
            {t('stage.deleteElement')}
            <MenuHint>⌫</MenuHint>
          </ContextMenuItem>
        </>
      )}
    </>
  )
}
