import { useEffect, useState } from 'react'
import {
  adminApi,
  type AdminAgentFeedback,
  type AdminAgentFeedbackPage,
  type AdminCanvas,
  type AdminStats,
  type AdminUser,
} from '../lib/api'
import { navigate } from '../App'
import { timeAgo } from '../lib/time'
import { AppRail, railLayout } from '../components/AppRail'
import { ChevronRightIcon, GridIcon, MessageSquareIcon, UsersIcon } from '../components/ui/icons'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Button } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import { Badge } from '../components/ui/badge'
import { ToggleChipGroup, ToggleChipItem } from '../components/ui/toggle-chip'
import type { AgentFeedbackKind } from '../../shared/agentFeedback'
import { SearchField } from '../components/ui/search-field'
import { MetaLine, Tile, TileBody, TileCover } from '../components/ui/tile'
import { Skeleton } from '../components/ui/skeleton'
import { FramePreview } from '../components/FramePreview'
import {
  DashContent,
  DashHeader,
  DashLayout,
  DashMain,
  DashNavItem,
  DashSectionLabel,
  DashSubtitle,
  DashTitle,
} from '../components/ui/dash'
import type { LinkAccess } from '../../shared/canvasRole'
import { useT, type PlainMessageKey } from '../lib/i18n'

type SharedAccess = Exclude<LinkAccess, 'none'>

/* a shared canvas's link level: the badge, and the sentence its tooltip says */
const LINK_BADGE = {
  view: 'admin.linkView',
  comment: 'admin.linkComment',
  edit: 'admin.linkEdit',
} as const satisfies Record<SharedAccess, PlainMessageKey>

const LINK_TITLE = {
  view: 'admin.linkAccessView',
  comment: 'admin.linkAccessComment',
  edit: 'admin.linkAccessEdit',
} as const satisfies Record<SharedAccess, PlainMessageKey>

type Tab = 'canvases' | 'users' | 'feedback'

const SEARCH_LABEL: Record<Tab, PlainMessageKey> = {
  canvases: 'admin.searchCanvases',
  users: 'admin.searchAccounts',
  feedback: 'admin.searchFeedback',
}

/**
 * The instance index: every canvas, every account. Read-only — the way to
 * look inside someone's canvas is "view as", which hands you a real (but
 * read-only, 15-minute) session as its owner rather than granting admins a
 * privileged read path through the canvas gate.
 *
 * Same shell as home and settings; the rail's middle carries the two indexes.
 */
