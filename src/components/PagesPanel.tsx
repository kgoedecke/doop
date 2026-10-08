import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { nanoid } from 'nanoid'
import { canvasPages } from '../../shared/pages'
import type { CanvasPageInfo } from '../../shared/types'
import { useStore } from '../lib/store'
import { savePages, moveFramesToPage } from '../lib/pageEdits'
import { ApiError } from '../lib/api'
import { Button } from './ui/button'
import { PlusIcon } from './ui/icons'
import { cn } from '../lib/utils'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from './ui/context-menu'

export function PagesPanel({ fill = false }: { fill?: boolean }) {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const selectedIds = useStore((s) => s.selectedIds)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [drag, setDrag] = useState<{ id: string; targetId: string | null; after: boolean } | null>(null)
  const didDrag = useRef(false)
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])
  if (!canvas) return null
  const pages = canvasPages(canvas)

  async function save(next: CanvasPageInfo[], selectId?: string) {
    if (!canvas || busy) return
    setBusy(true)
    try {
      await savePages(canvas, next, selectId)
      if (useStore.getState().canvas?.id !== canvas.id) return
      setRenaming(null)
    } catch (error) {
      if (useStore.getState().canvas?.id !== canvas.id) return
      useStore
        .getState()
        .pushNotice(
          error instanceof ApiError && typeof error.body.error === 'string' ? error.body.error : 'Could not save pages',
        )
    } finally {
      setBusy(false)
    }
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
        const next = pages.filter((page) => page.id !== id)
        const position = next.findIndex((page) => page.id === drop!.targetId) + (drop.after ? 1 : 0)
        const page = pages.find((page) => page.id === id)
        if (page && position >= 0) {
          next.splice(position, 0, page)
          void save(next)
        }
      },
      { signal: controller.signal },
    )
    window.addEventListener('pointercancel', cleanup, { signal: controller.signal })
  }

  async function moveSelection(pageId: string) {
    if (!canvas || busy) return
    setBusy(true)
    try {
      await moveFramesToPage(canvas, selectedIds, pageId)
    } catch {
      if (useStore.getState().canvas?.id !== canvas.id) return
      useStore.getState().pushNotice('Could not move all selected frames. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn('overflow-y-auto px-3 py-2', fill ? 'min-h-0 flex-1' : 'max-h-[35vh] border-b border-line-soft')}
    >
      <div className="flex items-center justify-between py-1 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        <span data-slot="page-section-heading">Pages</span>
        <Button
          variant="bare"
          size="icon-sm"
          className="size-5 rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink"
          aria-label="Add page"
          disabled={busy}
          onClick={() => {
            const page = { id: nanoid(10), name: `Page ${pages.length + 1}` }
            void save([...pages, page], page.id)
          }}
        >
          <PlusIcon width={12} height={12} />
        </Button>
      </div>
      {pages.map((page) => (
        <ContextMenu key={page.id}>
          <ContextMenuTrigger asChild>
            <div
              data-page-id={page.id}
              onContextMenu={() => useStore.getState().setActivePage(page.id)}
              className={cn(
                'group relative flex h-[26px] items-center gap-1 rounded-md text-[12.5px] text-ink hover:bg-paper-deep',
                page.id === activePageId && 'bg-brand text-white hover:bg-brand',
                drag?.id === page.id && 'opacity-40',
              )}
            >
              {drag?.targetId === page.id && (
                <div
                  className={`pointer-events-none absolute inset-x-0 h-0.5 bg-brand ${drag.after ? 'bottom-0' : 'top-0'}`}
                />
              )}
              {renaming === page.id ? (
                <form
                  className="min-w-0 flex-1"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (name.trim()) void save(pages.map((p) => (p.id === page.id ? { ...p, name: name.trim() } : p)))
                  }}
                >
                  <input
                    autoFocus
                    aria-label="Page name"
                    maxLength={100}
                    disabled={busy}
                    onFocus={(e) => e.target.select()}
                    className="w-full rounded border border-line bg-paper px-2 py-1 text-xs"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                </form>
              ) : (
                <button
                  className={`min-w-0 flex-1 touch-none select-none truncate px-2 py-1.5 text-left text-[12.5px] ${drag ? 'cursor-grabbing' : 'cursor-grab'} ${page.id === activePageId ? 'font-semibold' : ''}`}
                  aria-current={page.id === activePageId ? 'page' : undefined}
                  onPointerDown={(e) => {
                    didDrag.current = false
                    startDrag(e, page.id)
                  }}
                  onClick={(e) => {
                    if (didDrag.current) {
                      e.preventDefault()
                      return
                    }
                    useStore.getState().setActivePage(page.id)
                  }}
                  onDoubleClick={() => {
                    if (busy || didDrag.current) return
                    setRenaming(page.id)
                    setName(page.name)
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
            <ContextMenuItem
              disabled={busy}
              onSelect={() => {
                setRenaming(page.id)
                setName(page.name)
              }}
            >
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              tone="danger"
              disabled={busy || pages.length === 1}
              onSelect={() => void save(pages.filter((p) => p.id !== page.id))}
            >
              Delete page
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      {selectedIds.length > 0 && pages.length > 1 && (
        <select
          aria-label="Move selected frames to page"
          className="mt-2 w-full rounded border border-line bg-paper p-1 text-xs"
          value=""
          disabled={busy}
          onChange={(e) => void moveSelection(e.target.value)}
        >
          <option value="" disabled>
            Move selection to page…
          </option>
          {pages
            .filter((p) => p.id !== activePageId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      )}
    </div>
  )
}
