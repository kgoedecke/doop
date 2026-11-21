import { useEffect, useState } from 'react'
import type { WorkspaceDetail, WorkspaceSummary } from '../../shared/types'
import { billedSeats, formatUsd, seatPerMonth, TEAM_SEAT_PRICE } from '../../shared/billing'
import type { BillingInterval } from '../../shared/billing'
import { api, errorMessage, paywalledWorkspace, type PlansResponse } from '../lib/api'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'
import { Segmented, SegmentedItem } from './ui/segmented'
import { Skeleton } from './ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { useT } from '../lib/i18n'
import { navigate } from '../lib/navigate'
import { noteNameAfterCheckout } from '../lib/upgrade'
import { PlanCard, PlanComparison } from './PlanCards'
import { SeatStepper } from './SeatStepper'

/**
 * The workspace dialogs every page shares: creating one, the upgrade wall
 * (the pricing table, pointed at one workspace), and moving a canvas in or
 * out. The wall is what a 402 from the server turns into — see
 * paywalledWorkspace in lib/api.
 */

/** The Personal choice in a workspace picker. Radix Select keeps the empty
 *  string for "nothing chosen", so "no workspace" needs a value of its own;
 *  it is mapped back to '' (and to null on the wire) at the picker. */
export const PERSONAL_WORKSPACE = '__personal__'

/* ---- create ---- */

