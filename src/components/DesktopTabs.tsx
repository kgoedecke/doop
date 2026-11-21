import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { api } from '../lib/api'
import { posthog } from '../lib/posthog'
import { navigate } from '../App'
import { Logo } from './Logo'
import { XIcon } from './ui/icons'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { cn } from '@/lib/utils'
import {
  TAB_SHORTCUTS,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  ensureTab,
  moveTab,
  openCanvasTab,
  openExternal,
  useTabs,
} from '../lib/desktop'
import { chordHint } from '../lib/actions/chords'
import { hasInsetTrafficLights, isDesktopShell } from '../lib/shell'
import { useWindowFrame } from '../lib/windowFrame'
import { WindowControls } from './WindowControls'
import type { CanvasTab } from '../lib/desktop'
import { useT } from '../lib/i18n'

/**
 * Figma-style tab strip, desktop shell only. It sits where the title bar
 * would be (the shell's title bar is an overlay: just the traffic lights,
 * floating over this strip) — so the strip doubles as the window's drag
 * handle via data-tauri-drag-region, which Tauri only honours on the exact
 * element carrying the attribute, leaving the tabs themselves clickable.
 * On Windows the page replaces the native frame too (src/lib/windowFrame.ts)
 * and the strip ends in the caption buttons.
 */
