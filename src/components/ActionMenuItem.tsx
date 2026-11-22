import type { ReactNode } from 'react'
import type { Frame } from '../../shared/types'
import { canvasPages, framePageId } from '../../shared/pages'
import { chordHint, firstChord } from '../lib/actions/chords'
import { actionById, isEnabled, runAction } from '../lib/actions/registry'
import { useT } from '../lib/i18n'
import { moveFramesToPage } from '../lib/pageEdits'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from './ui/context-menu'
import { MenuHint } from './ui/menu'

/** The chord a registry command is bound to, as a menu row's trailing hint. */
export function ActionHint({ id }: { id: string }) {
  const chord = firstChord(actionById(id).keys)
  return chord ? <MenuHint>{chordHint(chord)}</MenuHint> : null
}

/** A context-menu row that runs a registry command on the selection: its
 *  name, chord and enabled state come from the registry, so the menu, the
 *  keyboard and the main menu cannot drift apart. The right-click picked the
 *  layer or frame first, so the selection is what was clicked. */
export function ActionMenuItem({
  id,
  label,
  disabled,
  tone,
}: {
  id: string
  label?: ReactNode
  /** greyed for a reason the registry cannot see (a locked layer) */
  disabled?: boolean
  tone?: 'danger'
}) {
  const t = useT()
  const action = actionById(id)
  return (
    <ContextMenuItem tone={tone} disabled={disabled || !isEnabled(action)} onSelect={() => runAction(action)}>
      {label ?? t(action.label)}
      <ActionHint id={id} />
    </ContextMenuItem>
  )
}

/** "Move to page ▸": every other page of the canvas, as Figma lists them.
 *  Locked frames stay where they are; nothing shows on a one-page canvas or
 *  for a reader. */
export function MoveToPageMenu({ frames }: { frames: readonly Frame[] }) {
  const t = useT()
  const canvas = useStore((s) => s.canvas)
  const editable = useStore((s) => canEditOpenCanvas(s))
  if (!canvas || !editable) return null
  const movable = frames.filter((f) => !f.locked)
  const here = new Set(frames.map((f) => framePageId(canvas, f)))
  const pages = canvasPages(canvas).filter((page) => !(here.size === 1 && here.has(page.id)))
  if (canvasPages(canvas).length < 2 || !pages.length) return null
  const move = (pageId: string) => {
    moveFramesToPage(
      canvas,
      movable.map((f) => f.id),
      pageId,
    ).catch(() => {
      if (useStore.getState().canvas?.id === canvas.id) useStore.getState().pushNotice(t('panels.pagesMoveFailed'))
    })
  }
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={!movable.length}>{t('stage.moveToPage')}</ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {pages.map((page) => (
          <ContextMenuItem key={page.id} onSelect={() => move(page.id)}>
            <span className="min-w-0 flex-1 truncate">{page.name}</span>
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
