import { useState } from 'react'
import type { Frame } from '../../shared/types'
import { copyElementLink } from '../lib/elementLink'
import { copyElementPng, type ElementTarget } from '../lib/frameExport'
import { useExportSettings } from '../lib/exportSettings'
import { copyPicked, hasElementClip, pasteLayer } from '../lib/elementClipboard'
import { writeCanvasClipboard } from '../lib/canvasClipboard'
import { copyFrames, hasFrameClip, pasteFrameCentered } from '../lib/frameClipboard'
import {
  cutFrames,
  deleteLayers,
  setFramesHidden,
  setFramesLocked,
  setLayerHidden,
  setLayerLocked,
  standaloneSelector,
} from '../lib/layerEdits'
import { elementExportTarget, elementHtml, isElementHidden, isElementLocked } from '../lib/layers'
import { MOD_KEY } from '../lib/keys'
import { canEditOpenCanvas, pickedSelectors, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { changeInstance, componentContextOf, goToMain, restoreDeletedComponent } from '../lib/components'
import { isDeleted } from '../../shared/components'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from './ui/context-menu'
import { ActionHint, ActionMenuItem, MoveToPageMenu } from './ActionMenuItem'
import { MenuHint } from './ui/menu'
import { FrameExportModal } from './FrameExportModal'
import { trackPngCopy } from '../lib/exportEvents'

/** What the live document said about a right-clicked element; a Layers row
 *  has none, its selector comes from the saved HTML itself. */
export interface LiveHit {
  snippet: string
  elementId?: string
}

/** Shared by a layer row and the element under a canvas right-click. */
type ElementMenuProps = { frame: Frame; selector: string | null; hit?: LiveHit }

/** The items also ask for the export dialog, which outlives the menu. */
type ElementItemsProps = ElementMenuProps & { onExport: (target: ElementTarget) => void }

export function ElementContextMenu({ frame, selector, hit }: ElementMenuProps) {
  const [exporting, setExporting] = useState<ElementTarget | null>(null)
  return (
    <>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          // The export dialog owns focus once the menu closes.
          if (exporting) event.preventDefault()
        }}
      >
        <ElementMenuItems frame={frame} selector={selector} hit={hit} onExport={setExporting} />
      </ContextMenuContent>
      {exporting && <FrameExportModal frame={frame} element={exporting} onClose={() => setExporting(null)} />}
    </>
  )
}

/** Copy the elements, then remove them once the clipboard took the copy. The
 *  menu writes the clipboard asynchronously; a selector is a position in the
 *  frame's HTML, so if the frame changed meanwhile the element stays, rather
 *  than deleting whatever now sits at that position. */
function cutLayers(frame: Frame, selectors: string[]) {
  writeCanvasClipboard(
    () => copyPicked(frame, selectors),
    undefined,
    () => {
      const live = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
      if (live?.html === frame.html) deleteLayers(live, selectors)
    },
  )
}

/** Radix mounts these children only while the menu is open. Closed layer
 *  rows must not parse their frame HTML just to render a dormant menu.
 *
 *  The order follows Figma's and Paper's layer menus: selection, clipboard,
 *  structure, stacking, transform, visibility. Commands that act on the
 *  selection are registry rows (`ActionMenuItem`); the right-click picked the
 *  layer first, or kept the multi-pick it landed in. */