export function DesktopTabs({ path }: { path: string }) {
  const t = useT()
  const tabs = useTabs((s) => s.tabs)
  const activeId = path.match(/^\/c\/([^/]+)/)?.[1] ?? null
  const listRef = useRef<HTMLDivElement>(null)
  const cancelDrag = useRef<(() => void) | null>(null)

  /* deep links and back/forward can land on a canvas the strip never opened */
  useEffect(() => {
    if (activeId) ensureTab(activeId)
  }, [activeId])

  /* an unmount mid-drag drops the document listeners the gesture added */
  useEffect(() => () => cancelDrag.current?.(), [])

  if (!isDesktopShell()) return null

  async function newCanvas() {
    const canvas = await api.createCanvas('Untitled canvas')
    posthog.capture('canvas_created')
    openCanvasTab(canvas.id, canvas.name)
  }

  /* Reordering is a pointer gesture, not HTML5 drag-and-drop: the shell's
     webview drag-drop handler swallows those events on Linux and Windows.
     The DOM never reorders mid-gesture — siblings slide by transform to
     open the gap and the drop commits moveTab — so a cancel has nothing
     to undo. Listeners live on the document because the drag only starts
     (and captures the pointer) after a 4px move, by which point the
     pointer may already be off the tab. */
  function onTabPointerDown(e: ReactPointerEvent<HTMLDivElement>, tab: CanvasTab, index: number) {
    /* only the primary button drags: middle click stays Close, right click
       stays the context menu, and a touch keeps scrolling the strip */
    if (e.button !== 0 || e.pointerType === 'touch') return
    /* the close button is the tab's only button — a press there is its own gesture */
    if ((e.target as Element).closest('button')) return
    if (!listRef.current) return
    const list = listRef.current
    cancelDrag.current?.()
    const el = e.currentTarget
    const d = {
      id: tab.id,
      from: index,
      target: index,
      startX: e.clientX,
      x: e.clientX,
      startScroll: 0,
      pointerId: e.pointerId,
      width: 0,
      min: 0,
      max: 0,
      mids: [] as number[],
      dragging: false,
    }
    /* Drop geometry is worked in content coordinates (clientX + scrollLeft)
       so a strip scroll mid-drag shifts nothing: the midpoints and the
       clamp bounds were frozen at drag start and stay valid */
    function place(clientX: number) {
      const cx = clientX + list.scrollLeft
      const dx = Math.min(Math.max(cx - (d.startX + d.startScroll), d.min), d.max)
      el.style.transform = `translateX(${dx}px)`
      /* the drop slot counts the sibling midpoints the pointer has passed */
      d.target = d.mids.filter((m) => cx > m).length
      for (const [i, child] of Array.from(list.children).entries()) {
        if (i === d.from) continue
        const shift =
          d.target > d.from && i > d.from && i <= d.target
            ? -d.width
            : d.target < d.from && i >= d.target && i < d.from
              ? d.width
              : 0
        ;(child as HTMLElement).style.transform = shift ? `translateX(${shift}px)` : ''
      }
    }
    function scrolled() {
      place(d.x)
    }
    function move(ev: PointerEvent) {
      d.x = ev.clientX
      if (!d.dragging) {
        /* inside the threshold the gesture is still a candidate click */
        if (Math.abs(ev.clientX - d.startX) < 4) return
        el.setPointerCapture(ev.pointerId)
        const rect = el.getBoundingClientRect()
        const rects = Array.from(list.children, (c) => c.getBoundingClientRect())
        const first = rects[0]
        const last = rects[rects.length - 1]
        if (!first || !last) return
        d.startScroll = list.scrollLeft
        d.width = rect.width
        d.min = first.left - rect.left
        d.max = last.right - rect.right
        d.mids = rects.filter((_, i) => i !== d.from).map((r) => r.left + r.width / 2 + d.startScroll)
        d.dragging = true
        el.style.zIndex = '1'
        for (const [i, child] of Array.from(list.children).entries())
          if (i !== d.from) (child as HTMLElement).style.transition = 'transform 150ms ease-out'
        list.addEventListener('scroll', scrolled)
      }
      place(d.x)
    }
    function finish(commit: boolean) {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', cancel)
      document.removeEventListener('keydown', key, true)
      list.removeEventListener('scroll', scrolled)
      unsub()
      cancelDrag.current = null
      for (const child of Array.from(list.children) as HTMLElement[]) {
        child.style.transition = ''
        child.style.transform = ''
        child.style.zIndex = ''
      }
      if (!d.dragging) return
      if (el.hasPointerCapture(d.pointerId)) el.releasePointerCapture(d.pointerId)
      if (commit) moveTab(d.id, d.target)
      /* the click that lands after a drop — or after a cancelled drag's
         release — must not navigate; it can be over a different tab by
         then. A committed drop's click shares its pointerup's task; a
         cancelled one arrives with the press's own later release, and if
         that release produced no click (outside the window) the next press
         or release retires the eater rather than letting it swallow a
         real click */
      const eat = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
      }
      const disarm = () => {
        /* the pointerup's click companion is dispatched in the same task,
           ahead of this timer, so the eater still sees it */
        setTimeout(() => document.removeEventListener('click', eat, true), 0)
      }
      const disarmNow = () => document.removeEventListener('click', eat, true)
      document.addEventListener('click', eat, { capture: true, once: true })
      document.addEventListener('pointerup', disarm, { capture: true, once: true })
      document.addEventListener('pointerdown', disarmNow, { capture: true, once: true })
    }
    function up() {
      finish(true)
    }
    function cancel() {
      finish(false)
    }
    function key(ev: KeyboardEvent) {
      if (ev.key !== 'Escape') return
      /* a drag's Esc is ours: keep it from the canvas, where it would also
         deselect or stop following. An Esc before the threshold is not ours */
      if (d.dragging) {
        ev.preventDefault()
        ev.stopPropagation()
      }
      finish(false)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('keydown', key, true)
    /* the strip can change under the gesture — ⌘W closes a tab, a deep
       link opens one — and the frozen geometry would land the drop on the
       wrong slot; a rename keeps the same ids and must not cancel */
    const unsub = useTabs.subscribe((s, prev) => {
      if (s.tabs.length !== prev.tabs.length || s.tabs.some((t, i) => t.id !== prev.tabs[i]?.id)) finish(false)
    })
    cancelDrag.current = cancel
  }

  return (
    <div
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-[800] flex h-10 items-end gap-[3px] border-b border-line bg-paper-deep px-2"
    >
      {hasInsetTrafficLights() && <div data-tauri-drag-region className="w-[70px] flex-none" />}
      <button
        className={cn(
          'mb-[4px] grid size-[30px] flex-none place-items-center rounded-lg border-0 bg-transparent text-ink-soft transition-colors hover:bg-ink/[0.06] hover:text-ink',
          !activeId && 'bg-ink/[0.08] text-ink',
        )}
        onClick={() => navigate('/')}
        title={withShortcut(t('canvas.allCanvases'), 0)}
      >
        <Logo className="size-[18px]" />
      </button>
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('canvas.openCanvases')}
        className="flex min-w-0 items-end overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => {
          const on = tab.id === activeId
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="tab"
                  aria-selected={on}
                  tabIndex={0}
                  title={withShortcut(tab.name, index + 1)}
                  className={cn(
                    'group relative -mb-px flex h-[36px] min-w-[110px] max-w-[210px] flex-1 basis-[210px] cursor-default select-none items-center gap-1 rounded-t-[9px] border border-b-0 border-transparent pb-[2px] pl-3 pr-1.5 text-[12.5px] text-ink-soft',
                    on ? 'border-line bg-surface text-ink' : 'transition-colors hover:bg-ink/[0.04]',
                  )}
                  onPointerDown={(e) => onTabPointerDown(e, tab, index)}
                  onClick={() => navigate(`/c/${tab.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/c/${tab.id}`)}
                  onAuxClick={(e) => e.button === 1 && closeTab(tab.id, path)}
                >
                  <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                  <button
                    className={cn(
                      'grid size-[18px] flex-none place-items-center rounded-[5px] border-0 bg-transparent p-0 text-ink-faint opacity-0 transition-opacity hover:bg-ink/[0.08] hover:text-ink group-hover:opacity-100',
                      on && 'opacity-100',
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(tab.id, path)
                    }}
                    title={t('canvas.closeTab')}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              </ContextMenuTrigger>
              <TabContextMenu tab={tab} path={path} />
            </ContextMenu>
          )
        })}
      </div>
      <button
        className="mb-[4px] grid size-[30px] flex-none place-items-center rounded-lg border-0 bg-transparent text-[16px] leading-none text-ink-soft transition-colors hover:bg-ink/[0.06] hover:text-ink"
        onClick={newCanvas}
        title={t('canvas.newCanvas')}
      >
        +
      </button>
      <WindowControls className="-mr-2 ml-auto" />
    </div>
  )
}

