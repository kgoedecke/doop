import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { nanoid } from 'nanoid'
import { canvasPages } from '../../shared/pages'
import type { CanvasPageInfo } from '../../shared/types'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { savePages, duplicatePage, moveFramesToPage } from '../lib/pageEdits'
import { ApiError } from '../lib/api'
import { Button } from './ui/button'
import { PageIcon, PlusIcon } from './ui/icons'
import { cn } from '../lib/utils'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from './ui/context-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { useT } from '@/lib/i18n'

/** The small grey sub-heading over a section of the Layers panel, shared with
 *  its "Layers" row: the two must read as one family (a browser test checks
 *  their typography). */
export const sectionHeading = 'text-[11px] font-normal text-ink-faint'
const sectionBtn = 'size-5 rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink'

export function PagesPanel({ fill = false }: { fill?: boolean }) {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const selectedIds = useStore((s) => s.selectedIds)
  /* view and comment links switch pages; they add, rename and move none */
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  /* set once Enter, Esc or a blur has settled the rename, so the blur that
     follows (the field unmounting, or being disabled while it saves) does
     not settle it a second time */
  const renameSettled = useRef(false)
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const [drag, setDrag] = useState<{ id: string; targetId: string | null; after: boolean } | null>(null)
  const didDrag = useRef(false)
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])
  const t = useT()
  if (!canvas) return null
  const pages = canvasPages(canvas)
  const movableIds = canvas.frames.filter((f) => selectedIds.includes(f.id) && !f.locked).map((f) => f.id)

  async function moveSelection(pageId: string) {
    if (!canvas || busy || !movableIds.length) return
    setBusy(true)
    try {
      await moveFramesToPage(canvas, movableIds, pageId)
    } catch {
      if (useStore.getState().canvas?.id === canvas.id) useStore.getState().pushNotice(t('panels.pagesMoveFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** Page-list edits run one after another, each built from the pages as the
   *  previous one left them: a rename committed by the press that starts a
   *  drag must not race the reorder that drag drops. Resolves to whether the
   *  edit saved. */
  function save(edit: (pages: CanvasPageInfo[]) => CanvasPageInfo[] | null, selectId?: string) {
    const canvasId = canvas?.id
    const task = saveQueue.current.then(async () => {
      const current = useStore.getState().canvas
      if (!current || current.id !== canvasId) return false
      const next = edit(canvasPages(current))
      if (!next) return false
      setBusy(true)
      try {
        await savePages(current, next, selectId)
        return true
      } catch (error) {
        if (useStore.getState().canvas?.id === canvasId) {
          useStore
            .getState()
            .pushNotice(
              error instanceof ApiError && typeof error.body.error === 'string'
                ? error.body.error
                : t('panels.pagesSaveFailed'),
            )
        }
        return false
      } finally {
        setBusy(false)
      }
    })
    saveQueue.current = task.then(() => undefined)
    return task
  }

  function startRename(page: CanvasPageInfo) {
    renameSettled.current = false
    setRenaming(page.id)
    setName(page.name)
  }

  /** Enter or a click elsewhere keeps the typed name, as in Figma; an empty or
   *  unchanged one just closes the field. A failed save leaves it open. */
  async function commitRename(page: CanvasPageInfo) {
    if (renameSettled.current) return
    renameSettled.current = true
    const next = name.trim()
    if (!next || next === page.name) return setRenaming(null)
    const saved = await save((current) => current.map((p) => (p.id === page.id ? { ...p, name: next } : p)))
    if (saved) setRenaming(null)
    else renameSettled.current = false
  }

  function startDrag(e: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (busy || e.button !== 0 || e.detail > 1) return
    stopDrag.current?.()
    const startY = e.clientY
    const startX = e.clientX
    const pointerId = e.pointerId
    const controller = new AbortController()
    let moving = false
    let drop: { targetId: string; after: boolean } | null = null
    const cleanup = () => {
      controller.abort()
      stopDrag.current = null
      setDrag(null)
    }
    stopDrag.current = cleanup
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      if (!moving && Math.abs(event.clientY - startY) + Math.abs(event.clientX - startX) < 4) return
      moving = true
      didDrag.current = true
      event.preventDefault()
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-page-id]')
      const targetId = row?.dataset.pageId
      if (targetId && row && targetId !== id) {
        const box = row.getBoundingClientRect()
        drop = { targetId, after: event.clientY >= box.y + box.height / 2 }
      } else drop = null
      setDrag({ id, targetId: drop?.targetId ?? null, after: drop?.after ?? false })
    }
    window.addEventListener('pointermove', move, { signal: controller.signal, passive: false })
    window.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerId !== pointerId) return
        cleanup()
        if (!moving || !drop) return
        const { targetId, after } = drop
        void save((current) => {
          const page = current.find((p) => p.id === id)
          const next = current.filter((p) => p.id !== id)
          const target = next.findIndex((p) => p.id === targetId)
          if (!page || target < 0) return null
          next.splice(target + (after ? 1 : 0), 0, page)
          return next
        })
      },
      { signal: controller.signal },
    )
    window.addEventListener('pointercancel', cleanup, { signal: controller.signal })
  }

  function duplicate(pageId: string) {
    const canvasId = canvas?.id
    const task = saveQueue.current.then(async () => {
      const current = useStore.getState().canvas
      if (!current || current.id !== canvasId) return
      setBusy(true)
      try {
        await duplicatePage(current, pageId)
      } catch (error) {
        if (useStore.getState().canvas?.id !== canvasId) return
        useStore
          .getState()
          .pushNotice(
            error instanceof ApiError && typeof error.body.error === 'string'
              ? error.body.error
              : t('panels.pagesDuplicateFailed'),
          )
      } finally {
        setBusy(false)
      }
    })
    saveQueue.current = task
    return task
  }

  const addPage = (
    <Button
      variant="bare"
      size="icon-sm"
      className={sectionBtn}
      aria-label={t('panels.pagesAdd')}
      disabled={busy}
      onClick={() => {
        const id = nanoid(10)
        void save((current) => [...current, { id, name: `Page ${current.length + 1}` }], id)
      }}
    >
      <PlusIcon className="size-3.5" />
    </Button>
  )

  const list = (
    <>
      {pages.map((page) => (
        <ContextMenu key={page.id}>
          <ContextMenuTrigger asChild disabled={readOnly}>
            <div
              data-page-id={page.id}
              onContextMenu={() => useStore.getState().setActivePage(page.id)}
              className={cn(
                'group relative flex h-[27px] items-center gap-1 rounded-[7px] pr-2.5 text-[12px] text-ink-soft hover:bg-sub',
                page.id === activePageId && 'bg-paper-deep text-ink hover:bg-paper-deep',
                drag?.id === page.id && 'opacity-40',
              )}
            >
              {drag?.targetId === page.id && (
                <div
                  className={`pointer-events-none absolute inset-x-0 h-0.5 bg-brand ${drag.after ? 'bottom-0' : 'top-0'}`}
                />
              )}
              <span
                className={cn(
                  'grid size-4 flex-none place-items-center pl-2.5 pr-0 box-content text-ink-faint',
                  page.id === activePageId && 'text-ink',
                )}
              >
                <PageIcon className="size-3.5" />
              </span>
              {renaming === page.id ? (
                <form
                  className="min-w-0 flex-1"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void commitRename(page)
                  }}
                >
                  <input
                    autoFocus
                    aria-label={t('panels.pagesName')}
                    maxLength={100}
                    disabled={busy}
                    onFocus={(e) => e.target.select()}
                    className="w-full rounded-[6px] bg-surface px-2 py-1 text-[12px] text-ink shadow-elevation-1-focus outline-none"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => void commitRename(page)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape') return
                      renameSettled.current = true
                      setRenaming(null)
                    }}
                  />
                </form>
              ) : (
                <button
                  className={`min-w-0 flex-1 touch-none select-none truncate py-1.5 pl-0.5 text-left text-[12px] ${drag ? 'cursor-grabbing' : 'cursor-grab'} ${page.id === activePageId ? 'font-medium' : ''}`}
                  aria-current={page.id === activePageId ? 'page' : undefined}
                  onPointerDown={(e) => {
                    didDrag.current = false
                    if (!readOnly) startDrag(e, page.id)
                  }}
                  onClick={(e) => {
                    if (didDrag.current) {
                      e.preventDefault()
                      return
                    }
                    useStore.getState().setActivePage(page.id)
                  }}
                  onDoubleClick={() => {
                    if (busy || readOnly || didDrag.current) return
                    startRename(page)
                  }}
                >
                  {page.name}
                </button>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent
            onCloseAutoFocus={(e) => {
              if (renaming === page.id) e.preventDefault()
            }}
          >
            <ContextMenuItem disabled={busy} onSelect={() => startRename(page)}>
              {t('panels.pagesRename')}
            </ContextMenuItem>
            <ContextMenuItem disabled={busy || pages.length >= 100} onSelect={() => void duplicate(page.id)}>
              {t('panels.pagesDuplicate')}
            </ContextMenuItem>
            <ContextMenuItem
              tone="danger"
              disabled={busy || pages.length === 1}
              onSelect={() =>
                void save((current) => (current.length > 1 ? current.filter((p) => p.id !== page.id) : null))
              }
            >
              {t('panels.pagesDelete')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </>
  )

  return (
    <div className={cn('flex flex-none flex-col', fill && 'min-h-0 flex-1')}>
      <div className={cn('mt-1.5 flex h-6 flex-none items-center justify-between pr-2.5 pl-3.5', sectionHeading)}>
        <span data-slot="page-section-heading" className={sectionHeading}>
          {t('panels.pagesTitle')}
        </span>
        {!readOnly && addPage}
      </div>
      <div className={cn('overflow-y-auto px-2 pb-1', fill ? 'min-h-0 flex-1' : 'max-h-[30vh]')}>{list}</div>
      {!readOnly && selectedIds.length > 0 && pages.length > 1 && (
        /* the canvas shortcuts listen on window: ⌫ would delete the frames
           being moved and typed letters would switch tools, so the picker's
           keys stop here; React bubbles the portalled list's keys through this
           div too, before the native event reaches window */
        <div className="px-2 pb-2" onKeyDown={(e) => e.stopPropagation()}>
          <Select value="" disabled={busy || !movableIds.length} onValueChange={(id) => void moveSelection(id)}>
            <SelectTrigger size="sm" className="w-full" aria-label={t('panels.pagesMoveSelection')}>
              <SelectValue placeholder={t('panels.pagesMoveSelectionPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {pages
                .filter((page) => page.id !== activePageId)
                .map((page) => (
                  <SelectItem key={page.id} value={page.id}>
                    {page.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