function ElementMenuItems({ frame, selector, hit, onExport }: ElementItemsProps) {
  const hidden = selector ? isElementHidden(frame.html, selector) : null
  const exists = hidden !== null
  const locked = !!frame.locked || (selector ? isElementLocked(frame.html, selector) : false)
  const t = useT()
  const state = useStore.getState()
  const component = selector ? componentContextOf(frame.html, selector, state.canvas?.components ?? []) : null
  const { scale } = useExportSettings()
  /* a copied standalone shape is a frame on the clipboard: its paste lands
     a second element on the canvas, as ⌘V does, not a layer in this frame */
  const frameClip = hasFrameClip()
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  /* the multi-pick the right-click landed in, else the clicked layer alone */
  const picked = state.selectedElement?.frameId === frame.id ? pickedSelectors(state) : []
  const selectors = selector && picked.includes(selector) ? picked : selector ? [selector] : []
  /* the Hide / Lock labels say what the toggle does to the whole pick; one
     layer reuses what was read above, so a menu parses its frame no more */
  const others = selectors.filter((s) => s !== selector)
  const allPickedHidden = !!hidden && others.every((s) => isElementHidden(frame.html, s))
  const ownLock = selector ? isElementLocked(frame.html, selector, true) : false
  const allPickedLocked = ownLock && others.every((s) => isElementLocked(frame.html, s, true))
  /* a standalone shape is its frame: it moves between pages, stacks on the
     page and is selected with the other shapes the selection holds, so with
     others selected the clipboard takes them all, as ⌘C and ⌘X do */
  const standalone = !!selector && standaloneSelector(frame) === selector
  const group = state.selectedIds.includes(frame.id) ? state.selectedIds : [frame.id]
  const shapeFrames = standalone ? (state.canvas?.frames.filter((f) => group.includes(f.id)) ?? [frame]) : []
  const asFrames = shapeFrames.length > 1
  return (
    <>
      <ContextMenuItem
        disabled={!exists}
        onSelect={() => {
          if (asFrames) writeCanvasClipboard(() => copyFrames(shapeFrames))
          else if (selectors.length) writeCanvasClipboard(() => copyPicked(frame, selectors))
        }}
      >
        {t('common.copy')}
        <MenuHint>{MOD_KEY}C</MenuHint>
      </ContextMenuItem>
      {!readOnly && (
        <ContextMenuItem
          disabled={!exists || locked}
          onSelect={() => {
            if (asFrames) cutFrames(shapeFrames)
            else if (selectors.length) cutLayers(frame, selectors)
          }}
        >
          {t('common.cut')}
          <MenuHint>{MOD_KEY}X</MenuHint>
        </ContextMenuItem>
      )}
      {selector && exists && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>{t('stage.copyPasteAs')}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => void copyElementLink(frame, { selector, ...hit })}>
              {t('stage.copyLinkToElement')}
              <ActionHint id="copy-link" />
            </ContextMenuItem>
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
            <ContextMenuItem
              onSelect={() => {
                trackPngCopy('element', 'element_menu')
                void copyElementPng(frame, elementExportTarget(frame, selector), scale)
              }}
            >
              {t('stage.copyAsPng')}
              <ActionHint id="copy-as-png" />
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ActionMenuItem id="copy-properties" />
            <ActionMenuItem id="paste-properties" disabled={locked} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {!readOnly && (
        <>
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
              <ActionMenuItem id="paste-replace" disabled={locked} />
              <ActionMenuItem id="duplicate" disabled={locked} />
            </>
          )}
        </>
      )}
      {selector && exists && !readOnly && (
        <>
          <ContextMenuSeparator />
          <ActionMenuItem id="group" disabled={locked} />
          <ActionMenuItem id="ungroup" disabled={locked} />
          {!standalone && <ActionMenuItem id="auto-layout" disabled={locked} />}
          {!component && !standalone && (
            <ActionMenuItem id="create-component" label={t('components.create')} disabled={locked} />
          )}
          {component && !isDeleted(component.def) && (
            <ContextMenuItem onSelect={() => goToMain(component.def)}>
              {t('components.goToMainComponent')}
            </ContextMenuItem>
          )}
          {component && isDeleted(component.def) && (
            <ContextMenuItem onSelect={() => void restoreDeletedComponent(component.def)}>
              {t('components.restoreComponent')}
            </ContextMenuItem>
          )}
          {component?.kind === 'instance' && (
            <>
              {component.part && component.overriddenParts.includes(component.part) && (
                <ContextMenuItem
                  disabled={locked}
                  onSelect={() =>
                    void changeInstance(frame, { instanceId: component.instanceId, reset: [component.part!] })
                  }
                >
                  {t('components.resetElement')}
                </ContextMenuItem>
              )}
              <ContextMenuItem
                disabled={locked || isDeleted(component.def)}
                onSelect={() => void changeInstance(frame, { instanceId: component.instanceId, reset: true })}
              >
                {t('components.resetOverrides')}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={locked}
                onSelect={() => void changeInstance(frame, { instanceId: component.instanceId, detach: true })}
              >
                {t('components.detachInstance')}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          {standalone && <MoveToPageMenu frames={shapeFrames} />}
          <ActionMenuItem id="bring-to-front" disabled={locked} />
          <ActionMenuItem id="bring-forward" disabled={locked} />
          <ActionMenuItem id="send-backward" disabled={locked} />
          <ActionMenuItem id="send-to-back" disabled={locked} />
          <ContextMenuSeparator />
          <ActionMenuItem id="flip-horizontal" disabled={locked} />
          <ActionMenuItem id="flip-vertical" disabled={locked} />
          <ContextMenuSeparator />
          {standalone ? (
            <ShapeVisibilityItems frames={shapeFrames} />
          ) : (
            <>
              {/* the label says what the toggle does to the whole pick: it
                  shows (unlocks) only once every picked layer is hidden (locked) */}
              <ActionMenuItem
                id="toggle-hidden"
                label={allPickedHidden ? t('stage.show') : t('stage.hide')}
                disabled={!!frame.locked}
              />
              <ActionMenuItem
                id="toggle-locked"
                label={allPickedLocked ? t('stage.unlock') : t('stage.lock')}
                disabled={!!frame.locked}
              />
            </>
          )}
        </>
      )}
      {selector && exists && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onExport(elementExportTarget(frame, selector))}>
            {t('stage.exportEllipsis')}
          </ContextMenuItem>
        </>
      )}
      {selector && exists && !readOnly && (
        <>
          <ContextMenuSeparator />
          <ActionMenuItem id="delete" label={t('stage.deleteElement')} tone="danger" disabled={locked} />
        </>
      )}
      {/* an element a script made is not in the saved HTML, but one wearing
          an id in the live document can still be linked */}
      {selector && !exists && hit?.elementId && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void copyElementLink(frame, { selector, ...hit })}>
            {t('stage.copyLinkToElement')}
          </ContextMenuItem>
        </>
      )}
    </>
  )
}