/** A tooltip with its ⌘1…⌘9 shortcut, when the slot has one. */
function withShortcut(label: string, slot: number): string {
  const chord = TAB_SHORTCUTS[slot]
  return chord ? `${label} (${chordHint(chord)})` : label
}

/** Right-click menu on a tab: the browser-tab basics (Figma has the same
 *  set). Its content is portalled to the body, so it needs to clear the
 *  strip's own z-index to overlap it. */
function TabContextMenu({ tab, path }: { tab: CanvasTab; path: string }) {
  const t = useT()
  const url = `${location.origin}/c/${tab.id}`
  const on = path === `/c/${tab.id}`
  return (
    <ContextMenuContent className="z-[850]">
      <ContextMenuItem onSelect={() => navigator.clipboard.writeText(url)}>{t('canvas.copyLink')}</ContextMenuItem>
      {/* a full load of that canvas: the tab's own page when it's current,
          otherwise a hard navigation there (tabs are in-page routes, so
          there is nothing else to refresh) */}
      <ContextMenuItem onSelect={() => (on ? location.reload() : location.assign(url))}>
        {t('canvas.reload')}
      </ContextMenuItem>
      {/* the shell's opener IPC hands the URL to the system browser; without
          it (a plain browser, or a pre-0.1.2 shell) a new tab is the closest thing */}
      <ContextMenuItem onSelect={() => openExternal(url) || window.open(url, '_blank', 'noopener')}>
        {t('canvas.openInBrowser')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => closeTab(tab.id, path)}>{t('common.close')}</ContextMenuItem>
      <ContextMenuItem onSelect={() => closeOtherTabs(tab.id, path)}>{t('canvas.closeOtherTabs')}</ContextMenuItem>
      <ContextMenuItem onSelect={closeAllTabs}>{t('canvas.closeAllTabs')}</ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Invisible drag handle for shell screens without the tab strip (signed
 *  out): the overlay title bar has no native drag area of its own. On
 *  Windows, once the page owns the frame, it also carries the caption
 *  buttons — these screens would otherwise have no way to close the window.
 *  A fixed-position screen passed as `children` (the guest canvas, whose
 *  toolbar sits 14px from the top) is moved below that bar through the
 *  --app-inset contract (App.tsx) instead of having its toolbar covered. */
export function ShellDragBar({ children }: { children?: ReactNode }) {
  const customFrame = useWindowFrame((s) => s.custom)
  if (customFrame)
    return (
      <>
        <div
          data-tauri-drag-region
          className={cn(
            'fixed inset-x-0 top-0 z-[950] flex h-8 justify-end',
            children && 'border-b border-line bg-paper-deep',
          )}
        >
          <WindowControls />
        </div>
        {children && <div className="[--app-inset:32px]">{children}</div>}
      </>
    )
  return (
    <>
      {hasInsetTrafficLights() && <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-[950] h-6" />}
      {children}
    </>
  )
}
