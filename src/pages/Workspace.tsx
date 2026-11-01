import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceDetail, WorkspaceRole, WorkspaceSummary } from '../../shared/types'
import { formatUsd, TEAM_SEAT_PRICE, type WorkspaceStatus } from '../../shared/billing'
import { navigate } from '../App'
import { api, errorMessage, paywalledWorkspace } from '../lib/api'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { AppRail, railLayout } from '../components/AppRail'
import { UpgradeModal } from '../components/WorkspaceModals'
import { Avatar } from '../components/ui/avatar'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { CardBody, CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from '../components/ui/card'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { PersonRow } from '../components/ui/list'
import { Skeleton } from '../components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Toast } from '../components/ui/toast'
import { ChevronRightIcon, CreditCardIcon, GearIcon, UsersIcon } from '../components/ui/icons'
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
import { timeAgo } from '../lib/time'
import { getLocale, t as translate, useT, type PlainMessageKey } from '../lib/i18n'

type Pane = 'members' | 'billing' | 'general'

const STATUS_LABEL = {
  inactive: 'workspace.statusInactive',
  trialing: 'workspace.statusTrialing',
  active: 'workspace.statusActive',
  past_due: 'workspace.statusPastDue',
  canceled: 'workspace.statusCanceled',
} as const satisfies Record<WorkspaceStatus, PlainMessageKey>

/* the role as a badge or an invite line says it, lower case like the value */
const ROLE_LABEL = {
  owner: 'workspace.roleOwner',
  admin: 'workspace.roleAdmin',
  member: 'workspace.roleMember',
} as const satisfies Record<WorkspaceRole, PlainMessageKey>

/** A date in the app's language. */
function dateText(at: number): string {
  return new Date(at).toLocaleDateString(getLocale())
}

/**
 * One workspace's settings, in the dashboard shell: who is in it, what it
 * costs, and the name. Stripe's hosted pages do the money — this page only
 * opens them and mirrors what they did. It is also where Checkout lands
 * back (?checkout=success), so the plan takes effect on the screen they see.
 */
export function Workspace({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const { data: session } = authClient.useSession()
  const meId = session?.user.id
  const [ws, setWs] = useState<WorkspaceDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [upgrade, setUpgrade] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /* the checkout round-trip lands here with its outcome in the query; read
     once, then clean the URL in the effect below */
  const [landing] = useState(() => {
    const q = new URLSearchParams(location.search)
    return { checkout: q.get('checkout'), sessionId: q.get('session_id') ?? undefined }
  })
  const [pane, setPane] = useState<Pane>(landing.checkout ? 'billing' : 'members')

  /* the rail's workspace list, reloaded with the workspace so a rename or a
     new plan shows in its row too */
  const [spaces, setSpaces] = useState<WorkspaceSummary[] | undefined>(undefined)

  const reload = useCallback(() => {
    api
      .getWorkspace(workspaceId)
      .then(setWs)
      .catch(() => setMissing(true))
    api
      .listWorkspaces()
      .then((w) => setSpaces(w.workspaces))
      .catch(console.error)
  }, [workspaceId])

  useEffect(() => {
    if (landing.checkout) history.replaceState(null, '', location.pathname)
    if (landing.checkout === 'success') {
      /* pull the subscription now rather than wait for the webhook */
      api
        .syncWorkspaceBilling(workspaceId, landing.sessionId)
        .then((summary) => {
          if (summary.active && summary.plan) {
            posthog.capture('workspace_plan_activated', { workspaceId, interval: summary.interval })
            showToast(translate('workspace.planActive'))
          }
        })
        .catch(console.error)
        .finally(reload)
    } else {
      if (landing.checkout === 'canceled') showToast(translate('workspace.checkoutCanceled'))
      reload()
    }
  }, [landing, workspaceId, reload])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }

  /** every 402 on this page means the same thing */
  function handle(caught: unknown, fallback: string) {
    const walled = paywalledWorkspace(caught)
    if (walled) setUpgrade(t('workspace.needsPlan', { name: ws?.name ?? t('workspace.thisWorkspace') }))
    else showToast(errorMessage(caught, fallback))
  }

  const admin = ws ? ws.role !== 'member' : false
  const isOwner = ws?.role === 'owner'

  if (missing) {
    return (
      <DashLayout className={railLayout}>
        <AppRail active={null} />
        <DashMain className="[background:var(--paper)]">
          <DashHeader variant="bare" />
          <DashContent>
            <DashTitle>{t('workspace.notFound')}</DashTitle>
            <DashSubtitle>{t('workspace.notFoundBody')}</DashSubtitle>
            <Button className="mt-5" onClick={() => navigate('/')}>
              {t('workspace.backToCanvases')}
            </Button>
          </DashContent>
        </DashMain>
      </DashLayout>
    )
  }

  return (
    <DashLayout className={railLayout}>
      {/* the app rail, lit on this workspace, with its panes as the page's group */}
      <AppRail active={`ws:${workspaceId}`} workspaces={spaces}>
        <DashSectionLabel density="rail">{ws?.name ?? t('workspace.workspace')}</DashSectionLabel>
        <nav className="flex flex-col gap-0.5">
          <DashNavItem
            density="rail"
            icon={<UsersIcon size="rail" />}
            active={pane === 'members'}
            onClick={() => setPane('members')}
          >
            {t('workspace.people')}
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<CreditCardIcon size="rail" />}
            active={pane === 'billing'}
            onClick={() => setPane('billing')}
          >
            {t('workspace.planBilling')}
          </DashNavItem>
          <DashNavItem
            density="rail"
            icon={<GearIcon size="rail" />}
            active={pane === 'general'}
            onClick={() => setPane('general')}
          >
            {t('workspace.general')}
          </DashNavItem>
        </nav>
      </AppRail>

      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare">
          <nav className="flex items-center gap-2 text-body text-ink-faint" aria-label={t('workspace.breadcrumb')}>
            <Button
              variant="link"
              size="sm"
              className="px-0 py-0 text-body font-normal text-ink-faint hover:text-ink"
              onClick={() => navigate('/')}
            >
              {t('workspace.home')}
            </Button>
            <ChevronRightIcon size={12} />
            <b className="truncate font-semibold text-ink">{ws?.name ?? '…'}</b>
          </nav>
        </DashHeader>

        <DashContent>
          <div className="flex items-start gap-4 md:items-end">
            <div className="min-w-0">
              <DashTitle className="truncate">{ws?.name ?? '…'}</DashTitle>
              <DashSubtitle>
                {ws
                  ? `${t('workspace.memberCount', { count: ws.memberCount })} · ${t('workspace.canvasCount', {
                      count: ws.canvasCount,
                    })} · ${ws.billing.enabled ? t(STATUS_LABEL[ws.status]) : t('workspace.selfHostedIncluded')}`
                  : '…'}
              </DashSubtitle>
            </div>
          </div>

          <Tabs value={pane} onValueChange={(next) => setPane(next as Pane)} className="mt-4 flex md:hidden">
            <TabsList variant="card">
              <TabsTrigger value="members">{t('workspace.people')}</TabsTrigger>
              <TabsTrigger value="billing">{t('workspace.billing')}</TabsTrigger>
              <TabsTrigger value="general">{t('workspace.general')}</TabsTrigger>
            </TabsList>
          </Tabs>

          {ws && ws.billing.enabled && !ws.active && (
            <Callout className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="flex-1">
                <b>{t('workspace.noPlanYet')}</b> {t('workspace.noPlanBody')}
                {ws.status === 'canceled' ? t('workspace.canceledBody') : ''}
              </span>
              {isOwner && (
                <Button variant="primary" size="sm" onClick={() => setUpgrade('')}>
                  {ws.status === 'canceled' ? t('workspace.reactivate') : t('workspace.choosePlan')}
                </Button>
              )}
            </Callout>
          )}
          {ws && ws.status === 'past_due' && (
            <Callout tone="error" className="mt-4">
              <b>{t('workspace.paymentFailed')}</b> {t('workspace.paymentFailedBody')}
            </Callout>
          )}

          {!ws ? (
            <Skeleton shape="card" className="mt-5 max-w-[1000px]" />
          ) : pane === 'members' ? (
            <MembersPane ws={ws} meId={meId} admin={admin} onChange={reload} onError={handle} onToast={showToast} />
          ) : pane === 'billing' ? (
            <BillingPane
              ws={ws}
              isOwner={isOwner}
              onUpgrade={() => setUpgrade('')}
              onSynced={reload}
              onToast={showToast}
            />
          ) : (
            <GeneralPane ws={ws} admin={admin} isOwner={isOwner} onChange={reload} onToast={showToast} />
          )}
        </DashContent>
      </DashMain>

      {upgrade !== null && (
        <UpgradeModal
          workspaceId={workspaceId}
          reason={upgrade || undefined}
          onClose={() => {
            setUpgrade(null)
            reload()
          }}
        />
      )}
      {toast && <Toast>{toast}</Toast>}
    </DashLayout>
  )
}

