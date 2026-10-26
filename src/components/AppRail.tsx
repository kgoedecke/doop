import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import type { CanvasMeta, WorkspaceSummary } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { api } from '../lib/api'
import { authClient } from '../lib/auth'
import { navigate } from '../lib/navigate'
import { useRailDrawer } from '../lib/railDrawer'
import { timeAgo } from '../lib/time'
import { openCanvasTab } from '../lib/desktop'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { AccountMenu } from './DashShell'
import { CanvasSearchModal } from './CanvasSearchModal'
import { ConnectModal } from './ConnectModal'
import { DashNavItem, DashSectionLabel, DashSidebar, DashSidebarBrand } from './ui/dash'
import { Dot } from './ui/dot'
import { IconButton } from './ui/icon-button'
import { Sheet, SheetContent, SheetTitle } from './ui/sheet'
import {
  BlocksIcon,
  BuildingIcon,
  CirclePlusIcon,
  FolderPlusIcon,
  GridIcon,
  LockIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  SearchIcon,
  UserIcon,
  UsersIcon,
  WebIcon,
  WorkflowIcon,
} from './ui/icons'

/**
 * The signed-in shell's rail, as the home design draws it: canvases,
 * workspaces, explore, resources and agents in 12.5px rows, a search palette
 * and a collapse control up top, and the account face at the bottom. Every
 * dashboard page mounts the same one, so the chrome cannot drift between
 * Home, Automations, Integrations, Community, Workspace and Admin. Its rows
 * are the rail density of the dash primitives (ui/dash.tsx), which Settings
 * also draws its own rail from.
 *
 * It owns the search palette, the connect-an-agent modal and its collapsed
 * state (remembered per browser). A page that needs its own group — a
 * workspace's panes, the admin indexes — passes it as children, and it
 * lands after Resources.
 *
 * Below md the same rail slides in as a drawer over the page; the header's
 * brand row (DashBrand) opens it, and any row that leads somewhere closes it.
 */

/** which row is lit: a home scope, a workspace, or one of the other pages */
export type RailActive =
  'all' | 'mine' | 'shared' | 'automations' | 'integrations' | 'community' | `ws:${string}` | null

/** an agent that worked this recently is treated as still at the desk */
const LIVE_WINDOW = 5 * 60 * 1000
const RAIL_STORAGE_KEY = 'doop-rail'

function readRailOpen(): boolean {
  try {
    return localStorage.getItem(RAIL_STORAGE_KEY) !== 'narrow'
  } catch {
    return true
  }
}

