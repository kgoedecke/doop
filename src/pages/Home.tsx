import { useEffect, useMemo, useRef, useState } from 'react'
import type { Canvas, CanvasMeta } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { api, type HomeActivity } from '../lib/api'
import { authClient } from '../lib/auth'
import { navigate } from '../App'
import { Logo } from '../components/Logo'
import { timeAgo } from '../lib/time'
import { AgentIcon } from '../components/AgentIcon'
import { ShareModal } from '../components/ShareModal'
import { AccountMenu, ConnectCard, IconGrid, IconList, IconShare, IconUser } from '../components/DashShell'
import { posthog } from '../lib/posthog'
import { closeTab, openCanvasTab, pruneTabs } from '../lib/desktop'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Card, cardVariants } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { Dot } from '../components/ui/dot'
import { Wordmark } from '../components/ui/wordmark'
import { SegmentedIconItem, SegmentedIcons } from '../components/ui/segmented'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { CopyIcon, MoreHorizontalIcon, ShareIcon, TrashIcon } from '../components/ui/icons'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import { Toast } from '../components/ui/toast'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashSidebar,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'
import { cn } from '@/lib/utils'

/** an agent that worked this recently is treated as still at the desk */
const LIVE_WINDOW = 5 * 60 * 1000

type Scope = 'all' | 'mine' | 'shared'

/* a canvas tile: the Card surface, made clickable */
const cardCls = cn(
  cardVariants(),
  'overflow-hidden p-0 text-left transition-[translate,box-shadow,border-color] duration-150 hover:-translate-y-[3px] hover:border-ink-faint hover:shadow-pop',
)