/* ---- people ---- */

function MembersPane({
  ws,
  meId,
  admin,
  onChange,
  onError,
  onToast,
}: {
  ws: WorkspaceDetail
  meId?: string
  admin: boolean
  onChange: () => void
  onError: (caught: unknown, fallback: string) => void
  onToast: (message: string) => void
}) {
  const t = useT()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null)

  async function invite() {
    const clean = email.trim()
    if (!clean || busy) return
    setBusy(true)
    try {
      const result = await api.inviteToWorkspace(ws.id, clean, role)
      posthog.capture('workspace_member_invited', { pending: 'invite' in result })
      if ('member' in result) onToast(t('workspace.invitedMember', { name: result.member.name }))
      else
        onToast(
          result.emailed
            ? t('workspace.inviteEmailed', { email: clean })
            : t('workspace.invitePending', { email: clean }),
        )
      setEmail('')
      onChange()
    } catch (caught) {
      onError(caught, t('workspace.inviteFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(userId: string, next: WorkspaceRole) {
    try {
      await api.setWorkspaceRole(ws.id, userId, next)
      onChange()
    } catch (caught) {
      onError(caught, t('workspace.roleChangeFailed'))
    }
  }

  async function remove(userId: string) {
    try {
      await api.removeWorkspaceMember(ws.id, userId)
      if (userId === meId) navigate('/')
      else onChange()
    } catch (caught) {
      onError(caught, t('workspace.removeFailed'))
    }
  }

  async function revoke(inviteId: string) {
    try {
      await api.revokeWorkspaceInvite(ws.id, inviteId)
      onChange()
    } catch (caught) {
      onError(caught, t('workspace.revokeFailed'))
    }
  }

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('workspace.people')}</CardTitle>
        <CardDescription>
          {t('workspace.peopleDescription')}
          {ws.billing.enabled ? t('workspace.oneSeatEach') : ''}
        </CardDescription>
        {admin && (
          <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row">
            <Input
              variant="well"
              className="flex-1"
              placeholder={t('workspace.inviteByEmail')}
              type="email"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && invite()}
              aria-label={t('workspace.emailToInvite')}
            />
            <Select value={role} disabled={busy} onValueChange={(value) => setRole(value as WorkspaceRole)}>
              <SelectTrigger aria-label={t('workspace.role')}>
                <SelectValue />
              </SelectTrigger>
              <RoleOptions />
            </Select>
            <Button variant="primary" className="justify-center" disabled={busy || !email.trim()} onClick={invite}>
              {busy ? t('workspace.inviting') : t('workspace.invite')}
            </Button>
          </div>
        )}
      </CardHeader>
      <div>
        {ws.members.map((m) => {
          const self = m.userId === meId
          const isOwnerRow = m.role === 'owner'
          return (
            <CardRow
              key={m.userId}
              className="py-3"
              action={
                isOwnerRow ? (
                  <Badge tone="accent">{t('workspace.roleOwner')}</Badge>
                ) : admin ? (
                  <>
                    <Select value={m.role} onValueChange={(value) => changeRole(m.userId, value as WorkspaceRole)}>
                      <SelectTrigger size="sm" aria-label={t('workspace.roleOf', { name: m.name })}>
                        <SelectValue />
                      </SelectTrigger>
                      <RoleOptions />
                    </Select>
                    <Button
                      variant="bare-danger"
                      size="sm"
                      onClick={() => setRemoving({ userId: m.userId, name: self ? 'yourself' : m.name })}
                    >
                      {self ? t('workspace.leave') : t('workspace.remove')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Badge>{t(ROLE_LABEL[m.role])}</Badge>
                    {self && (
                      <Button
                        variant="bare-danger"
                        size="sm"
                        onClick={() => setRemoving({ userId: m.userId, name: 'yourself' })}
                      >
                        {t('workspace.leave')}
                      </Button>
                    )}
                  </>
                )
              }
            >
              <PersonRow
                className="flex-1"
                avatar={<Avatar name={m.name} size={32} />}
                name={self ? t('workspace.you', { name: m.name }) : m.name}
                detail={t('workspace.emailJoined', { email: m.email, time: timeAgo(m.addedAt) })}
              />
            </CardRow>
          )
        })}
        {ws.invites.length > 0 && (
          <CardBody className="border-t border-line-soft bg-paper/60">
            <span className="text-caption text-ink-faint">{t('workspace.waitingToSignUp')}</span>
            {ws.invites.map((inv) => (
              <div key={inv.id} className="mt-2 flex items-center gap-3 text-body">
                <span className="min-w-0 flex-1 truncate">
                  {inv.email}{' '}
                  <span className="text-ink-faint">
                    {t('workspace.invitedBy', { role: t(ROLE_LABEL[inv.role]), name: inv.invitedByName })}
                  </span>
                </span>
                <Button variant="bare" size="sm" onClick={() => revoke(inv.id)}>
                  {t('workspace.revoke')}
                </Button>
              </div>
            ))}
          </CardBody>
        )}
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          removing?.userId === meId
            ? t('workspace.leaveTitle', { name: ws.name })
            : t('workspace.removeTitle', { name: removing?.name ?? '' })
        }
        description={removing?.userId === meId ? t('workspace.leaveDescription') : t('workspace.removeDescription')}
        confirmLabel={removing?.userId === meId ? t('workspace.leaveWorkspace') : t('workspace.remove')}
        destructive
        onConfirm={() => {
          if (removing) void remove(removing.userId)
          setRemoving(null)
        }}
      />
    </SettingsCard>
  )
}

