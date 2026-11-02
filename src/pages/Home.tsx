import { useEffect, useMemo, useState } from 'react'
import type { Canvas, CanvasMeta, WorkspaceSummary } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { api, errorMessage, paywalledWorkspace } from '../lib/api'
import { authClient } from '../lib/auth'
import { navigate } from '../App'
import { timeAgo } from '../lib/time'
import { useStore } from '../lib/store'
import { isResidentLimit } from '../components/TeamAllowance'
import { canvasNameFromPrompt, draftsCardTitle, type DraftCount } from '../lib/homePrompt'
import { AgentIcon } from '../components/AgentIcon'
import { AppRail, railLayout } from '../components/AppRail'
import { ConnectModal } from '../components/ConnectModal'
import { FramePreview, FrameThumb } from '../components/FramePreview'
import { HomeHero } from '../components/HomeHero'
import { SourcePicker } from '../components/ImportSources'
import { importSources } from '../components/importSourceList'
import { Modal } from '../components/ui/modal'
import { ShareModal } from '../components/ShareModal'
import { CreateWorkspaceModal, MoveCanvasModal, UpgradeModal } from '../components/WorkspaceModals'
import { posthog } from '../lib/posthog'
import { closeTab, openCanvasTab, pruneTabs } from '../lib/desktop'
import { AvatarStack } from '../components/ui/avatar'
import { EmptyState } from '../components/ui/empty-state'
import { Button } from '../components/ui/button'
import { IconButton, frostedSurface } from '../components/ui/icon-button'
import { MenuButton } from '../components/ui/menu-button'
import { Pressable } from '../components/ui/pressable'
import { Badge } from '../components/ui/badge'
import { MetaLine, Tile, TileBody, TileCover } from '../components/ui/tile'
import { Skeleton } from '../components/ui/skeleton'
import { Callout } from '../components/ui/callout'
import { SegmentedIconItem, SegmentedIcons } from '../components/ui/segmented'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import {
  BuildingIcon,
  CopyIcon,
  GridIcon,
  ListIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ShareIcon,
  TrashIcon,
  UploadIcon,
} from '../components/ui/icons'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import { Toast } from '../components/ui/toast'
import { DashContent, DashHeader, DashLayout, DashMain } from '../components/ui/dash'
import { useT, type PlainMessageKey } from '../lib/i18n'
import { cn } from '@/lib/utils'

/** the three fixed views, or one workspace (`ws:<id>`) */
type Scope = 'all' | 'mine' | 'shared' | `ws:${string}`

/** how the list is ordered; the default is what the server already sends */
type Sort = 'updated' | 'name' | 'created'
const SORT_LABELS: Record<Sort, PlainMessageKey> = {
  updated: 'home.sortUpdated',
  name: 'home.sortName',
  created: 'home.sortCreated',
}
const isSort = (value: string): value is Sort => Object.hasOwn(SORT_LABELS, value)

function workspaceOf(scope: Scope): string | undefined {
  return scope.startsWith('ws:') ? scope.slice(3) : undefined
}