export function Admin() {
  const t = useT()
  const [data, setData] = useState<{ total: number; canvases: AdminCanvas[] } | null>(null)
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [tab, setTab] = useState<Tab>('canvases')
  /* the ban/unban awaiting "are you sure" — an in-app dialog, since
     window.confirm is a silent "cancel" in the desktop shell's webview */
  const [confirmBan, setConfirmBan] = useState<{ user: AdminUser; banned: boolean } | null>(null)
  const [q, setQ] = useState('')
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    adminApi
      .canvases()
      .then(setData)
      .catch(() => setDenied(true))
    adminApi
      .stats()
      .then(setStats)
      .catch(() => {})
    adminApi
      .users()
      .then(setUsers)
      .catch(() => {})
  }, [])

  async function viewAs(userId: string) {
    await adminApi.impersonate(userId)
    /* the session cookie has been replaced — every piece of client state now
       belongs to the wrong person. Reload rather than reconcile. */
    location.assign('/')
  }

  async function setBanned(u: AdminUser, banned: boolean) {
    try {
      if (banned) await adminApi.ban(u.id)
      else await adminApi.unban(u.id)
      setUsers((list) => (list ? list.map((x) => (x.id === u.id ? { ...x, banned } : x)) : list))
    } catch (e) {
      console.error(e)
    }
  }

  if (denied) {
    return (
      <div className="h-full overflow-y-auto [background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/26px_26px,var(--paper)]">
        <div className="mx-auto max-w-[1060px] px-10 pt-[72px] pb-[120px]">
          <DashTitle className="mt-16">{t('admin.notFound')}</DashTitle>
          <p className="mt-3.5 max-w-[44em] text-lead leading-[1.6] text-ink-soft">{t('admin.notFoundBody')}</p>
          <Button variant="ghost" className="mt-5" onClick={() => navigate('/')}>
            {t('admin.back')}
          </Button>
        </div>
      </div>
    )
  }

  const needle = q.trim().toLowerCase()
  const canvases = (data?.canvases ?? []).filter(
    (c) =>
      !needle ||
      c.name.toLowerCase().includes(needle) ||
      c.owner?.name.toLowerCase().includes(needle) ||
      c.owner?.email.toLowerCase().includes(needle),
  )
  const shownUsers = (users ?? []).filter(
    (u) => !needle || u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle),
  )

  return (
    <DashLayout className={railLayout}>
      {/* the app rail, with the two indexes as the page's group */}
      <AppRail active={null}>
        <DashSectionLabel density="rail">{t('admin.instance')}</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem
            density="rail"
            icon={<GridIcon size="rail" />}
            count={stats?.canvases ?? ''}
            active={tab === 'canvases'}
            onClick={() => setTab('canvases')}
          >
            {t('admin.canvases')}
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<UsersIcon size="rail" />}
            count={stats?.users ?? ''}
            active={tab === 'users'}
            onClick={() => setTab('users')}
          >
            {t('admin.accounts')}
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<MessageSquareIcon size="rail" />}
            count={stats?.agentFeedback ?? ''}
            active={tab === 'feedback'}
            onClick={() => setTab('feedback')}
          >
            {t('admin.feedbackNav')}
          </DashNavItem>
        </nav>
      </AppRail>

      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare" className="max-md:min-h-[104px]">
          <nav className="flex items-center gap-2 text-body text-ink-faint" aria-label={t('admin.breadcrumb')}>
            <Button
              variant="link"
              size="sm"
              className="px-0 py-0 text-body font-normal text-ink-faint hover:text-ink"
              onClick={() => navigate('/')}
            >
              {t('admin.home')}
            </Button>
            <ChevronRightIcon size={12} />
            <b className="font-semibold text-ink">{t('admin.admin')}</b>
          </nav>
          <SearchField
            size="header"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`${t(SEARCH_LABEL[tab])}…`}
            aria-label={t(SEARCH_LABEL[tab])}
          />
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div>
              <DashTitle>
                {t('admin.title')}
                <em className="not-italic text-brand">.</em>
              </DashTitle>
              <DashSubtitle>
                {stats
                  ? `${t('admin.accountCount', { count: stats.users })} · ${t('admin.canvasCount', {
                      count: stats.canvases,
                    })} · ${t('admin.frameCount', { count: stats.frames })}`
                  : '…'}
              </DashSubtitle>
            </div>
          </div>

          <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)} className="mt-4 flex md:hidden">
            <TabsList variant="card">
              <TabsTrigger value="canvases">
                <GridIcon size="rail" /> {t('admin.canvasesTab', { count: stats?.canvases ?? '…' })}
              </TabsTrigger>
              <TabsTrigger value="users">
                <UsersIcon size="rail" /> {t('admin.accountsTab', { count: stats?.users ?? '…' })}
              </TabsTrigger>
              <TabsTrigger value="feedback">
                <MessageSquareIcon size="rail" /> {t('admin.feedbackTab', { count: stats?.agentFeedback ?? '…' })}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {tab === 'canvases' ? (
            <>
              {data && data.total > data.canvases.length && (
                <div className="mt-[18px] flex flex-wrap items-center gap-2.5 text-xs text-ink-faint">
                  <span>{t('admin.showingRecent', { shown: data.canvases.length, total: data.total })}</span>
                </div>
              )}
              <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3.5 xs:grid-cols-[repeat(auto-fill,minmax(214px,1fr))] md:gap-4">
                {data === null && [0, 1, 2, 3].map((i) => <Skeleton key={i} index={i} shape="tile" aspect="4/3" />)}
                {canvases.map((c) => (
                  <Tile key={c.id} tone="solid">
                    <TileCover aspect="4/3">
                      <FramePreview frameId={c.previewFrameId} />
                    </TileCover>
                    <TileBody className="flex flex-1 flex-col">
                      <div className="truncate font-display text-copy font-semibold">{c.name}</div>
                      <MetaLine
                        className="mt-[5px] min-h-0 flex-wrap content-start xs:min-h-[30px]"
                        trailing={
                          c.linkAccess !== 'none' && (
                            <Badge className="px-[5px] py-px text-micro" title={t(LINK_TITLE[c.linkAccess])}>
                              {t(LINK_BADGE[c.linkAccess])}
                            </Badge>
                          )
                        }
                      >
                        <span>{c.owner ? c.owner.name : t('admin.unclaimed')}</span>
                        <span>{t('admin.frameCount', { count: c.frameCount })}</span>
                        <span>{timeAgo(c.updatedAt)}</span>
                        {c.memberCount > 0 && <span>{t('admin.invited', { count: c.memberCount })}</span>}
                      </MetaLine>
                      {c.owner && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-auto self-start"
                          onClick={() => viewAs(c.owner!.id)}
                        >
                          {t('admin.viewAsName', { name: c.owner.name.split(' ')[0] ?? '' })}
                        </Button>
                      )}
                    </TileBody>
                  </Tile>
                ))}
              </div>
            </>
          ) : tab === 'feedback' ? (
            <AgentFeedbackList q={q} />
          ) : (
            <div className="mt-4 overflow-hidden rounded-panel border border-line bg-surface shadow-card">
              {users === null && <p className="mt-7 text-copy text-ink-soft">…</p>}
              {shownUsers.map((u) => (
                <div
                  key={u.id}
                  className="flex flex-col items-stretch justify-between gap-2.5 border-b border-line-soft p-3.5 last:border-b-0 md:flex-row md:items-center md:gap-4 md:px-[18px] md:py-[13px]"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2 font-display text-copy font-semibold">
                      {u.name}
                      {u.role === 'admin' && <Badge tone="admin">{t('admin.roleAdmin')}</Badge>}
                      {u.banned && <Badge tone="banned">{t('admin.banned')}</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-body text-ink-faint">
                      <span>{u.email}</span>
                      <span>·</span>
                      <span>{t('admin.canvasCount', { count: u.canvasCount })}</span>
                      <span>·</span>
                      <span>{t('admin.joined', { time: timeAgo(u.createdAt) })}</span>
                    </div>
                  </div>
                  {u.role !== 'admin' && (
                    <div className="flex flex-wrap items-center gap-2">
                      {!u.banned && (
                        <Button variant="ghost" size="sm" onClick={() => viewAs(u.id)}>
                          {t('admin.viewAs')}
                        </Button>
                      )}
                      <Button
                        variant={u.banned ? 'ghost' : 'danger'}
                        size="sm"
                        onClick={() => setConfirmBan({ user: u, banned: !u.banned })}
                      >
                        {u.banned ? t('admin.unban') : t('admin.ban')}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </DashContent>
      </DashMain>
      <ConfirmDialog
        open={!!confirmBan}
        onOpenChange={(open) => !open && setConfirmBan(null)}
        title={t(confirmBan?.banned ? 'admin.banTitle' : 'admin.unbanTitle', {
          name: confirmBan?.user.name ?? '',
          email: confirmBan?.user.email ?? '',
        })}
        description={confirmBan?.banned ? t('admin.banDescription') : undefined}
        confirmLabel={confirmBan?.banned ? t('admin.ban') : t('admin.unban')}
        destructive={confirmBan?.banned}
        onConfirm={() => {
          const target = confirmBan
          setConfirmBan(null)
          if (target) void setBanned(target.user, target.banned)
        }}
      />
    </DashLayout>
  )
}

type KindFilter = 'all' | AgentFeedbackKind

/** What agents sent the Doop team: issues (report_issue) and ideas or praise
 *  (share_feedback). Search and the kind filter run on the server, so older
 *  reports stay findable; the list loads a page at a time. */
function AgentFeedbackList({ q }: { q: string }) {
  const [kind, setKind] = useState<KindFilter>('all')
  const [search, setSearch] = useState(q.trim())
  /* one request per pause in typing, not per keystroke */
  useEffect(() => {
    const timer = setTimeout(() => setSearch(q.trim()), 250)
    return () => clearTimeout(timer)
  }, [q])
  /* a new filter or search starts the pages over: a fresh FeedbackPages */
  return <FeedbackPages key={`${kind}\n${search}`} kind={kind} search={search} onKind={setKind} />
}

function FeedbackPages({
  kind,
  search,
  onKind,
}: {
  kind: KindFilter
  search: string
  onKind: (kind: KindFilter) => void
}) {
  const t = useT()
  const [reports, setReports] = useState<AdminAgentFeedback[]>([])
  const [page, setPage] = useState<AdminAgentFeedbackPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  function load(before?: AdminAgentFeedback) {
    setLoading(true)
    setFailed(false)
    adminApi
      .agentFeedback({ kind: kind === 'all' ? undefined : kind, q: search || undefined, before })
      .then((next) => {
        setPage(next)
        setReports((shown) => (before ? [...shown, ...next.reports] : next.reports))
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }

  // eslint-disable-next-line react/exhaustive-deps -- the first page loads once; a new filter remounts this component
  useEffect(() => load(), [])

  const counts = page?.counts
  const total = counts ? counts.issue + counts.feedback : null
  if (total === 0 && !search) return <p className="mt-7 text-copy text-ink-soft">{t('admin.feedbackEmpty')}</p>
  return (
    <>
      <ToggleChipGroup
        className="mt-4 gap-1.5"
        aria-label={t('admin.feedbackKind')}
        value={kind}
        onValueChange={(next) => next && onKind(next as KindFilter)}
      >
        <ToggleChipItem value="all" size="sm">
          {t('admin.feedbackAll', { count: total ?? '…' })}
        </ToggleChipItem>
        <ToggleChipItem value="issue" size="sm">
          {t('admin.feedbackIssues', { count: counts?.issue ?? '…' })}
        </ToggleChipItem>
        <ToggleChipItem value="feedback" size="sm">
          {t('admin.feedbackIdeas', { count: counts?.feedback ?? '…' })}
        </ToggleChipItem>
      </ToggleChipGroup>
      {reports.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-panel border border-line bg-surface shadow-card">
          {reports.map((f) => (
            <div key={f.id} className="border-b border-line-soft p-3.5 last:border-b-0 md:px-[18px] md:py-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={f.kind === 'issue' ? 'accent' : 'success'}>
                  {f.kind === 'issue' ? t('admin.feedbackIssue') : t('admin.feedbackIdea')}
                </Badge>
                <Badge tone="outline">{f.category.replaceAll('_', ' ')}</Badge>
                {f.tool && <span className="font-mono text-caption text-ink-soft">{f.tool}</span>}
              </div>
              <p className="mt-1.5 text-copy whitespace-pre-wrap text-ink">{f.message}</p>
              <MetaLine className="mt-1.5">
                <span>{f.agentName ?? t('admin.unnamedAgent')}</span>
                <span>{f.source === 'resident' ? 'Doop Agent' : (f.client ?? 'MCP')}</span>
                {f.user && <span>{f.user.email}</span>}
                {f.canvasId && <span className="font-mono">{f.canvasId}</span>}
                <span>{timeAgo(f.at)}</span>
              </MetaLine>
            </div>
          ))}
        </div>
      )}
      {page && !loading && !failed && reports.length === 0 && (
        <p className="mt-4 text-copy text-ink-soft">{t('admin.feedbackNoMatch')}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2.5 text-body text-ink-faint">
        {failed ? (
          <>
            <span className="text-accent-ink">{t('admin.feedbackLoadFailed')}</span>
            <Button variant="ghost" size="sm" onClick={() => load(reports.at(-1))}>
              {t('admin.tryAgain')}
            </Button>
          </>
        ) : loading ? (
          <span>{t('admin.loading')}</span>
        ) : (
          page?.hasMore && (
            <>
              <span>
                {t('admin.showingNewest', {
                  shown: reports.length,
                  total: (kind === 'all' ? total : kind === 'issue' ? counts?.issue : counts?.feedback) ?? '…',
                })}
              </span>
              <Button variant="ghost" size="sm" onClick={() => load(reports.at(-1))}>
                {t('admin.loadOlder')}
              </Button>
            </>
          )
        )}
      </div>
    </>
  )
}
