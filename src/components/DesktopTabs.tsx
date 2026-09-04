import { useEffect } from 'react'
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
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  ensureTab,
  hasInsetTrafficLights,
  isDesktopShell,
  openCanvasTab,
  openExternal,
  useTabs,
} from '../lib/desktop'
import type { CanvasTab } from '../lib/desktop'

/**
 * Figma-style tab strip, desktop shell only. It sits where the title bar
 * would be (the shell's title bar is an overlay: just the traffic lights,
 * floating over this strip) — so the strip doubles as the window's drag
 * handle via data-tauri-drag-region, which Tauri only honours on the exact
 * element carrying the attribute, leaving the tabs themselves clickable.
 */
export function DesktopTabs({ path }: { path: string }) {
  const tabs = useTabs((s) => s.tabs)
  const activeId = path.match(/^\/c\/([^/]+)/)?.[1] ?? null

  /* deep links and back/forward can land on a canvas the strip never opened */
  useEffect(() => {
    if (activeId) ensureTab(activeId)
  }, [activeId])

  if (!isDesktopShell()) return null

  async function newCanvas() {
    const canvas = await api.createCanvas('Untitled canvas')
    posthog.capture('canvas_created')
    openCanvasTab(canvas.id, canvas.name)
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
        title="All canvases"
      >
        <Logo className="size-[18px]" />
      </button>
      <div
        role="tablist"
        aria-label="Open canvases"
        className="flex min-w-0 items-end overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const on = tab.id === activeId
          return (
            <ContextMenu key={tab.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="tab"
                  aria-selected={on}
                  tabIndex={0}
                  className={cn(
                    'group relative -mb-px flex h-[36px] min-w-[110px] max-w-[210px] flex-1 basis-[210px] cursor-default items-center gap-1 rounded-t-[9px] border border-b-0 border-transparent pb-[2px] pl-3 pr-1.5 text-[12.5px] text-ink-soft',
                    on ? 'border-line bg-surface text-ink' : 'transition-colors hover:bg-ink/[0.04]',
                  )}
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
                    title="Close tab"
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
        title="New canvas"
      >
        +
      </button>
    </div>
  )
}

/** Right-click menu on a tab: the browser-tab basics (Figma has the same
 *  set). Its content is portalled to the body, so it needs to clear the
 *  strip's own z-index to overlap it. */
function TabContextMenu({ tab, path }: { tab: CanvasTab; path: string }) {
  const url = `${location.origin}/c/${tab.id}`
  const on = path === `/c/${tab.id}`
  return (
    <ContextMenuContent className="z-[850]">
      <ContextMenuItem onSelect={() => navigator.clipboard.writeText(url)}>Copy link</ContextMenuItem>
      {/* a full load of that canvas: the tab's own page when it's current,
          otherwise a hard navigation there (tabs are in-page routes, so
          there is nothing else to refresh) */}
      <ContextMenuItem onSelect={() => (on ? location.reload() : location.assign(url))}>Reload</ContextMenuItem>
      {/* the shell's opener IPC hands the URL to the system browser; without
          it (a plain browser, or a pre-0.1.2 shell) a new tab is the closest thing */}
      <ContextMenuItem onSelect={() => openExternal(url) || window.open(url, '_blank', 'noopener')}>
        Open in browser
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => closeTab(tab.id, path)}>Close</ContextMenuItem>
      <ContextMenuItem onSelect={() => closeOtherTabs(tab.id, path)}>Close other tabs</ContextMenuItem>
      <ContextMenuItem onSelect={closeAllTabs}>Close all tabs</ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Invisible drag handle for shell screens without the tab strip (signed
 *  out): the overlay title bar has no native drag area of its own. */
export function ShellDragBar() {
  if (!isDesktopShell()) return null
  return <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-[950] h-6" />
}