export function Home() {
  const [canvases, setCanvases] = useState<CanvasMeta[] | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [scope, setScope] = useState<Scope>(() => {
    const wanted = new URLSearchParams(location.search).get('scope')
    return wanted === 'mine' || wanted === 'shared' || wanted?.startsWith('ws:') ? (wanted as Scope) : 'all'
  })
  const [sort, setSort] = useState<Sort>('updated')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [shareCanvas, setShareCanvas] = useState<Canvas | null>(null)
  const [deleteCanvas, setDeleteCanvas] = useState<CanvasMeta | null>(null)
  const [moveCanvas, setMoveCanvas] = useState<CanvasMeta | null>(null)
  const [creatingWorkspace, setCreatingWorkspace] = useState(
    () => new URLSearchParams(location.search).get('workspace') === 'new',
  )
  const [showConnect, setShowConnect] = useState(false)
  const [importing, setImporting] = useState(false)
  /* the upgrade wall, aimed at one workspace, with what they were doing */
  const [upgrade, setUpgrade] = useState<{ workspaceId: string; reason?: string } | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  /* a prompt or import on its way to a fresh canvas */
  const [starting, setStarting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  /* the rail's "Ask Doop" and ⌘/ hand the keyboard to the composer */
  const [composerFocusAt, setComposerFocusAt] = useState(0)
  const { data: session } = authClient.useSession()
  const t = useT()

  useEffect(() => {
    /* the rail on another page sends people here with a scope or a request
       in the URL; it comes off once read so a reload does not replay it */
    const url = new URL(location.href)
    if (url.searchParams.has('scope') || url.searchParams.has('workspace')) {
      url.searchParams.delete('scope')
      url.searchParams.delete('workspace')
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }
    reload()
  }, [])

  /* ⌘/ hands the keyboard to the composer; ⌘K opens the rail's search */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === '/' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setComposerFocusAt(Date.now())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* inside a workspace view the new canvas is filed there — and a workspace
     without a plan answers with the wall instead */
  async function createCanvas() {
    const workspaceId = workspaceOf(scope)
    try {
      const canvas = await api.createCanvas('Untitled canvas', workspaceId)
      posthog.capture('canvas_created', { workspace: !!workspaceId })
      open(canvas.id, canvas.name)
    } catch (error) {
      const walled = paywalledWorkspace(error)
      if (walled) setUpgrade({ workspaceId: walled, reason: t('home.reasonAddCanvas') })
      else showToast(errorMessage(error, t('home.createCanvasFailed')))
    }
  }

  /** The composer: a fresh canvas named after the brief, the brief queued as
   *  its first card, and the canvas opened so the drafts stream in on-screen.
   *  A card that will not queue (an allowance that ran out) still opens the
   *  canvas — the brief is not lost, the wall there explains. */
  async function promptCanvas(text: string, drafts: DraftCount) {
    if (starting) return
    setStarting(true)
    const workspaceId = workspaceOf(scope)
    try {
      const canvas = await api.createCanvas(canvasNameFromPrompt(text), workspaceId)
      try {
        await api.addCard(canvas.id, draftsCardTitle(text, drafts), ['doop'])
        posthog.capture('home_prompt_submitted', { drafts, workspace: !!workspaceId })
      } catch (error) {
        /* the brief — with its draft count — rides along as the canvas
           composer's draft so a retry is one click; a toast here would vanish
           with the navigation. An exhausted allowance raises the wall there,
           any other failure shows as the composer's error. */
        const store = useStore.getState()
        store.setComposerDraft(canvas.id, draftsCardTitle(text, drafts))
        if (isResidentLimit(error)) store.setLimitWall(true)
        else {
          console.error(error)
          store.setComposerSend({
            canvasId: canvas.id,
            status: 'error',
            message: errorMessage(error, t('home.briefNotQueued')),
            at: Date.now(),
          })
        }
      }
      open(canvas.id, canvas.name)
    } catch (error) {
      const walled = paywalledWorkspace(error)
      if (walled) setUpgrade({ workspaceId: walled, reason: t('home.reasonAddCanvas') })
      else showToast(errorMessage(error, t('home.startCanvasFailed')))
    } finally {
      setStarting(false)
    }
  }

  /** Import: the picker opens here; the chosen source lands on a fresh canvas,
   *  which opens straight on that source's screen. */
  async function importInto(source: string) {
    if (starting) return
    setStarting(true)
    const workspaceId = workspaceOf(scope)
    try {
      const canvas = await api.createCanvas('Imported design', workspaceId)
      posthog.capture('canvas_created', { workspace: !!workspaceId, via: 'import', source })
      setImporting(false)
      navigate(`/c/${canvas.id}?import=${encodeURIComponent(source)}`)
    } catch (error) {
      const walled = paywalledWorkspace(error)
      if (walled) setUpgrade({ workspaceId: walled, reason: t('home.reasonAddCanvas') })
      else showToast(errorMessage(error, t('home.startImportFailed')))
    } finally {
      setStarting(false)
    }
  }

  function workspaceName(id: string | undefined): string | undefined {
    return id ? workspaces.find((w) => w.id === id)?.name : undefined
  }

  /** delete and move are the owner's — and, in a workspace, its admins' */
  function canManage(c: CanvasMeta): boolean {
    if (!c.ownerId) return false
    if (!c.shared) return true
    const ws = c.workspaceId ? workspaces.find((w) => w.id === c.workspaceId) : undefined
    return !!ws && ws.role !== 'member'
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
      showToast(t('home.duplicateFailed'))
    } finally {
      setDuplicatingId(null)
    }
  }

  async function share(canvas: CanvasMeta) {
    try {
      setShareCanvas(await api.getCanvas(canvas.id))
    } catch (error) {
      console.error(error)
      showToast(t('home.shareFailed'))
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
    api
      .listWorkspaces()
      .then((res) => setWorkspaces(res.workspaces))
      .catch(console.error)
  }

  const first = session?.user.name?.split(' ')[0]
  const scopedWorkspace = workspaceOf(scope)
  const currentWorkspace = scopedWorkspace ? workspaces.find((w) => w.id === scopedWorkspace) : undefined
  /* a workspace that vanished (deleted, or left) drops the view back to all */
  const scopeGone = !!scopedWorkspace && workspaces.length > 0 && !currentWorkspace
  const [seenScopeGone, setSeenScopeGone] = useState(false)
  if (scopeGone !== seenScopeGone) {
    setSeenScopeGone(scopeGone)
    if (scopeGone) setScope('all')
  }

  const visible = useMemo(() => {
    const ws = workspaceOf(scope)
    const list = (canvases ?? []).filter((c) =>
      ws ? c.workspaceId === ws : scope === 'mine' ? !c.shared : scope === 'shared' ? !!c.shared : true,
    )
    if (sort === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name))
    if (sort === 'created') return [...list].sort((a, b) => b.createdAt - a.createdAt)
    return list
  }, [canvases, scope, sort])

  const empty = canvases !== null && canvases.length === 0
  const listTitle = currentWorkspace
    ? currentWorkspace.name
    : scope === 'mine'
      ? t('home.ownedByMe')
      : scope === 'shared'
        ? t('home.sharedWithMe')
        : t('home.allCanvases')

  return (
    <DashLayout className={railLayout}>
      <AppRail
        active={scope}
        canvases={canvases ?? []}
        workspaces={workspaces}
        onScope={setScope}
        onCreateWorkspace={() => setCreatingWorkspace(true)}
      />
      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare">
          <span className="flex-1" />
          {currentWorkspace && (
            <Button
              variant="ghost"
              className="min-h-10 max-md:hidden md:min-h-0"
              onClick={() => navigate(`/w/${currentWorkspace.id}`)}
            >
              <BuildingIcon /> {t('home.manage')}
            </Button>
          )}
          <Button variant="default" size="bar" disabled={starting} onClick={() => setImporting(true)}>
            <UploadIcon width={15} height={15} className="text-ink-soft" /> {t('home.import')}
          </Button>
          <Button variant="primary" size="bar" onClick={createCanvas}>
            <PlusIcon width={15} height={15} strokeWidth={1.75} />
            <span className="max-md:hidden">{t('home.newCanvas')}</span>
            <span className="hidden max-md:inline">{t('home.newShort')}</span>
          </Button>
        </DashHeader>

        <DashContent className="px-0 pt-0 md:px-0 md:pt-0">
          <HomeHero
            firstName={first}
            busy={starting}
            focusAt={composerFocusAt}
            actions={{
              onPrompt: promptCanvas,
              onImport: () => setImporting(true),
              onConnectAgents: () => setShowConnect(true),
              onAutomations: () => navigate('/automations'),
              onIntegrations: () => navigate('/integrations'),
            }}
          />

          <div className="px-4 pt-8 md:px-8 md:pt-10">
            {currentWorkspace && !currentWorkspace.active && (
              <Callout className="mb-5 flex max-w-[760px] flex-col gap-2 sm:flex-row sm:items-center">
                <span className="flex-1">
                  <b>{t('home.noPlanTitle', { name: currentWorkspace.name })}</b>{' '}
                  {currentWorkspace.role !== 'owner' ? t('home.noPlanAskOwner') : t('home.noPlanChoose')}
                </span>
                {currentWorkspace.role === 'owner' && (
                  <Button variant="primary" size="sm" onClick={() => setUpgrade({ workspaceId: currentWorkspace.id })}>
                    {t('home.choosePlan')}
                  </Button>
                )}
              </Callout>
            )}

            {/* the list's own header: what is listed, and the controls that narrow it */}
            <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
              <h2 className="min-w-0 flex-1 truncate text-body font-medium text-ink">
                {currentWorkspace && listTitle}
                {currentWorkspace && (
                  <span className="ml-2 font-normal text-ink-faint">
                    {t('home.people', { count: currentWorkspace.memberCount })} ·{' '}
                    {currentWorkspace.plan === 'team' && currentWorkspace.active
                      ? t('home.teamPlan')
                      : currentWorkspace.active
                        ? t('home.sharedWorkspace')
                        : t('home.noPlanYet')}
                  </span>
                )}
              </h2>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <MenuButton aria-label={t('home.sortAria', { label: t(SORT_LABELS[sort]) })}>
                    {t(SORT_LABELS[sort])}
                  </MenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width="sm">
                  <DropdownMenuRadioGroup value={sort} onValueChange={(next) => isSort(next) && setSort(next)}>
                    {(Object.keys(SORT_LABELS) as Sort[]).map((key) => (
                      <DropdownMenuRadioItem key={key} value={key}>
                        {t(SORT_LABELS[key])}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <SegmentedIcons
                className="flex-none"
                aria-label={t('home.viewAria')}
                value={view}
                onValueChange={(next) => setView(next as 'grid' | 'list')}
              >
                <SegmentedIconItem value="grid" aria-label={t('home.gridView')}>
                  <GridIcon width={14} height={14} />
                </SegmentedIconItem>
                <SegmentedIconItem value="list" aria-label={t('home.listView')}>
                  <ListIcon width={14} height={14} />
                </SegmentedIconItem>
              </SegmentedIcons>
            </div>

            {empty ? (
              <EmptyState
                className="mt-5"
                title={t('home.emptyTitle')}
                description={t('home.emptyDescription')}
                action={
                  <Button variant="primary" onClick={createCanvas}>
                    {t('home.createCanvas')}
                  </Button>
                }
              />
            ) : canvases !== null && visible.length === 0 ? (
              <p className="mt-7 text-copy text-ink-soft">{t('home.nothingHere')}</p>
            ) : view === 'grid' ? (
              <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3.5 xs:grid-cols-[repeat(auto-fill,minmax(230px,1fr))] md:gap-[18px]">
                {canvases === null && [0, 1, 2, 3].map((i) => <Skeleton key={i} index={i} shape="tile" aspect="5/3" />)}
                {visible.map((c) => (
                  <Tile key={c.id}>
                    <Pressable onClick={() => open(c.id, c.name)}>
                      <TileCover aspect="5/3">
                        <FramePreview frameId={c.previewFrameId} />
                        <AgentStack canvas={c} />
                      </TileCover>
                      <TileBody className="flex items-center gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-body font-medium">{c.name}</div>
                          <Meta
                            canvas={c}
                            onClaim={reload}
                            workspace={scopedWorkspace ? undefined : workspaceName(c.workspaceId)}
                          />
                        </div>
                        <PeopleStack canvas={c} />
                      </TileBody>
                    </Pressable>
                    <CanvasActions
                      canvas={c}
                      duplicating={duplicatingId === c.id}
                      onShare={() => share(c)}
                      onDuplicate={() => duplicate(c)}
                      onMove={workspaces.length && canManage(c) ? () => setMoveCanvas(c) : undefined}
                      onDelete={canManage(c) ? () => setDeleteCanvas(c) : undefined}
                    />
                  </Tile>
                ))}
                {canvases !== null && (
                  <Pressable
                    className="grid min-h-[132px] place-items-center content-center gap-2.5 rounded-panel border border-dashed border-line p-6 text-body text-ink-faint transition-colors hover:border-ink-faint hover:text-ink xs:min-h-full"
                    aria-label={t('home.createNewCanvasAria')}
                    onClick={createCanvas}
                  >
                    <span className="grid size-7 place-items-center rounded-full bg-surface text-ink-soft shadow-ring">
                      <PlusIcon width={14} height={14} />
                    </span>
                    {t('home.newCanvas')}
                  </Pressable>
                )}
              </div>
            ) : (
              <div className="mt-4 overflow-hidden rounded-panel border border-line bg-surface shadow-card">
                {visible.map((c) => (
                  <div
                    key={c.id}
                    className="group flex w-full items-center border-b border-line-soft transition-colors last:border-b-0 hover:bg-paper"
                  >
                    <Pressable
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 md:gap-[13px] md:px-3.5 md:py-[9px]"
                      onClick={() => open(c.id, c.name)}
                    >
                      <FrameThumb frameId={c.previewFrameId} />
                      <span className="min-w-0 flex-1 truncate text-body font-medium">{c.name}</span>
                      <span className="hidden w-[82px] flex-none text-caption text-ink-faint sm:block">
                        {t('home.frames', { count: c.frameCount })}
                      </span>
                      <span className="hidden w-[72px] flex-none xs:flex">
                        <PeopleStack canvas={c} />
                      </span>
                      <span className="hidden w-[62px] flex-none gap-[3px] xs:flex">
                        {(c.agents ?? []).slice(0, 3).map((a) => (
                          <AgentIcon key={a.name} name={a.name} size={11} color={colorFor(a.name)} />
                        ))}
                      </span>
                      <span className="w-auto flex-none text-right text-caption text-ink-faint md:w-[66px]">
                        {timeAgo(c.updatedAt)}
                      </span>
                    </Pressable>
                    <div className="mr-3 flex-none md:mr-3.5">
                      <CanvasActions
                        canvas={c}
                        compact
                        duplicating={duplicatingId === c.id}
                        onShare={() => share(c)}
                        onDuplicate={() => duplicate(c)}
                        onMove={workspaces.length && canManage(c) ? () => setMoveCanvas(c) : undefined}
                        onDelete={canManage(c) ? () => setDeleteCanvas(c) : undefined}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DashContent>
      </DashMain>
      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
      {importing && (
        <Modal size="lg" showClose onClose={() => setImporting(false)}>
          <SourcePicker sources={importSources()} onPick={(id) => void importInto(id)} />
        </Modal>
      )}
      {shareCanvas && (
        <ShareModal
          key={shareCanvas.id}
          canvas={shareCanvas}
          onChange={(patch) => setShareCanvas((current) => (current ? { ...current, ...patch } : null))}
          onClose={() => setShareCanvas(null)}
          onCopied={() => {
            setShareCanvas(null)
            showToast(t('home.linkCopied'))
          }}
        />
      )}
      {creatingWorkspace && (
        <CreateWorkspaceModal
          onClose={() => setCreatingWorkspace(false)}
          onCreated={(ws) => {
            setCreatingWorkspace(false)
            reload()
            setScope(`ws:${ws.id}`)
            /* a workspace that cannot grow yet goes straight to the plan picker */
            if (!ws.active)
              setUpgrade({ workspaceId: ws.id, reason: t('home.reasonWorkspaceReady', { name: ws.name }) })
          }}
        />
      )}
      {upgrade && (
        <UpgradeModal
          workspaceId={upgrade.workspaceId}
          reason={upgrade.reason}
          onClose={() => {
            setUpgrade(null)
            reload()
          }}
        />
      )}
      {moveCanvas && (
        <MoveCanvasModal
          canvas={moveCanvas}
          workspaces={workspaces}
          onClose={() => setMoveCanvas(null)}
          onMoved={(workspaceId) => {
            setMoveCanvas(null)
            showToast(
              workspaceId
                ? t('home.movedTo', { name: workspaceName(workspaceId) ?? t('home.movedToFallback') })
                : t('home.movedToPersonal'),
            )
            reload()
          }}
          onPaywall={(workspaceId) => {
            setMoveCanvas(null)
            setUpgrade({ workspaceId, reason: t('home.reasonMoveCanvas') })
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleteCanvas}
        onOpenChange={(open) => !open && setDeleteCanvas(null)}
        title={t('home.deleteTitle', { name: deleteCanvas?.name ?? t('home.deleteFallbackName') })}
        description={t('home.deleteDescription')}
        confirmLabel={t('home.deleteConfirm')}
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

/** who has worked here, over the preview — the canvas's multiplayer at a glance */
function AgentStack({ canvas }: { canvas: CanvasMeta }) {
  const agents = (canvas.agents ?? []).slice(0, 3)
  if (!agents.length) return null
  return (
    <span className="absolute left-2 top-2 flex gap-1">
      {agents.map((a) => (
        <i
          key={a.name}
          className={cn('grid size-5 place-items-center rounded-row', frostedSurface)}
          style={{ color: colorFor(a.name) }}
          title={a.name}
        >
          <AgentIcon name={a.name} size={11} />
        </i>
      ))}
    </span>
  )
}

/** the people on a canvas — owner first — as overlapping initial discs */
function PeopleStack({ canvas }: { canvas: CanvasMeta }) {
  const people = canvas.people ?? []
  return <AvatarStack size={18} people={people.map((p) => ({ id: p.id, name: p.name, color: colorFor(p.id) }))} />
}

function Meta({ canvas: c, onClaim, workspace }: { canvas: CanvasMeta; onClaim: () => void; workspace?: string }) {
  const owner = c.people?.[0]
  const t = useT()
  return (
    <MetaLine
      className="mt-[3px]"
      trailing={
        !c.ownerId && (
          <Badge
            tone="accent"
            interactive
            title={t('home.claimTitle')}
            onClick={async (e) => {
              e.stopPropagation()
              await api.claimCanvas(c.id).catch(console.error)
              onClaim()
            }}
          >
            {t('home.claimBadge')}
          </Badge>
        )
      }
    >
      {c.shared && !workspace && !c.workspaceId && owner ? (
        <span title={t('home.sharedByTitle')}>{t('home.sharedBy', { name: owner.name })}</span>
      ) : (
        <span>{t('home.edited', { time: timeAgo(c.updatedAt) })}</span>
      )}
      {workspace && (
        <span className="inline-flex min-w-0 items-center gap-1 truncate" title={t('home.inWorkspace', { workspace })}>
          <BuildingIcon width={11} height={11} aria-hidden /> {workspace}
        </span>
      )}
    </MetaLine>
  )
}

function CanvasActions({
  canvas,
  compact = false,
  duplicating,
  onShare,
  onDuplicate,
  onMove,
  onDelete,
}: {
  canvas: CanvasMeta
  compact?: boolean
  duplicating: boolean
  onShare: () => void
  onDuplicate: () => void
  onMove?: () => void
  onDelete?: () => void
}) {
  const t = useT()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          aria-label={t('home.actionsFor', { name: canvas.name })}
          variant={compact ? 'quiet' : 'frosted'}
          shape={compact ? 'round' : 'square'}
          className={
            compact
              ? 'text-ink-faint focus-visible:ring-brand'
              : /* the frosted chip over the preview, revealed by the tile's hover */
                'absolute right-2 top-2 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100'
          }
        >
          <MoreHorizontalIcon className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="md">
        <DropdownMenuItem onSelect={onShare}>
          <ShareIcon className="size-4" /> {t('home.share')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={duplicating} onSelect={onDuplicate}>
          <CopyIcon className="size-4" /> {duplicating ? t('home.duplicating') : t('home.duplicate')}
        </DropdownMenuItem>
        {onMove && (
          <DropdownMenuItem onSelect={onMove}>
            <BuildingIcon className="size-4" /> {canvas.workspaceId ? t('home.move') : t('home.moveToWorkspace')}
          </DropdownMenuItem>
        )}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="danger" onSelect={onDelete}>
              <TrashIcon className="size-4" /> {t('common.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
