import { useEffect, useState } from 'react'
import type { WorkspaceDetail, WorkspaceSummary } from '../../shared/types'
import { ENTERPRISE_CONTACT, formatUsd, seatPerMonth, TEAM_SEAT_PRICE } from '../../shared/billing'
import type { BillingInterval, Plan } from '../../shared/billing'
import { api, errorMessage, paywalledWorkspace, type PlansResponse } from '../lib/api'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { ArrowRightIcon, CheckIcon } from './ui/icons'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'
import { Segmented, SegmentedItem } from './ui/segmented'
import { Skeleton } from './ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { cn } from '@/lib/utils'
import { useT } from '../lib/i18n'

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

/* ---- the wall ---- */

/** The pricing table, aimed at one workspace. Opens from three places —
 *  right after creating a workspace, from any 402, and from the billing
 *  page — and always ends the same way: a hosted Stripe Checkout. */
export function UpgradeModal({
  workspaceId,
  reason,
  onClose,
}: {
  workspaceId: string
  /** what they were trying to do when the wall came up */
  reason?: string
  onClose: () => void
}) {
  const { data: session } = authClient.useSession()
  const t = useT()
  const [plans, setPlans] = useState<PlansResponse | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null)
  const [interval, setInterval] = useState<BillingInterval>('month')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    posthog.capture('paywall_shown', { workspaceId, reason })
    let live = true
    api.billingPlans().then((p) => live && setPlans(p), console.error)
    api.getWorkspace(workspaceId).then((w) => live && setWorkspace(w), console.error)
    return () => {
      live = false
    }
  }, [workspaceId, reason])

  /* the server can hold one price or both; sell what it has — derived, so a
     missing price never leaves the toggle pointing at something unbuyable */
  const chosen: BillingInterval =
    !plans || plans.intervals.includes(interval) ? interval : (plans.intervals[0] ?? interval)

  /* the owner pays — the Stripe customer is theirs */
  const canBuy = workspace?.role === 'owner'
  const seats = Math.max(1, workspace?.memberCount ?? 1)
  const owner = workspace?.members.find((m) => m.role === 'owner')

  async function checkout() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      posthog.capture('workspace_checkout_started', { workspaceId, interval: chosen, seats })
      const { url } = await api.workspaceCheckout(workspaceId, chosen)
      location.assign(url)
    } catch (caught) {
      setError(errorMessage(caught, t('home.checkoutFailed')))
      setBusy(false)
    }
  }

  const title = workspace
    ? workspace.active
      ? t('home.plansFor', { name: workspace.name })
      : t('home.unlock', { name: workspace.name })
    : t('home.plans')

  return (
    <Modal size="xl" onClose={onClose}>
      <>
        <ModalEyebrow>{t('home.upgradeEyebrow', { price: formatUsd(TEAM_SEAT_PRICE.month) })}</ModalEyebrow>
        <ModalTitle className="mt-2">{title}</ModalTitle>
        <ModalLede>
          {reason ?? t('home.upgradeDefaultReason')} {t('home.upgradeLede')}
        </ModalLede>

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
                      current={plan.id === 'free' && !workspace?.active}
                    />
                  ))
                : [0, 1, 2].map((i) => <Skeleton key={i} index={i} shape="card" />)}
            </div>

            <div className="mt-5 flex flex-col gap-3 rounded-card border border-line bg-paper px-4 py-3.5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 text-body text-ink-soft">
                {workspace ? (
                  <>
                    <b className="text-ink">
                      {t('home.seats', { count: seats, price: formatUsd(TEAM_SEAT_PRICE[chosen]) })}
                    </b>{' '}
                    {chosen === 'year'
                      ? t('home.totalPerYear', { total: formatUsd(seats * TEAM_SEAT_PRICE[chosen]) })
                      : t('home.totalPerMonth', { total: formatUsd(seats * TEAM_SEAT_PRICE[chosen]) })}
                    {workspace.active && workspace.plan ? t('home.alreadyOnTeam') : ''}
                  </>
                ) : (
                  t('home.countingSeats')
                )}
                <span className="mt-0.5 block text-caption text-ink-faint">{t('home.stripeNote')}</span>
              </div>
              {workspace && !canBuy ? (
                <span className="text-body text-ink-soft">
                  {t('home.askOwnerBefore')}{' '}
                  <b className="text-ink">{owner?.name ?? t('home.workspaceOwnerFallback')}</b>{' '}
                  {t('home.askOwnerAfter')}
                </span>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  className="flex-none"
                  disabled={busy || !workspace || !plans || (workspace.active && !!workspace.plan)}
                  onClick={checkout}
                >
                  {busy ? t('home.openingStripe') : t('home.continueCheckout')}
                </Button>
              )}
            </div>
            {error && <p className="mt-2 text-label text-accent-ink">{error}</p>}
            {session?.user.email && (
              <p className="mt-3 text-caption text-ink-faint">
                {t('home.receipts', { email: session.user.email })}{' '}
                <a className="font-semibold text-ink underline underline-offset-2" href={ENTERPRISE_CONTACT}>
                  {t('home.talkToUs')}
                </a>
                {t('home.receiptsEnd')}
              </p>
            )}
          </>
        )}
      </>
    </Modal>
  )
}