/** Hide and Lock for shapes on the canvas, as their Layers rows' eye and lock
 *  work: a shape is hidden (locked) by its frame or its own attribute, the
 *  menu shows (unlocks) once every shape is, clearing both, and otherwise
 *  hides (locks) the frames. A locked shape can be unlocked from here. */
function ShapeVisibilityItems({ frames }: { frames: Frame[] }) {
  const t = useT()
  const own = (frame: Frame, read: (html: string, selector: string) => boolean | null) => {
    const selector = standaloneSelector(frame)
    return !!selector && !!read(frame.html, selector)
  }
  const ownHidden = (f: Frame) => own(f, isElementHidden)
  const ownLocked = (f: Frame) => own(f, (html, s) => isElementLocked(html, s, true))
  const allHidden = frames.every((f) => f.hidden || ownHidden(f))
  const allLocked = frames.every((f) => f.locked || ownLocked(f))
  return (
    <>
      <ContextMenuItem
        disabled={frames.some((f) => f.locked)}
        onSelect={() => {
          if (!allHidden) return setFramesHidden(frames, true)
          for (const f of frames) {
            const selector = standaloneSelector(f)
            if (selector && ownHidden(f)) setLayerHidden(f, selector, false)
          }
          setFramesHidden(
            frames.filter((f) => f.hidden),
            false,
          )
        }}
      >
        {allHidden ? t('stage.show') : t('stage.hide')}
        <ActionHint id="toggle-hidden" />
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          if (!allLocked) return setFramesLocked(frames, true)
          for (const f of frames) {
            const selector = standaloneSelector(f)
            if (selector && ownLocked(f)) setLayerLocked(f, selector, false)
          }
          setFramesLocked(
            frames.filter((f) => f.locked),
            false,
          )
        }}
      >
        {allLocked ? t('stage.unlock') : t('stage.lock')}
        <ActionHint id="toggle-locked" />
      </ContextMenuItem>
    </>
  )
}
