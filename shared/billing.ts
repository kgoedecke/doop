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

/** A plan's id and price. What each plan offers is copy, kept in the
 *  client's `plans` catalog (src/lib/i18n) so it can be translated and can
 *  name hosted-only features without this file doing so. */
export interface Plan {
  id: PlanId
  name: string
  /** USD cents per seat per interval; absent on plans that are not self-serve */
  seatPrice?: Record<BillingInterval, number>
}

/** $20 a seat a month, or $192 a seat a year (two months free). */
export const TEAM_SEAT_PRICE: Record<BillingInterval, number> = { month: 2000, year: 19200 }

/** The most seats one checkout or seat change asks for; past that is Enterprise. */
export const MAX_SEATS = 500

/** A seat count someone asked for, or null when it is not one. */
export function parseSeats(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SEATS ? value : null
}

/** What Stripe bills: the seats bought, or the people in the workspace when
 *  there are more of them. Invites fill bought seats first. */
export function billedSeats(seatsBought: number, memberCount: number): number {
  return Math.max(1, seatsBought, memberCount)
}

/* The paid plan is sold as Pro; its id stays 'team', which Stripe metadata,
   the workspaces table and /api/me already carry. */
export const PLANS: readonly Plan[] = [
  { id: 'free', name: 'Free' },
  { id: 'team', name: 'Pro', seatPrice: TEAM_SEAT_PRICE },
  { id: 'enterprise', name: 'Enterprise' },
]

/** The largest image upload on Free, and on Pro (or with billing off). */
export const FREE_UPLOAD_BYTES = 5 * 1024 * 1024
export const PRO_UPLOAD_BYTES = 100 * 1024 * 1024

/** Font families a library holds on Free; Pro has no limit. */
export const FREE_FONT_FAMILIES = 2

/** Where paying customers write for priority support. */
export const PRIORITY_SUPPORT = 'mailto:hello@doop.design?subject=Doop%20Pro%20support'

/** Enterprise and "Talk to us": a 15-minute call on Kevin's calendar, as on doop.design/pricing. */
export const ENTERPRISE_CONTACT = 'https://cal.com/kevin-goedecke-claogi/15min'

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