function PlanCard({ plan, interval, current }: { plan: Plan; interval: BillingInterval; current: boolean }) {
  const team = plan.id === 'team'
  const price = plan.seatPrice ? plan.seatPrice[interval] : null
  const t = useT()
  return (
    <div
      className={cn(
        'flex flex-col rounded-card border px-4 py-4',
        team ? 'border-brand bg-surface shadow-pop' : 'border-line bg-surface',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-lead font-medium">{plan.name}</span>
        {team && <Badge tone="brand">{t('home.popular')}</Badge>}
        {current && <span className="text-caption text-ink-faint">{t('home.current')}</span>}
      </div>
      <p className="mt-1 text-body text-ink-soft">{plan.tagline}</p>
      <div className="mt-3 text-title font-medium text-ink">
        {price === null ? (
          plan.id === 'free' ? (
            '$0'
          ) : (
            <span className="text-heading">{t('home.letsTalk')}</span>
          )
        ) : (
          <>
            {formatUsd(interval === 'year' ? seatPerMonth('year') : price)}
            <span className="ml-1 font-sans text-label font-medium text-ink-faint">{t('home.perSeatMonth')}</span>
          </>
        )}
      </div>
      {price !== null && interval === 'year' && (
        <span className="text-caption text-ink-faint">{t('home.billedYearly', { price: formatUsd(price) })}</span>
      )}
      <ul className="mt-3.5 flex flex-col gap-[7px] text-body text-ink-soft">
        {plan.features.map((f) => (
          <li key={f} className="flex gap-2">
            <CheckIcon className="mt-[2px] size-3.5 flex-none text-accent-ink" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {plan.id === 'enterprise' && (
        <a
          className="mt-auto flex items-center gap-1 pt-4 text-body font-semibold text-ink underline underline-offset-2"
          href={ENTERPRISE_CONTACT}
        >
          {t('home.contactUs')}
          <ArrowRightIcon size={14} />
        </a>
      )}
    </div>
  )
}

/* ---- move a canvas ---- */

export function MoveCanvasModal({
  canvas,
  workspaces,
  onClose,
  onMoved,
  onPaywall,
}: {
  canvas: { id: string; name: string; workspaceId?: string }
  workspaces: WorkspaceSummary[]
  onClose: () => void
  onMoved: (workspaceId: string | null) => void
  /** the target needs a plan first — the caller opens the wall */
  onPaywall: (workspaceId: string) => void
}) {
  const [target, setTarget] = useState<string>(canvas.workspaceId ?? '')
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
