import { useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { copyElementLink } from '../lib/elementLink'
import { copyElementPng, type ElementTarget } from '../lib/frameExport'
import { useExportSettings } from '../lib/exportSettings'
import { copyPicked, hasElementClip, pasteLayer } from '../lib/elementClipboard'
import { writeCanvasClipboard } from '../lib/canvasClipboard'
import { hasFrameClip, pasteFrameCentered } from '../lib/frameClipboard'
import { deleteLayer, duplicateLayer, setLayerHidden, setLayerLocked, shiftLayer } from '../lib/layerEdits'
import { buildLayerTree, elementHtml, findLayer, isElementHidden, isElementLocked, layerName } from '../lib/layers'
import { MOD_KEY } from '../lib/keys'
import { useT } from '../lib/i18n'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { MenuHint } from './ui/menu'
import { FrameExportModal } from './FrameExportModal'

/** What the live document said about a right-clicked element; a Layers row
 *  has none, its selector comes from the saved HTML itself. */
export interface LiveHit {
  snippet: string
  elementId?: string
}

/** The element as an export names it: by the Layers panel's name for it. */
function exportTarget(frame: Frame, selector: string): ElementTarget {
  const node = findLayer(buildLayerTree(frame.html), selector)
  return { selector, name: node ? layerName(node) : 'element' }
}

/** Shared by a layer row and the element under a canvas right-click. */
type ElementMenuProps = { frame: Frame; selector: string | null; hit?: LiveHit; onRename?: () => void }

/** The items also ask for the export dialog, which outlives the menu. */
type ElementItemsProps = ElementMenuProps & { onExport: (target: ElementTarget) => void }

export function ElementContextMenu({ frame, selector, hit, onRename }: ElementMenuProps) {
  const renameRequested = useRef(false)
  const [exporting, setExporting] = useState<ElementTarget | null>(null)
  return (
    <>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          // The export dialog owns focus once the menu closes.
          if (exporting) return event.preventDefault()
          if (!renameRequested.current) return
          event.preventDefault()
          renameRequested.current = false
          onRename?.()
        }}
      >
        <ElementMenuItems
          frame={frame}
          selector={selector}
          hit={hit}
          onExport={setExporting}
          onRename={
            onRename
              ? () => {
                  renameRequested.current = true
                }
              : undefined
          }
        />
      </ContextMenuContent>
      {exporting && <FrameExportModal frame={frame} element={exporting} onClose={() => setExporting(null)} />}
    </>
  )
}

/** Radix mounts these children only while the menu is open. Closed layer
 *  rows must not parse their frame HTML just to render a dormant menu. */
function ElementMenuItems({ frame, selector, hit, onRename, onExport }: ElementItemsProps) {
  const hidden = selector ? isElementHidden(frame.html, selector) : null
  const exists = hidden !== null
  const ownLock = selector ? isElementLocked(frame.html, selector, true) : false
  const locked = !!frame.locked || (selector ? isElementLocked(frame.html, selector) : false)
  const t = useT()
  const { scale } = useExportSettings()
  /* a copied standalone shape is a frame on the clipboard: its paste lands
     a second element on the canvas, as ⌘V does, not a layer in this frame */
  const frameClip = hasFrameClip()
  return (
    <>
      <ContextMenuItem
        disabled={!exists}
        onSelect={() => {
          if (selector) writeCanvasClipboard(() => copyPicked(frame, [selector]))
        }}
      >
        {t('common.copy')}
        <MenuHint>{MOD_KEY}C</MenuHint>
      </ContextMenuItem>
      <ContextMenuItem
        disabled={frameClip ? false : locked || !hasElementClip() || (!!selector && !exists)}
        onSelect={() => {
          if (frameClip) pasteFrameCentered(frame.canvasId)
          else pasteLayer(frame, selector)
        }}
      >
        {t('stage.paste')}
        <MenuHint>{MOD_KEY}V</MenuHint>
      </ContextMenuItem>
      {selector && exists && (
        <>
          {onRename && (
            <ContextMenuItem disabled={locked} onSelect={onRename}>
              {t('panels.layersRename')}
            </ContextMenuItem>
          )}
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
          <ContextMenuItem onSelect={() => onExport(exportTarget(frame, selector))}>
            {t('stage.exportEllipsis')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyElementPng(frame, exportTarget(frame, selector), scale)}>
            {t('stage.copyAsPng')}
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
