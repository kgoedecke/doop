/**
 * Plans and subscription vocabulary, shared by the server (Stripe glue,
 * entitlement checks) and the client (pricing modal, billing page).
 *
 * The product is simple on purpose: personal use is free, a shared
 * workspace is the paid thing, and it is priced per seat. Prices live here
 * as display data only — Stripe is the source of truth for what is charged,
 * through the price ids the server reads from its environment.
 */

export type WorkspaceStatus = 'inactive' | 'trialing' | 'active' | 'past_due' | 'canceled'
export type BillingInterval = 'month' | 'year'
export type PlanId = 'free' | 'team' | 'enterprise'

export interface Plan {
  id: PlanId
  name: string
  tagline: string
  /** USD cents per seat per interval; absent on plans that are not self-serve */
  seatPrice?: Record<BillingInterval, number>
  features: string[]
}

/** $20 a seat a month, or $192 a seat a year (two months free). */
export const TEAM_SEAT_PRICE: Record<BillingInterval, number> = { month: 2000, year: 19200 }

export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Personal',
    tagline: 'For you and your agents.',
    features: [
      'Unlimited personal canvases',
      'Invite collaborators per canvas',
      'AI agents over MCP and the Doop Agent',
      'Community gallery, imports, design memory',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    tagline: 'A shared workspace for your whole org.',
    seatPrice: TEAM_SEAT_PRICE,
    features: [
      'Shared workspaces — every member opens every canvas',
      'Roles: owner, admin, member',
      'Invite by email, seats billed as people join',
      'Move canvases between personal and workspace',
      'Everything in Personal',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Self-host it, or let us run it for you.',
    features: ['SSO (OIDC), Google and Microsoft sign-in', 'Dedicated support', 'Custom terms and invoicing'],
  },
]

export const TEAM_PLAN = PLANS.find((p) => p.id === 'team')!

export const ENTERPRISE_CONTACT = 'mailto:hello@doop.design?subject=Doop%20Enterprise'

/** A workspace whose members may grow it: create canvases in it, invite
 *  people, move canvases in. past_due counts — Stripe is retrying the card,
 *  and locking a team out over a failed charge is the wrong first move. */
export function isWorkspaceActive(status: WorkspaceStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due'
}

/** Stripe's subscription statuses folded into the five the product knows. */
export function workspaceStatusFrom(stripeStatus: string): WorkspaceStatus {
  switch (stripeStatus) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled'
    default:
      /* 'incomplete' and 'paused': nothing is paid for yet */
      return 'inactive'
  }
}

export const STATUS_LABELS: Record<WorkspaceStatus, string> = {
  inactive: 'No plan yet',
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment failed',
  canceled: 'Canceled',
}

/** "$20" / "$16.50" — whole dollars stay whole. */
export function formatUsd(cents: number): string {
  const dollars = cents / 100
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

/** What a seat costs per month on a given interval, for the comparison line. */
export function seatPerMonth(interval: BillingInterval): number {
  return interval === 'year' ? Math.round(TEAM_SEAT_PRICE.year / 12) : TEAM_SEAT_PRICE.month
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === 'month' || value === 'year'
}