export function Home() {
  const [canvases, setCanvases] = useState<CanvasMeta[] | null>(null)
  const [activity, setActivity] = useState<HomeActivity[]>([])
  const [scope, setScope] = useState<Scope>('all')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [shareCanvas, setShareCanvas] = useState<Canvas | null>(null)
  const [deleteCanvas, setDeleteCanvas] = useState<CanvasMeta | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /* a clock the render can read: an agent that just worked shows as live, and
     the relative times stay honest without a reload */
  const [now, setNow] = useState(0)
  const { data: session } = authClient.useSession()
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    reload()
    api.homeActivity().then(setActivity).catch(console.error)
    const start = window.setTimeout(() => setNow(Date.now()), 0)
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      window.clearTimeout(start)
      window.clearInterval(tick)
    }
  }, [])

  /* ⌘K is the search affordance people already expect */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function createCanvas() {
    const canvas = await api.createCanvas('Untitled canvas')
    posthog.capture('canvas_created')
    open(canvas.id, canvas.name)
  }

  async function duplicate(canvas: CanvasMeta) {
    if (duplicatingId) return
    setDuplicatingId(canvas.id)
    try {
      const copy = await api.duplicateCanvas(canvas.id)
      posthog.capture('canvas_duplicated')
      reload()
      open(copy.id, copy.name)
    } catch (error) {
      console.error(error)
      showToast('Couldn’t duplicate canvas')
    } finally {
      setDuplicatingId(null)
    }
  }

  async function share(canvas: CanvasMeta) {
    try {
      setShareCanvas(await api.getCanvas(canvas.id))
    } catch (error) {
      console.error(error)
      showToast('Couldn’t open sharing')
    }
  }

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  /* Figma-style in the desktop shell: the canvas gets its own tab and Home
     stays put. In the browser it's a plain in-page navigation. */
  function open(id: string, title?: string) {
    if (!openCanvasTab(id, title)) navigate(`/c/${id}`)
  }

  function reload() {
    api
      .listCanvases()
      .then((list) => {
        setCanvases(list)
        /* every fresh list is a chance to drop tabs for canvases that are
           gone — deleted here, in another session, or by someone else */
        pruneTabs(new Set(list.map((c) => c.id)))
      })
      .catch(console.error)
  }

  const hour = new Date().getHours()
  const daypart = hour < 5 ? 'Up late' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'
  const first = session?.user.name?.split(' ')[0]
  const frameTotal = canvases?.reduce((n, c) => n + c.frameCount, 0) ?? 0
  const counts = {
    all: canvases?.length ?? 0,
    mine: canvases?.filter((c) => !c.shared).length ?? 0,
    shared: canvases?.filter((c) => c.shared).length ?? 0,
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (canvases ?? [])
      .filter((c) => (scope === 'mine' ? !c.shared : scope === 'shared' ? !!c.shared : true))
      .filter((c) => !q || c.name.toLowerCase().includes(q))
  }, [canvases, scope, query])

  /* every agent that has worked on these canvases, aggregated across them */
  const agents = useMemo(() => {
    const map = new Map<string, { name: string; owner?: string; lastAt: number; canvases: number }>()
    for (const c of canvases ?? []) {
      for (const a of c.agents ?? []) {
        const e = map.get(a.name)
        if (e) {
          e.canvases += 1
          e.lastAt = Math.max(e.lastAt, a.lastAt ?? 0)
          if (!e.owner) e.owner = a.owner
        } else {
          map.set(a.name, { name: a.name, owner: a.owner, lastAt: a.lastAt ?? 0, canvases: 1 })
        }
      }
    }
    return [...map.values()].sort((x, y) => y.lastAt - x.lastAt)
  }, [canvases])

  const empty = canvases !== null && canvases.length === 0

  return (
    <DashLayout>
      <DashSidebar>
        <Wordmark size="sm" className="px-2 pb-5 text-[17px]" />

        <nav className="flex flex-col gap-0.5">
          <NavItem
            icon={<IconGrid />}
            label="All canvases"
            count={counts.all}
            on={scope === 'all'}
            go={() => setScope('all')}
          />
          <NavItem
            icon={<IconUser />}
            label="Owned by me"
            count={counts.mine}
            on={scope === 'mine'}
            go={() => setScope('mine')}
          />
          <NavItem
            icon={<IconShare />}
            label="Shared with me"
            count={counts.shared}
            on={scope === 'shared'}
            go={() => setScope('shared')}
          />
        </nav>

        {agents.length > 0 && (
          <>
            <DashSectionLabel>Agents</DashSectionLabel>
            <div className="flex flex-col gap-0.5">
              {agents.slice(0, 5).map((a) => (
                <div
                  key={a.name}
                  className="flex min-w-0 items-center gap-[9px] px-2.5 py-[5px] text-[13px] text-ink-soft"
                  title={`${a.canvases} canvas${a.canvases === 1 ? '' : 'es'}`}
                >
                  <span
                    className="grid size-[22px] flex-none place-items-center rounded-[7px] bg-paper-deep"
                    style={{ color: colorFor(a.name) }}
                  >
                    <AgentIcon name={a.name} size={13} />
                  </span>
                  <span className="truncate">{a.name}</span>
                  {a.lastAt > 0 && now - a.lastAt < LIVE_WINDOW ? (
                    <Dot
                      size="sm"
                      className="ml-auto bg-[#3f9c52] shadow-[0_0_0_3px_rgba(63,156,82,0.15)]"
                      title="working right now"
                    />
                  ) : (
                    <span className="ml-auto flex-none text-[11px] text-ink-faint">
                      {a.lastAt > 0 ? timeAgo(a.lastAt) : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {activity.length > 0 && (
          <>
            <DashSectionLabel>Live now</DashSectionLabel>
            <div className="flex flex-col gap-0.5">
              {activity.slice(0, 4).map((a) => (
                <button
                  key={a.id}
                  className="flex w-full gap-[9px] rounded-[9px] border-0 bg-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-paper"
                  onClick={() => open(a.canvasId, a.canvasName)}
                >
                  <Dot size="sm" className="mt-[5px]" style={{ background: a.actorColor }} />
                  <span className="min-w-0 text-[12px] leading-[1.35] text-ink-soft">
                    <b className="font-semibold text-ink">{a.actorName}</b> {a.message}
                    <span className="mt-0.5 block truncate text-[10.5px] text-ink-faint">
                      {a.canvasName} · {timeAgo(a.at)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="min-h-6 flex-1" />
        <ConnectCard />
      </DashSidebar>

      <DashMain>
        <DashHeader className="max-md:min-h-[104px]">
          <Button
            variant="bare"
            className="min-h-10 gap-2 p-0 font-display text-base font-extrabold text-ink hover:bg-transparent md:hidden"
            onClick={() => navigate('/')}
            aria-label="Doop home"
          >
            <Logo className="size-7" /> Doop
          </Button>
          <label className="order-2 flex h-10 max-w-none flex-1 basis-full items-center gap-[9px] rounded-[10px] border border-line bg-surface px-[11px] text-ink-faint focus-within:border-ink-faint md:order-none md:h-[34px] md:max-w-[400px] md:basis-auto">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search canvases"
              aria-label="Search canvases"
              variant="bare"
              inputSize="auto"
              className="flex-1 md:text-[13px]"
            />
            <kbd className="hidden flex-none rounded-[5px] border border-line px-[5px] py-px font-mono text-[10px] text-ink-faint md:block">
              ⌘K
            </kbd>
          </label>
          <span className="flex-1" />
          <Button variant="primary" className="min-h-10 px-3 md:min-h-0 md:px-3.5" onClick={createCanvas}>
            <span className="max-md:hidden">+ New canvas</span>
            <span className="hidden max-md:inline">+ New</span>
          </Button>
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>
                {daypart}, {first}
                <em className="not-italic text-brand">.</em>
              </DashTitle>
              <DashSubtitle>
                {canvases === null
                  ? '…'
                  : `${counts.all} ${counts.all === 1 ? 'canvas' : 'canvases'} · ${frameTotal} ${
                      frameTotal === 1 ? 'frame' : 'frames'
                    }${agents.length ? ` · ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}` : ''}`}
              </DashSubtitle>
            </div>
            <SegmentedIcons
              className="ml-auto flex-none"
              aria-label="View"
              value={view}
              onValueChange={(next) => setView(next as 'grid' | 'list')}
            >
              <SegmentedIconItem value="grid" aria-label="Grid view">
                <IconGrid />
              </SegmentedIconItem>
              <SegmentedIconItem value="list" aria-label="List view">
                <IconList />
              </SegmentedIconItem>
            </SegmentedIcons>
          </div>

          <Tabs value={scope} onValueChange={(next) => setScope(next as Scope)} className="mt-4 flex md:hidden">
            <TabsList className="h-10 w-full border border-line bg-surface p-1 shadow-card">
              <TabsTrigger value="all">All · {counts.all}</TabsTrigger>
              <TabsTrigger value="mine">Mine · {counts.mine}</TabsTrigger>
              <TabsTrigger value="shared">Shared · {counts.shared}</TabsTrigger>
            </TabsList>
          </Tabs>

          {empty ? (
            <Card className="mt-7 max-w-[560px] rounded-[18px] px-5 pb-6 pt-5 sm:px-7 sm:pb-7 sm:pt-[26px]">
              <h3 className="font-display text-[20px] font-extrabold tracking-[-0.02em]">Start your first canvas</h3>
              <p className="mb-[18px] mt-2.5 text-sm leading-[1.6] text-ink-soft">
                A canvas is a shared space of live HTML frames — you design in the browser, your AI agents design
                through MCP, and everyone watches everything happen in real time.
              </p>
              <Button variant="primary" onClick={createCanvas}>
                + Create a canvas
              </Button>
            </Card>
          ) : (
            <>
              {canvases !== null && (
                <div className="mt-[18px] flex flex-wrap items-center gap-2.5 text-xs text-ink-faint xs:flex-nowrap">
                  {/* the total is already in the subtitle — only say something
                      here when a search or scope has narrowed it */}
                  {(query.trim() || scope !== 'all') && (
                    <span>
                      {visible.length} of {counts.all}
                    </span>
                  )}
                  <span className="ml-0 xs:ml-auto">Sorted by last edited</span>
                </div>
              )}

              {canvases !== null && visible.length === 0 ? (
                <p className="mt-7 text-[13.5px] text-ink-soft">Nothing matches — try a different search or scope.</p>
              ) : view === 'grid' ? (
                <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3.5 xs:grid-cols-[repeat(auto-fill,minmax(214px,1fr))] md:gap-4">
                  {canvases !== null && (
                    <Button
                      variant="ghost"
                      className="min-h-16 flex-col justify-center gap-1.5 overflow-hidden rounded-[14px] border-[1.5px] border-dashed p-0 text-ink-faint hover:border-brand hover:bg-brand/[0.04] hover:text-accent-ink xs:min-h-full"
                      onClick={createCanvas}
                    >
                      <span className="font-display text-[34px] font-bold leading-none">+</span>
                      <span className="text-[13px] font-semibold">New canvas</span>
                    </Button>
                  )}
                  {canvases === null &&
                    [0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} index={i} className={cn(cardCls, 'min-h-[230px] border-solid')} />
                    ))}
                  {visible.map((c) => (
                    <div key={c.id} className={cn(cardCls, 'group relative')}>
                      <button
                        className="block w-full border-0 bg-transparent text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                        onClick={() => open(c.id, c.name)}
                      >
                        <div className="relative grid aspect-[16/10] place-items-center overflow-hidden border-b border-line-soft [background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/18px_18px,var(--paper-deep)]">
                          <Preview canvas={c} />
                          <AgentStack canvas={c} />
                        </div>
                        <div className="px-3 pb-3 pt-2.5">
                          <div className="truncate font-display text-[13.5px] font-semibold">{c.name}</div>
                          <div className="mt-[5px] flex items-center gap-1.5 text-[11.5px] text-ink-faint">
                            <Meta canvas={c} onClaim={reload} />
                          </div>
                        </div>
                      </button>
                      <CanvasActions
                        canvas={c}
                        duplicating={duplicatingId === c.id}
                        onShare={() => share(c)}
                        onDuplicate={() => duplicate(c)}
                        onDelete={c.ownerId && !c.shared ? () => setDeleteCanvas(c) : undefined}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-4 overflow-hidden rounded-[14px] border border-line bg-surface shadow-card">
                  {visible.map((c) => (
                    <div
                      key={c.id}
                      className="group flex w-full items-center border-b border-line-soft transition-colors last:border-b-0 hover:bg-paper"
                    >
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand md:gap-[13px] md:px-3.5 md:py-[9px]"
                        onClick={() => open(c.id, c.name)}
                      >
                        <span className="grid h-9 w-[58px] flex-none place-items-center overflow-hidden rounded-[7px] border border-line-soft bg-paper-deep">
                          <Preview canvas={c} blankSize="text-[9px]" />
                        </span>
                        <span className="min-w-0 flex-1 truncate font-display text-[13.5px] font-semibold">
                          {c.name}
                        </span>
                        <span className="hidden w-[82px] flex-none text-xs text-ink-faint sm:block">
                          {c.frameCount} frame{c.frameCount === 1 ? '' : 's'}
                        </span>
                        <span className="hidden w-[62px] flex-none gap-[3px] xs:flex">
                          {(c.agents ?? []).slice(0, 3).map((a) => (
                            <i key={a.name} style={{ color: colorFor(a.name) }}>
                              <AgentIcon name={a.name} size={11} />
                            </i>
                          ))}
                        </span>
                        <span className="w-auto flex-none text-right text-xs text-ink-faint md:w-[66px]">
                          {timeAgo(c.updatedAt)}
                        </span>
                      </button>
                      <div className="mr-3 flex-none md:mr-3.5">
                        <CanvasActions
                          canvas={c}
                          compact
                          duplicating={duplicatingId === c.id}
                          onShare={() => share(c)}
                          onDuplicate={() => duplicate(c)}
                          onDelete={c.ownerId && !c.shared ? () => setDeleteCanvas(c) : undefined}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </DashContent>
      </DashMain>
      {shareCanvas && (
        <ShareModal
          key={shareCanvas.id}
          canvas={shareCanvas}
          onChange={(patch) => setShareCanvas((current) => (current ? { ...current, ...patch } : null))}
          onClose={() => setShareCanvas(null)}
          onCopied={() => {
            setShareCanvas(null)
            showToast('Canvas link copied')
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleteCanvas}
        onOpenChange={(open) => !open && setDeleteCanvas(null)}
        title={`Delete “${deleteCanvas?.name ?? 'canvas'}”?`}
        description="This permanently deletes the canvas and everything in it. This can’t be undone."
        confirmLabel="Delete canvas"
        destructive
        onConfirm={() => {
          if (deleteCanvas) remove(deleteCanvas.id, reload)
          setDeleteCanvas(null)
        }}
      />
      {toast && <Toast>{toast}</Toast>}
    </DashLayout>
  )
}

function remove(id: string, done: () => void) {
  api
    .deleteCanvas(id)
    .then(() => {
      posthog.capture('canvas_deleted')
      /* a deleted canvas has no tab to come back to (desktop shell) */
      closeTab(id, location.pathname)
    })
    .catch(console.error)
    .finally(done)
}

function Preview({ canvas, blankSize = 'text-[12px]' }: { canvas: CanvasMeta; blankSize?: string }) {
  /* which frame failed, not whether — a new previewFrameId must retry
     rather than inherit the old frame's failure */
  const [failedId, setFailedId] = useState<string | null>(null)
  if (!canvas.previewFrameId) return <span className={cn('text-ink-faint', blankSize)}>empty canvas</span>
  /* a failed render must look different from an empty canvas — silence here
     made preview outages undiagnosable */
  if (failedId === canvas.previewFrameId)
    return <span className={cn('text-ink-faint', blankSize)}>preview unavailable</span>
  return (
    <img
      src={`/i/${canvas.previewFrameId}.jpg?preview`}
      alt=""
      loading="lazy"
      className="h-full w-full object-cover object-top"
      onError={() => setFailedId(canvas.previewFrameId ?? null)}
    />
  )
}

/** who has worked here, over the preview — the canvas's multiplayer at a glance */
function AgentStack({ canvas }: { canvas: CanvasMeta }) {
  const agents = (canvas.agents ?? []).slice(0, 3)
  if (!agents.length) return null
  return (
    <span className="absolute left-2 top-2 flex gap-1">
      {agents.map((a) => (
        <i
          key={a.name}
          className="grid size-5 place-items-center rounded-[6px] border border-line bg-surface shadow-[0_1px_3px_rgba(18,18,23,0.1)]"
          style={{ color: colorFor(a.name) }}
          title={a.name}
        >
          <AgentIcon name={a.name} size={11} />
        </i>
      ))}
    </span>
  )
}

function Meta({ canvas: c, onClaim }: { canvas: CanvasMeta; onClaim: () => void }) {
  return (
    <>
      <span>
        {c.frameCount} frame{c.frameCount === 1 ? '' : 's'}
      </span>
      <span className="opacity-60">·</span>
      <span>{timeAgo(c.updatedAt)}</span>
      {c.shared && (
        <>
          <span className="opacity-60">·</span>
          <span title="You were invited to collaborate on this canvas">shared with you</span>
        </>
      )}
      {!c.ownerId && (
        <Badge
          tone="accent"
          interactive
          title="This canvas predates accounts and is visible to everyone. Claim it to make it yours."
          onClick={async (e) => {
            e.stopPropagation()
            await api.claimCanvas(c.id).catch(console.error)
            onClaim()
          }}
        >
          unclaimed — make mine
        </Badge>
      )}
    </>
  )
}

function NavItem({
  icon,
  label,
  count,
  on,
  go,
}: {
  icon: React.ReactNode
  label: string
  count: number
  on: boolean
  go: () => void
}) {
  return (
    <DashNavItem
      icon={icon}
      count={count}
      active={on}
      onClick={go}
      className="gap-2.5 text-[13.5px] [&_svg]:flex-none [&_svg]:opacity-70 [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]"
    >
      {label}
    </DashNavItem>
  )
}

function CanvasActions({
  canvas,
  compact = false,
  duplicating,
  onShare,
  onDuplicate,
  onDelete,
}: {
  canvas: CanvasMeta
  compact?: boolean
  duplicating: boolean
  onShare: () => void
  onDuplicate: () => void
  onDelete?: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${canvas.name}`}
          className={cn(
            'grid cursor-pointer place-items-center rounded-full transition-[opacity,background,color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
            compact
              ? 'size-8 flex-none text-ink-faint hover:bg-paper-deep hover:text-ink'
              : 'absolute right-2 top-2 size-10 bg-ink/75 text-white opacity-100 hover:bg-ink md:size-7 md:opacity-0 md:group-hover:opacity-100 md:data-[state=open]:opacity-100',
          )}
        >
          <MoreHorizontalIcon className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[190px]">
        <DropdownMenuItem onSelect={onShare}>
          <ShareIcon className="size-4" /> Share
        </DropdownMenuItem>
        <DropdownMenuItem disabled={duplicating} onSelect={onDuplicate}>
          <CopyIcon className="size-4" /> {duplicating ? 'Duplicating…' : 'Duplicate'}
        </DropdownMenuItem>
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger" onSelect={onDelete}>
              <TrashIcon className="size-4" /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