/* ---- plan & billing ---- */

function BillingPane({
  ws,
  isOwner,
  onUpgrade,
  onSynced,
  onToast,
}: {
  ws: WorkspaceDetail
  isOwner: boolean
  onUpgrade: () => void
  onSynced: () => void
  onToast: (message: string) => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const perSeat = ws.interval ? TEAM_SEAT_PRICE[ws.interval] : TEAM_SEAT_PRICE.month
  const paid = ws.plan === 'team' && ws.status !== 'inactive'

  async function portal() {
    if (busy) return
    setBusy(true)
    try {
      posthog.capture('workspace_portal_opened')
      const { url } = await api.workspacePortal(ws.id)
      location.assign(url)
    } catch (caught) {
      onToast(errorMessage(caught, t('workspace.portalFailed')))
      setBusy(false)
    }
  }

  async function sync() {
    if (busy) return
    setBusy(true)
    try {
      await api.syncWorkspaceBilling(ws.id)
      onSynced()
      onToast(t('workspace.upToDate'))
    } catch (caught) {
      onToast(errorMessage(caught, t('workspace.refreshFailed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('workspace.planBilling')}</CardTitle>
        <CardDescription>
          {ws.billing.enabled ? t('workspace.billingDescription') : t('workspace.billingDisabledDescription')}
        </CardDescription>
      </CardHeader>
      <CardRow label={t('workspace.plan')}>
        <b className="text-copy">
          {paid
            ? t('workspace.planTeam')
            : ws.billing.enabled
              ? t('workspace.planPersonal')
              : t('workspace.planSelfHosted')}
        </b>
        {ws.billing.enabled && (
          <Badge
            tone={
              ws.status === 'active' || ws.status === 'trialing'
                ? 'accent'
                : ws.status === 'past_due'
                  ? 'banned'
                  : 'default'
            }
          >
            {t(STATUS_LABEL[ws.status])}
          </Badge>
        )}
        {ws.cancelAtPeriodEnd && ws.currentPeriodEnd && (
          <span className="text-label text-ink-faint">
            {t('workspace.endsOn', { date: dateText(ws.currentPeriodEnd) })}
          </span>
        )}
      </CardRow>
      {paid && (
        <>
          <CardRow label={t('workspace.seats')}>
            <span className="text-copy">
              {t('workspace.seatsMath', { seats: ws.seats, price: formatUsd(perSeat) })}{' '}
              <b>{formatUsd(ws.seats * perSeat)}</b>{' '}
              {ws.interval === 'year' ? t('workspace.perYear') : t('workspace.perMonth')}
            </span>
            {ws.seats !== ws.memberCount && (
              <span className="text-label text-ink-faint">
                {t('workspace.seatsCatchUp', { count: ws.memberCount })}
              </span>
            )}
          </CardRow>
          {ws.currentPeriodEnd && (
            <CardRow label={ws.cancelAtPeriodEnd ? t('workspace.ends') : t('workspace.renews')}>
              <span className="text-copy">{dateText(ws.currentPeriodEnd)}</span>
            </CardRow>
          )}
        </>
      )}
      {ws.billing.enabled && (
        <CardRow label={t('workspace.manage')}>
          {isOwner ? (
            <>
              {!ws.active || !paid ? (
                <Button variant="primary" onClick={onUpgrade}>
                  {ws.status === 'canceled' ? t('workspace.reactivateTeam') : t('workspace.choosePlan')}
                </Button>
              ) : null}
              {ws.billing.portal && (
                <Button onClick={portal} disabled={busy}>
                  {busy ? t('workspace.opening') : t('workspace.manageOnStripe')}
                </Button>
              )}
              {ws.billing.portal && (
                <Button variant="ghost" onClick={sync} disabled={busy}>
                  {t('workspace.refresh')}
                </Button>
              )}
              <span className="text-label text-ink-faint">{t('workspace.stripePortalNote')}</span>
            </>
          ) : (
            <span className="text-body text-ink-soft">{t('workspace.ownerHoldsBilling')}</span>
          )}
        </CardRow>
      )}
    </SettingsCard>
  )
}

/* ---- general ---- */

function GeneralPane({
  ws,
  admin,
  isOwner,
  onChange,
  onToast,
}: {
  ws: WorkspaceDetail
  admin: boolean
  isOwner: boolean
  onChange: () => void
  onToast: (message: string) => void
}) {
  const t = useT()
  const [name, setName] = useState(ws.name)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function rename() {
    const clean = name.trim()
    if (!clean || clean === ws.name || busy) return
    setBusy(true)
    try {
      await api.renameWorkspace(ws.id, clean)
      onChange()
      onToast(t('workspace.renamed'))
    } catch (caught) {
      onToast(errorMessage(caught, t('workspace.renameFailed')))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api.deleteWorkspace(ws.id)
      posthog.capture('workspace_deleted')
      navigate('/')
    } catch (caught) {
      onToast(errorMessage(caught, t('workspace.deleteFailed')))
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('workspace.general')}</CardTitle>
          <CardDescription>{t('workspace.generalDescription')}</CardDescription>
        </CardHeader>
        <CardRow
          label={t('workspace.name')}
          action={
            admin ? (
              <Button size="sm" disabled={busy || !name.trim() || name.trim() === ws.name} onClick={rename}>
                {t('common.save')}
              </Button>
            ) : undefined
          }
        >
          <Input
            variant="well"
            className="max-w-[360px]"
            value={name}
            maxLength={80}
            disabled={!admin || busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && rename()}
            aria-label={t('workspace.workspaceName')}
          />
        </CardRow>
        <CardRow label={t('workspace.created')}>
          <span className="text-body text-ink-soft">{timeAgo(ws.createdAt)}</span>
        </CardRow>
      </SettingsCard>
      {isOwner && (
        <SettingsCard tone="flat" className="border-accent-ink/30">
          <CardHeader>
            <CardTitle className="text-accent-ink">{t('workspace.deleteWorkspace')}</CardTitle>
            <CardDescription>
              {t('workspace.deleteDescription')}
              {ws.billing.enabled && ws.plan ? t('workspace.deleteCancelsTeam') : ''}
            </CardDescription>
          </CardHeader>
          <CardBody>
            <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              {t('workspace.deleteNamed', { name: ws.name })}
            </Button>
          </CardBody>
        </SettingsCard>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('workspace.deleteTitle', { name: ws.name })}
        description={t('workspace.deleteConfirmDescription')}
        confirmLabel={t('workspace.deleteWorkspace')}
        destructive
        onConfirm={() => {
          setConfirmDelete(false)
          void remove()
        }}
      />
    </>
  )
}

/** The roles an admin can hand out; the owner is not one of them. */
function RoleOptions() {
  const t = useT()
  return (
    <SelectContent>
      <SelectItem value="member">{t('workspace.member')}</SelectItem>
      <SelectItem value="admin">{t('workspace.admin')}</SelectItem>
    </SelectContent>
  )
}