export function AppRail({
  active,
  canvases,
  workspaces,
  onScope,
  onCreateWorkspace,
  searchShortcut = true,
  children,
}: {
  active: RailActive
  /** the lists the rail counts and reads agents from; fetched here when a page has none */
  canvases?: CanvasMeta[]
  workspaces?: WorkspaceSummary[]
  /** Home filters in place; any other page goes home with the scope in the URL */
  onScope?: (scope: 'all' | 'mine' | 'shared' | `ws:${string}`) => void
  onCreateWorkspace?: () => void
  /** off on a page whose own search owns ⌘K (the community gallery) */
  searchShortcut?: boolean
  children?: ReactNode
}) {
  const [own, setOwn] = useState<{ canvases: CanvasMeta[]; workspaces: WorkspaceSummary[] } | null>(null)
  const needsOwn = canvases === undefined || workspaces === undefined
  useEffect(() => {
    if (!needsOwn) return
    Promise.all([api.listCanvases(), api.listWorkspaces()])
      .then(([c, w]) => setOwn({ canvases: c, workspaces: w.workspaces }))
      .catch(console.error)
  }, [needsOwn])
  const list = useMemo(() => canvases ?? own?.canvases ?? [], [canvases, own])
  const spaces = workspaces ?? own?.workspaces ?? []

  const [open, setOpen] = useState(readRailOpen)
  const drawer = useRailDrawer((s) => s.open)
  const setDrawer = useRailDrawer((s) => s.setOpen)
  const setMounted = useRailDrawer((s) => s.setMounted)
  /* tells DashHeader a rail is here to open; before paint, so the phone's
     brand row does not pop in a frame after the rest of the header */
  useLayoutEffect(() => {
    setMounted(true)
    return () => setMounted(false)
  }, [setMounted])
  /* widening past md hides the drawer panel but not its backdrop, so the
     drawer closes the moment the desktop rail takes over */
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 56.25rem)')
    function onChange(e: MediaQueryListEvent) {
      if (e.matches) setDrawer(false)
    }
    desktop.addEventListener('change', onChange)
    return () => desktop.removeEventListener('change', onChange)
  }, [setDrawer])
  const [searching, setSearching] = useState(false)
  const [connecting, setConnecting] = useState(false)
  /* a clock the render can read: an agent that just worked shows as live */
  const [now, setNow] = useState(0)
  useEffect(() => {
    const start = window.setTimeout(() => setNow(Date.now()), 0)
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      window.clearTimeout(start)
      window.clearInterval(tick)
    }
  }, [])

  /* ⌘K opens the search palette from anywhere in the shell */
  useEffect(() => {
    if (!searchShortcut) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSearching(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchShortcut])

  function setRail(next: boolean) {
    setOpen(next)
    try {
      localStorage.setItem(RAIL_STORAGE_KEY, next ? 'wide' : 'narrow')
    } catch {
      /* private mode: the choice lives for this page only */
    }
  }

  /* every row that leads somewhere also puts the phone drawer away */
  function go(path: string) {
    setDrawer(false)
    navigate(path)
  }

  function scope(next: 'all' | 'mine' | 'shared' | `ws:${string}`) {
    setDrawer(false)
    if (onScope) onScope(next)
    else navigate(next === 'all' ? '/' : `/?scope=${encodeURIComponent(next)}`)
  }

  function createWorkspace() {
    setDrawer(false)
    if (onCreateWorkspace) onCreateWorkspace()
    else navigate('/?workspace=new')
  }

  function openSearch() {
    setDrawer(false)
    setSearching(true)
  }

  function connect() {
    setDrawer(false)
    setConnecting(true)
  }

  function openCanvas(c: CanvasMeta) {
    if (!openCanvasTab(c.id, c.name)) navigate(`/c/${c.id}`)
  }

  const workspaceCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of list) if (c.workspaceId) map.set(c.workspaceId, (map.get(c.workspaceId) ?? 0) + 1)
    return map
  }, [list])

  /* every agent that has worked on these canvases, aggregated across them */
  const agents = useMemo(() => {
    const map = new Map<string, { name: string; lastAt: number; canvases: number }>()
    for (const c of list) {
      for (const a of c.agents ?? []) {
        const e = map.get(a.name)
        if (e) {
          e.canvases += 1
          e.lastAt = Math.max(e.lastAt, a.lastAt ?? 0)
        } else map.set(a.name, { name: a.name, lastAt: a.lastAt ?? 0, canvases: 1 })
      }
    }
    return [...map.values()].sort((x, y) => y.lastAt - x.lastAt).slice(0, 5)
  }, [list])

  const modals = (
    <>
      {connecting && <ConnectModal onClose={() => setConnecting(false)} />}
      {searching && (
        <CanvasSearchModal
          canvases={list}
          onClose={() => setSearching(false)}
          onOpen={(c) => {
            setSearching(false)
            openCanvas(c)
          }}
        />
      )}
    </>
  )

  const narrow = (
    <div
      key="narrow"
      data-icon-motion
      className="flex min-h-full w-full animate-[fade-in_0.25s_ease] flex-col items-center motion-reduce:animate-none"
    >
      <DashSidebarBrand onHome={() => go('/')} />
      <IconButton aria-label="Show sidebar" onClick={() => setRail(true)}>
        <PanelExpandIcon width={15} height={15} />
      </IconButton>
      <IconButton aria-label="Search canvases (⌘K)" onClick={openSearch}>
        <SearchIcon width={15} height={15} />
      </IconButton>
      <Rule />
      <IconButton aria-label="All canvases" on={active === 'all'} onClick={() => scope('all')}>
        <GridIcon size="rail" />
      </IconButton>
      <IconButton aria-label="Owned by me" on={active === 'mine'} onClick={() => scope('mine')}>
        <UserIcon size="rail" />
      </IconButton>
      <IconButton aria-label="Shared with me" on={active === 'shared'} onClick={() => scope('shared')}>
        <UsersIcon size="rail" />
      </IconButton>
      <Rule />
      {spaces.map((w) => (
        <IconButton key={w.id} aria-label={w.name} on={active === `ws:${w.id}`} onClick={() => scope(`ws:${w.id}`)}>
          <BuildingIcon size="rail" />
        </IconButton>
      ))}
      <IconButton aria-label="New workspace" onClick={createWorkspace}>
        <FolderPlusIcon size="rail" />
      </IconButton>
      <Rule />
      <IconButton aria-label="Community" on={active === 'community'} onClick={() => go('/community')}>
        <WebIcon size="rail" />
      </IconButton>
      <IconButton aria-label="Automations" on={active === 'automations'} onClick={() => go('/automations')}>
        <WorkflowIcon size="rail" />
      </IconButton>
      <IconButton aria-label="Integrations" on={active === 'integrations'} onClick={() => go('/integrations')}>
        <BlocksIcon size="rail" />
      </IconButton>
      <Rule />
      {agents.map((a) => (
        <span key={a.name} className="grid size-8 place-items-center" title={a.name}>
          <AgentIcon name={a.name} size={14} color={colorFor(a.name)} />
        </span>
      ))}
      <IconButton aria-label="Connect an agent" onClick={connect}>
        <CirclePlusIcon size="rail" />
      </IconButton>
      {children ? (
        <>
          <Rule />
          {/* the page's own group, as glyphs: labels stay for screen readers */}
          <div data-rail="narrow" className="flex w-full flex-col items-center gap-0.5">
            {children}
          </div>
        </>
      ) : null}
      <div className="mt-auto pt-4">
        <AccountMenu face side="top" align="start" />
      </div>
    </div>
  )

  /* the full rail; in the phone drawer the hide control closes the drawer
     instead of narrowing the rail */
  const wide = (inDrawer: boolean) => (
    <div
      key="wide"
      data-icon-motion
      className="flex min-h-full w-full animate-[fade-in_0.25s_ease] flex-col motion-reduce:animate-none"
    >
      <DashSidebarBrand onHome={() => go('/')}>
        <span className="ml-auto flex items-center gap-2.5 text-ink-soft">
          <IconButton size="sm" aria-label="Search canvases (⌘K)" onClick={openSearch}>
            <SearchIcon width={15} height={15} />
          </IconButton>
          <IconButton
            size="sm"
            aria-label="Hide sidebar"
            onClick={() => (inDrawer ? setDrawer(false) : setRail(false))}
          >
            <PanelCollapseIcon width={15} height={15} />
          </IconButton>
        </span>
      </DashSidebarBrand>

      <nav className="flex flex-col gap-0.5">
        <DashNavItem
          density="rail"
          icon={<GridIcon size="rail" />}
          active={active === 'all'}
          onClick={() => scope('all')}
        >
          All canvases
        </DashNavItem>
        <DashNavItem
          density="rail"
          icon={<UserIcon size="rail" />}
          active={active === 'mine'}
          onClick={() => scope('mine')}
        >
          Owned by me
        </DashNavItem>
        <DashNavItem
          density="rail"
          icon={<UsersIcon size="rail" />}
          active={active === 'shared'}
          onClick={() => scope('shared')}
        >
          Shared with me
        </DashNavItem>
      </nav>

      <DashSectionLabel density="rail">Workspaces</DashSectionLabel>
      <nav className="flex flex-col gap-0.5">
        {spaces.map((w) => (
          <DashNavItem
            key={w.id}
            density="rail"
            icon={<BuildingIcon size="rail" />}
            count={
              w.active ? (
                <em className="not-italic">{workspaceCounts.get(w.id) ?? 0}</em>
              ) : (
                <span className="inline-flex items-center gap-1" title="No plan yet">
                  <LockIcon width={12} height={12} aria-hidden />
                </span>
              )
            }
            active={active === `ws:${w.id}`}
            onClick={() => scope(`ws:${w.id}`)}
          >
            {w.name}
          </DashNavItem>
        ))}
        <DashNavItem density="rail" icon={<FolderPlusIcon size="rail" />} onClick={createWorkspace}>
          {spaces.length ? 'New workspace' : 'Create workspace'}
        </DashNavItem>
      </nav>

      <DashSectionLabel density="rail">Explore</DashSectionLabel>
      <nav className="flex flex-col gap-0.5">
        <DashNavItem
          density="rail"
          icon={<WebIcon size="rail" />}
          active={active === 'community'}
          onClick={() => go('/community')}
        >
          Community
        </DashNavItem>
      </nav>

      <DashSectionLabel density="rail">Resources</DashSectionLabel>
      <nav className="flex flex-col gap-0.5">
        <DashNavItem
          density="rail"
          icon={<WorkflowIcon size="rail" />}
          active={active === 'automations'}
          onClick={() => go('/automations')}
        >
          Automations
        </DashNavItem>
        <DashNavItem
          density="rail"
          icon={<BlocksIcon size="rail" />}
          active={active === 'integrations'}
          onClick={() => go('/integrations')}
        >
          Integrations
        </DashNavItem>
      </nav>

      {/* a page's own group keeps the drawer's contract: a pick puts it away */}
      <div
        className="contents"
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest('button, a')) setDrawer(false)
        }}
      >
        {children}
      </div>

      <DashSectionLabel density="rail">Agents</DashSectionLabel>
      <div className="flex flex-col gap-0.5">
        {agents.map((a) => (
          <DashNavItem
            key={a.name}
            as="div"
            density="rail"
            title={`${a.canvases} canvas${a.canvases === 1 ? '' : 'es'}`}
            icon={<AgentIcon name={a.name} size={14} color={colorFor(a.name)} />}
            trailing={
              a.lastAt > 0 && now - a.lastAt < LIVE_WINDOW ? (
                <Dot size="sm" className="bg-success" title="working right now" />
              ) : (
                <span className="text-caption text-ink-faint">{a.lastAt > 0 ? timeAgo(a.lastAt) : ''}</span>
              )
            }
          >
            {a.name}
          </DashNavItem>
        ))}
        <DashNavItem density="rail" icon={<CirclePlusIcon size="rail" />} onClick={connect}>
          Connect an agent
        </DashNavItem>
      </div>

      <div className="mt-auto flex items-center gap-2.5 px-1 pt-4">
        <AccountMenu face side="top" align="start" />
        <AccountName />
      </div>
    </div>
  )

  return (
    <>
      {/* one aside whose width glides between the two sizes; the layout's
          column follows it (railLayout), and each state fades in over it */}
      <DashSidebar
        variant="rail"
        className={cn(
          'transition-[width] duration-normal ease-out-quad motion-reduce:transition-none',
          !open && 'px-2 md:w-14',
        )}
      >
        {open ? wide(false) : narrow}
      </DashSidebar>
      {/* on a phone the rail is a drawer over the page, opened from the header */}
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[280px] max-w-[85vw] gap-0 overflow-y-auto bg-sub px-3 pb-3 pt-3.5 text-ink md:hidden"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {wide(true)}
        </SheetContent>
      </Sheet>
      {modals}
    </>
  )
}

/** the DashLayout column spec that lets the rail set its own width */
export const railLayout = 'md:grid-cols-[auto_1fr]'

function AccountName() {
  const { data: session } = authClient.useSession()
  return <span className="truncate text-body text-ink-soft">{session?.user.name}</span>
}

function Rule() {
  return <div className="my-2 h-px w-6 bg-line" />
}