export function CreateWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  /** the new workspace; `active` false means the plan picker should follow */
  onCreated: (workspace: WorkspaceSummary) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()

  async function create() {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    setError(null)
    try {
      const ws = await api.createWorkspace(clean)
      posthog.capture('workspace_created', { active: ws.active })
      onCreated(ws)
    } catch (caught) {
      setError(errorMessage(caught, t('home.createWorkspaceFailed')))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalEyebrow>{t('home.workspacesEyebrow')}</ModalEyebrow>
        <ModalTitle className="mt-2">{t('home.nameWorkspace')}</ModalTitle>
        <ModalLede>{t('home.createWorkspaceLede')}</ModalLede>
        <Input
          variant="well"
          className="mt-5"
          autoFocus
          placeholder="Acme Design"
          value={name}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && create()}
          aria-label={t('home.workspaceNameAria')}
        />
        {error && <p className="mt-2 text-label text-accent-ink">{error}</p>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={create} disabled={busy || !name.trim()}>
            {busy ? t('home.creating') : t('home.createWorkspace')}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/* ---- name it, once Pro is paid ---- */

/** Asked on the Workspace page when checkout comes back paid for a
 *  workspace the upgrade modal made with a placeholder name. */
export function NameWorkspaceModal({
  workspace,
  onClose,
}: {
  workspace: { id: string; name: string }
  onClose: () => void
}) {
  const [name, setName] = useState(workspace.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()
  const clean = name.trim()

  async function save() {
    if (!clean || busy) return
    if (clean === workspace.name) return onClose()
    setBusy(true)
    setError(null)
    try {
      await api.renameWorkspace(workspace.id, clean)
      onClose()
    } catch (caught) {
      setError(errorMessage(caught, t('workspace.renameFailed')))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalTitle>{t('plans.nameTitle')}</ModalTitle>
        <ModalLede>{t('plans.nameLede')}</ModalLede>
        <Input
          variant="well"
          className="mt-5"
          autoFocus
          value={name}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && save()}
          aria-label={t('plans.workspaceName')}
        />
        {error && <p className="mt-2 text-label text-accent-ink">{error}</p>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            {t('plans.nameSkip')}
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || !clean}>
            {t('plans.nameSave')}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/* ---- the wall ---- */

/** The pricing table. With a workspace it is aimed at that one (right after
 *  creating it, from any 402, from its billing page). Without one it is
 *  "Upgrade to Pro" from anywhere: it finds the workspace the person already
 *  pays through, or one of theirs still without a plan, or names a new one
 *  that checkout creates. It always ends the same way: a hosted Stripe
 *  Checkout. */
export function UpgradeModal({
  workspaceId: pinned,
  reason,
  onClose,
  onCheckout,
}: {
  workspaceId?: string
  /** what they were trying to do when the wall came up */
  reason?: string
  onClose: () => void
  /** checkout is about to leave the page: the last moment to note what to come back to */
  onCheckout?: () => void
}) {
  const { data: session } = authClient.useSession()
  const t = useT()
  const [plans, setPlans] = useState<PlansResponse | null>(null)
  /* the person's workspaces, read only when no workspace was named */
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null)
  const [interval, setInterval] = useState<BillingInterval>('month')
  /* seats picked in the stepper; null until touched */
  const [picked, setPicked] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    posthog.capture('paywall_shown', { workspaceId: pinned, reason })
    let live = true
    api.billingPlans().then((p) => live && setPlans(p), console.error)
    if (!pinned) api.listWorkspaces().then((r) => live && setWorkspaces(r.workspaces), console.error)
    return () => {
      live = false
    }
  }, [pinned, reason])

  /* already paying through a workspace: nothing to buy here */
  const proThrough = pinned ? undefined : workspaces?.find((w) => w.active && w.plan === 'team')
  /* a workspace of theirs that never had a plan is the one to pay for. A
     canceled one is not: reactivating it bills its old team, which is a choice
     made on that workspace's own billing page, not here. */
  const unpaid =
    pinned || proThrough ? undefined : workspaces?.find((w) => w.role === 'owner' && w.status === 'inactive')
  const targetId = pinned ?? unpaid?.id
  const naming = !pinned && !!workspaces && !proThrough && !unpaid

  useEffect(() => {
    if (!targetId) return
    let live = true
    api.getWorkspace(targetId).then((w) => live && setWorkspace(w), console.error)
    return () => {
      live = false
    }
  }, [targetId])
  const target = workspace && workspace.id === targetId ? workspace : null

  /* the server can hold one price or both; sell what it has — derived, so a
     missing price never leaves the toggle pointing at something unbuyable */
  const chosen: BillingInterval =
    !plans || plans.intervals.includes(interval) ? interval : (plans.intervals[0] ?? interval)

  /* the owner pays — the Stripe customer is theirs */
  const canBuy = naming || target?.role === 'owner'
  /* the people already in it: the fewest seats there can be */
  const people = naming ? 1 : Math.max(1, target?.memberCount ?? 1)
  const seats = billedSeats(picked ?? target?.seatsBought ?? 1, people)
  const owner = target?.members.find((m) => m.role === 'owner')
  const firstName = session?.user.name?.split(' ')[0] || session?.user.email?.split('@')[0] || ''
  /* a placeholder: the Workspace page asks for the real name once checkout is paid */
  const workspaceName = firstName
    ? t('plans.defaultWorkspaceName', { name: firstName })
    : t('plans.fallbackWorkspaceName')
  const ready = naming || !!target
  const alreadyPaid = !!target?.active && !!target.plan

  async function checkout() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      let id = target?.id
      if (!id) {
        const created = await api.createWorkspace(workspaceName)
        posthog.capture('workspace_created', { active: created.active, via: 'upgrade' })
        noteNameAfterCheckout(created.id)
        /* a checkout that fails from here pays for this one on the next try */
        setWorkspaces((list) => [...(list ?? []), created])
        id = created.id
      }
      posthog.capture('workspace_checkout_started', { workspaceId: id, interval: chosen, seats })
      const { url } = await api.workspaceCheckout(id, chosen, seats)
      onCheckout?.()
      location.assign(url)
    } catch (caught) {
      setError(errorMessage(caught, t('home.checkoutFailed')))
      setBusy(false)
    }
  }

  const title = pinned
    ? target
      ? target.active
        ? t('home.plansFor', { name: target.name })
        : t('home.unlock', { name: target.name })
      : t('home.plans')
    : proThrough
      ? t('home.plans')
      : t('plans.upgradeTitle')

  const lede = reason
    ? `${reason} ${t('home.upgradeLede')}`
    : pinned
      ? `${t('home.upgradeDefaultReason')} ${t('home.upgradeLede')}`
      : t('plans.upgradeLede')

  return (
    <Modal size="xl" onClose={onClose}>
      <>
        <ModalTitle>{title}</ModalTitle>
        <ModalLede>{lede}</ModalLede>

        {plans && !plans.enabled ? (
          <Callout tone="success" className="mt-5">
            {t('home.billingOff')}
          </Callout>
        ) : (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Segmented value={chosen} onValueChange={(next) => next && setInterval(next as BillingInterval)}>
                <SegmentedItem value="month" disabled={!!plans && !plans.intervals.includes('month')}>
                  {t('home.monthly')}
                </SegmentedItem>
                <SegmentedItem value="year" disabled={!!plans && !plans.intervals.includes('year')}>
                  {t('home.yearly')} <span className="ml-1 text-accent-ink">−20%</span>
                </SegmentedItem>
              </Segmented>
              <span className="text-label text-ink-faint">
                {chosen === 'year'
                  ? t('home.yearlyPrice', {
                      perMonth: formatUsd(seatPerMonth('year')),
                      perYear: formatUsd(TEAM_SEAT_PRICE.year),
                    })
                  : t('home.monthlyPrice', { price: formatUsd(TEAM_SEAT_PRICE.month) })}
              </span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {plans
                ? plans.plans.map((plan) => (
                    <PlanCard
                      key={plan.id}
                      plan={plan}
                      interval={chosen}
                      current={
                        plan.id === 'team'
                          ? !!proThrough || alreadyPaid
                          : plan.id === 'free' && !proThrough && !target?.active
                      }
                    />
                  ))
                : [0, 1, 2].map((i) => <Skeleton key={i} index={i} shape="card" />)}
            </div>

            <PlanComparison className="mt-4" />

            {proThrough ? (
              <div className="mt-5 flex flex-col gap-3 rounded-card border border-line bg-paper px-4 py-3.5 sm:flex-row sm:items-center">
                <span className="min-w-0 flex-1 text-body text-ink-soft">
                  {t('plans.onProThrough', { name: proThrough.name })}
                </span>
                {proThrough.role !== 'member' && (
                  <Button
                    className="flex-none"
                    onClick={() => {
                      onClose()
                      navigate(`/w/${proThrough.id}?pane=billing`)
                    }}
                  >
                    {t('plans.manageBilling')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="mt-5 flex flex-col gap-3 rounded-card border border-line bg-paper px-4 py-3.5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1 text-body text-ink-soft">
                  {naming || target ? (
                    <>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {canBuy && !alreadyPaid ? (
                          <SeatStepper value={seats} min={people} disabled={busy} onChange={setPicked} />
                        ) : (
                          <b className="text-ink">{seats}</b>
                        )}
                        <b className="text-ink">
                          {t('plans.seatsTimes', { count: seats, price: formatUsd(TEAM_SEAT_PRICE[chosen]) })}
                        </b>
                        <span>
                          {chosen === 'year'
                            ? t('home.totalPerYear', { total: formatUsd(seats * TEAM_SEAT_PRICE[chosen]) })
                            : t('home.totalPerMonth', { total: formatUsd(seats * TEAM_SEAT_PRICE[chosen]) })}
                          {alreadyPaid ? t('home.alreadyOnTeam') : ''}
                        </span>
                      </span>
                      {canBuy && !alreadyPaid && (
                        <span className="mt-1 block text-caption text-ink-faint">{t('plans.seatsHint')}</span>
                      )}
                    </>
                  ) : (
                    t('home.countingSeats')
                  )}
                  <span className="mt-0.5 block text-caption text-ink-faint">{t('home.stripeNote')}</span>
                </div>
                {target && !canBuy ? (
                  <span className="text-body text-ink-soft">
                    {t('home.askOwnerBefore')}{' '}
                    <b className="text-ink">{owner?.name ?? t('home.workspaceOwnerFallback')}</b>{' '}
                    {t('home.askOwnerAfter')}
                  </span>
                ) : (
                  <Button
                    variant="primary"
                    size="lg"
                    className="flex-none sm:self-end"
                    disabled={busy || !ready || !plans || alreadyPaid}
                    onClick={checkout}
                  >
                    {busy ? t('home.openingStripe') : t('home.continueCheckout')}
                  </Button>
                )}
              </div>
            )}
            {error && <p className="mt-2 text-label text-accent-ink">{error}</p>}
          </>
        )}
      </>
    </Modal>
  )
}

/* ---- move a canvas ---- */

export function MoveCanvasModal({
  canvas,
  workspaces,
  suggested,
  onClose,
  onMoved,
  onPaywall,
}: {
  canvas: { id: string; name: string; workspaceId?: string }
  workspaces: WorkspaceSummary[]
  /** the destination to start on, when the caller knows where this is headed
   *  (the library card moves a personal canvas into a workspace) */
  suggested?: string
  onClose: () => void
  onMoved: (workspaceId: string | null) => void
  /** the target needs a plan first — the caller opens the wall */
  onPaywall: (workspaceId: string) => void
}) {
  const [target, setTarget] = useState<string>(suggested ?? canvas.workspaceId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targetWs = workspaces.find((w) => w.id === target)
  const t = useT()

  async function move() {
    if (busy) return
    setBusy(true)
    setError(null)
    const workspaceId = target || null
    try {
      await api.moveCanvas(canvas.id, workspaceId)
      posthog.capture('canvas_moved', { into: !!workspaceId })
      onMoved(workspaceId)
    } catch (caught) {
      const walled = paywalledWorkspace(caught)
      if (walled) onPaywall(walled)
      else setError(errorMessage(caught, t('home.moveFailed')))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalTitle>{t('home.moveTitle', { name: canvas.name })}</ModalTitle>
        <ModalLede>{t('home.moveLede')}</ModalLede>
        <Select
          value={target || PERSONAL_WORKSPACE}
          disabled={busy}
          onValueChange={(value) => setTarget(value === PERSONAL_WORKSPACE ? '' : value)}
        >
          <SelectTrigger className="mt-5 w-full" aria-label={t('home.destinationAria')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PERSONAL_WORKSPACE}>{t('home.personalOption')}</SelectItem>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
                {w.active ? '' : t('home.needsPlanSuffix')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {targetWs && !targetWs.active && (
          <p className="mt-2 text-label text-ink-faint">{t('home.targetNoPlan', { name: targetWs.name })}</p>
        )}
        {error && <p className="mt-2 text-label text-accent-ink">{error}</p>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={move} disabled={busy || (target || '') === (canvas.workspaceId ?? '')}>
            {busy ? t('home.moving') : t('home.moveCanvas')}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}
