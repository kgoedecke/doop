import { useEffect, useState } from 'react'
import type { WorkspaceDetail, WorkspaceSummary } from '../../shared/types'
import { ENTERPRISE_CONTACT, formatUsd, seatPerMonth, TEAM_SEAT_PRICE } from '../../shared/billing'
import type { BillingInterval, Plan } from '../../shared/billing'
import { api, errorMessage, paywalledWorkspace, type PlansResponse } from '../lib/api'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { Button } from './ui/button'
import { Callout } from './ui/callout'
import { CheckIcon, XIcon } from './ui/icons'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from './ui/modal'
import { Segmented, SegmentedItem } from './ui/segmented'
import { Skeleton } from './ui/skeleton'
import { Sel } from './AutomateShell'
import { cn } from '@/lib/utils'

/**
 * The workspace dialogs every page shares: creating one, the upgrade wall
 * (the pricing table, pointed at one workspace), and moving a canvas in or
 * out. The wall is what a 402 from the server turns into — see
 * paywalledWorkspace in lib/api.
 */

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
      setError(errorMessage(caught, 'Couldn’t create the workspace'))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalEyebrow>Workspaces</ModalEyebrow>
        <ModalTitle className="mt-2">Name your workspace</ModalTitle>
        <ModalLede>
          A workspace is your team’s shared home: everyone in it can open every canvas inside. You can move existing
          canvases in afterwards.
        </ModalLede>
        <Input
          className="mt-5 rounded-[10px] bg-paper focus:ring-0"
          autoFocus
          placeholder="Acme Design"
          value={name}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && create()}
          aria-label="Workspace name"
        />
        {error && <p className="mt-2 text-[12px] text-accent-ink">{error}</p>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create workspace'}
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
      setError(errorMessage(caught, 'Couldn’t start checkout'))
      setBusy(false)
    }
  }

  const title = workspace ? (workspace.active ? `Plans for ${workspace.name}` : `Unlock ${workspace.name}`) : 'Plans'

  return (
    <Modal size="xl" onClose={onClose}>
      <>
        <div className="flex items-start justify-between gap-3">
          <div>
            <ModalEyebrow>Team plan · {formatUsd(TEAM_SEAT_PRICE.month)} per seat per month</ModalEyebrow>
            <ModalTitle className="mt-2">{title}</ModalTitle>
          </div>
          <Button variant="ghost" size="icon" className="size-10 flex-none" aria-label="Close" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <ModalLede>
          {reason ?? 'Shared workspaces are the paid part of doop.'} Everyone in a workspace opens every canvas in it —
          no per-canvas invites, no links to pass around. Seats are billed as people join and refunded as they leave.
        </ModalLede>

        {plans && !plans.enabled ? (
          <Callout tone="success" className="mt-5">
            Billing isn’t set up on this server, so workspaces are included. Nothing to buy — go make one.
          </Callout>
        ) : (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Segmented value={chosen} onValueChange={(next) => next && setInterval(next as BillingInterval)}>
                <SegmentedItem value="month" disabled={!!plans && !plans.intervals.includes('month')}>
                  Monthly
                </SegmentedItem>
                <SegmentedItem value="year" disabled={!!plans && !plans.intervals.includes('year')}>
                  Yearly <span className="ml-1 text-accent-ink">−20%</span>
                </SegmentedItem>
              </Segmented>
              <span className="text-[12px] text-ink-faint">
                {chosen === 'year'
                  ? `${formatUsd(seatPerMonth('year'))} a seat a month, billed ${formatUsd(TEAM_SEAT_PRICE.year)} a year`
                  : `${formatUsd(TEAM_SEAT_PRICE.month)} a seat, billed monthly`}
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
                : [0, 1, 2].map((i) => <Skeleton key={i} index={i} className="min-h-[220px] rounded-[12px]" />)}
            </div>

            <div className="mt-5 flex flex-col gap-3 rounded-[12px] border border-line bg-paper px-4 py-3.5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 text-[13px] leading-[1.5] text-ink-soft">
                {workspace ? (
                  <>
                    <b className="text-ink">
                      {seats} seat{seats === 1 ? '' : 's'} × {formatUsd(TEAM_SEAT_PRICE[chosen])}
                    </b>{' '}
                    = {formatUsd(seats * TEAM_SEAT_PRICE[chosen])} per {chosen}
                    {workspace.active && workspace.plan ? ' — already on Team; manage it from Billing.' : ''}
                  </>
                ) : (
                  'Counting seats…'
                )}
                <span className="mt-0.5 block text-[11.5px] text-ink-faint">
                  You’ll set up payment on Stripe’s secure checkout. Cancel any time from the billing portal.
                </span>
              </div>
              {workspace && !canBuy ? (
                <span className="text-[12.5px] text-ink-soft">
                  Ask <b className="text-ink">{owner?.name ?? 'the workspace owner'}</b> to choose a plan — the owner
                  holds the billing.
                </span>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  className="flex-none"
                  disabled={busy || !workspace || !plans || (workspace.active && !!workspace.plan)}
                  onClick={checkout}
                >
                  {busy ? 'Opening Stripe…' : 'Continue to checkout'}
                </Button>
              )}
            </div>
            {error && <p className="mt-2 text-[12px] text-accent-ink">{error}</p>}
            {session?.user.email && (
              <p className="mt-3 text-[11.5px] text-ink-faint">
                Receipts go to {session.user.email}. Need invoicing, SSO or a bigger team?{' '}
                <a className="font-semibold text-ink underline underline-offset-2" href={ENTERPRISE_CONTACT}>
                  Talk to us
                </a>
                .
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
  return (
    <div
      className={cn(
        'flex flex-col rounded-[12px] border px-4 py-4',
        team ? 'border-brand bg-surface shadow-pop' : 'border-line bg-surface',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-display text-[15px] font-extrabold tracking-[-0.01em]">{plan.name}</span>
        {team && (
          <span className="rounded-md bg-brand px-[7px] py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-white">
            Popular
          </span>
        )}
        {current && <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">Current</span>}
      </div>
      <p className="mt-1 text-[12.5px] leading-[1.45] text-ink-soft">{plan.tagline}</p>
      <div className="mt-3 font-display text-[26px] font-extrabold tracking-[-0.03em] text-ink">
        {price === null ? (
          plan.id === 'free' ? (
            '$0'
          ) : (
            <span className="text-[20px]">Let’s talk</span>
          )
        ) : (
          <>
            {formatUsd(interval === 'year' ? seatPerMonth('year') : price)}
            <span className="ml-1 font-sans text-[12px] font-medium text-ink-faint">/ seat / month</span>
          </>
        )}
      </div>
      {price !== null && interval === 'year' && (
        <span className="text-[11.5px] text-ink-faint">billed {formatUsd(price)} a seat yearly</span>
      )}
      <ul className="mt-3.5 flex flex-col gap-[7px] text-[12.5px] leading-[1.4] text-ink-soft">
        {plan.features.map((f) => (
          <li key={f} className="flex gap-2">
            <CheckIcon className="mt-[2px] size-3.5 flex-none text-accent-ink" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {plan.id === 'enterprise' && (
        <a
          className="mt-auto pt-4 text-[12.5px] font-semibold text-ink underline underline-offset-2"
          href={ENTERPRISE_CONTACT}
        >
          Contact us →
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
      else setError(errorMessage(caught, 'Couldn’t move the canvas'))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalTitle>Move “{canvas.name}”</ModalTitle>
        <ModalLede>
          A canvas in a workspace is open to everyone in it. Move it back to Personal and only you and the people you
          invited keep access.
        </ModalLede>
        <Sel
          className="mt-5 w-full"
          value={target}
          disabled={busy}
          onChange={(event) => setTarget(event.target.value)}
          aria-label="Destination"
        >
          <option value="">Personal — just you and invitees</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.active ? '' : ' (needs a plan)'}
            </option>
          ))}
        </Sel>
        {targetWs && !targetWs.active && (
          <p className="mt-2 text-[12px] text-ink-faint">
            {targetWs.name} has no plan yet — you’ll be asked to choose one.
          </p>
        )}
        {error && <p className="mt-2 text-[12px] text-accent-ink">{error}</p>}
        <ModalActions>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={move} disabled={busy || (target || '') === (canvas.workspaceId ?? '')}>
            {busy ? 'Moving…' : 'Move canvas'}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}
