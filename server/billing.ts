import express from 'express'
import Stripe from 'stripe'
import { PLANS, isBillingInterval, workspaceStatusFrom } from '../shared/billing.ts'
import type { BillingInterval, WorkspaceStatus } from '../shared/billing.ts'

/**
 * The Stripe seam. Everything that talks to Stripe lives here; everything
 * that decides what a subscription MEANS lives in server/workspaces.ts.
 *
 * Off by default: without STRIPE_SECRET_KEY there is nothing to buy and
 * every workspace is active — the self-hosting default. With it, a
 * workspace is a Stripe subscription (per seat, monthly or yearly) and the
 * workspace row mirrors that subscription. Two things write the mirror:
 * the webhook (the durable path) and the post-checkout sync the browser
 * asks for when it lands back from Stripe (so local development works
 * without a tunnel). Both go through the same subscriptionPatch().
 */

const SECRET_KEY = process.env.STRIPE_SECRET_KEY
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
const PRICES: Record<BillingInterval, string | undefined> = {
  month: process.env.STRIPE_PRICE_TEAM_MONTHLY,
  year: process.env.STRIPE_PRICE_TEAM_YEARLY,
}
const ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:4300'

export function billingEnabled(): boolean {
  return !!SECRET_KEY
}

let client: Stripe | null = null
function stripe(): Stripe {
  if (!SECRET_KEY) throw new Error('billing is not configured on this server')
  return (client ??= new Stripe(SECRET_KEY))
}

/** Boot-time sanity: a key without prices can bill nothing. */
export function reportBillingConfig(): void {
  if (!SECRET_KEY) return
  const missing = (Object.keys(PRICES) as BillingInterval[]).filter((k) => !PRICES[k])
  if (missing.length) {
    console.warn(
      `[billing] STRIPE_SECRET_KEY is set but STRIPE_PRICE_TEAM_${missing.map((m) => m.toUpperCase() + 'LY').join(' / STRIPE_PRICE_TEAM_')} is not — checkout for that interval will fail. Run \`node scripts/stripe-setup.mjs\` to create the prices.`,
    )
  }
  if (!WEBHOOK_SECRET) {
    console.warn('[billing] STRIPE_WEBHOOK_SECRET is not set — subscription changes made in Stripe will not sync back')
  }
}

/** What the workspace row learns from a subscription. */
export interface SubscriptionPatch {
  status: WorkspaceStatus
  plan: 'team' | null
  interval: BillingInterval | null
  seats: number
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
  /** when Stripe emitted this state (event.created, or now for a direct
   *  read) — the ordering guard against late deliveries */
  billingEventAt: number
}

export function subscriptionPatch(sub: Stripe.Subscription, at = Math.floor(Date.now() / 1000)): SubscriptionPatch {
  const item = sub.items.data[0]
  const interval = item?.price.recurring?.interval
  /* current_period_end moved from the subscription to its items in the
     2025-03-31 API; read whichever this account's version sends */
  const periodEnd =
    item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end ?? null
  return {
    status: workspaceStatusFrom(sub.status),
    plan: 'team',
    interval: isBillingInterval(interval) ? interval : null,
    seats: item?.quantity ?? 0,
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: periodEnd ? periodEnd * 1000 : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    billingEventAt: at,
  }
}

interface BillableWorkspace {
  id: string
  name: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
}

/** One Stripe customer per workspace, created the first time it is needed. */
export async function ensureCustomer(ws: BillableWorkspace, email: string): Promise<string> {
  if (ws.stripeCustomerId) return ws.stripeCustomerId
  const customer = await stripe().customers.create({
    email,
    name: ws.name,
    metadata: { workspaceId: ws.id },
  })
  return customer.id
}

/** A Checkout Session for a per-seat Team subscription. The workspace id
 *  rides in the subscription's metadata, which is how the webhook finds the
 *  row again for every later event. */
export async function createCheckout(
  ws: BillableWorkspace & { stripeCustomerId: string },
  interval: BillingInterval,
  seats: number,
): Promise<string> {
  const price = PRICES[interval]
  if (!price) throw new Error(`no Stripe price configured for ${interval}ly billing`)
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: ws.stripeCustomerId,
    line_items: [{ price, quantity: Math.max(1, seats) }],
    subscription_data: { metadata: { workspaceId: ws.id } },
    metadata: { workspaceId: ws.id },
    allow_promotion_codes: true,
    success_url: `${ORIGIN}/w/${ws.id}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${ORIGIN}/w/${ws.id}?checkout=canceled`,
  })
  if (!session.url) throw new Error('Stripe returned no checkout URL')
  return session.url
}

/** The Stripe-hosted billing portal: cards, invoices, cancel, switch interval. */
export async function createPortal(ws: BillableWorkspace & { stripeCustomerId: string }): Promise<string> {
  const session = await stripe().billingPortal.sessions.create({
    customer: ws.stripeCustomerId,
    return_url: `${ORIGIN}/w/${ws.id}`,
  })
  return session.url
}

/** Re-read the subscription: after checkout (by the session the browser
 *  came back with) or on demand (by the id the row already holds). */
export async function fetchSubscription(
  ws: BillableWorkspace,
  checkoutSessionId?: string,
): Promise<SubscriptionPatch | null> {
  let subscriptionId = ws.stripeSubscriptionId
  if (checkoutSessionId) {
    const session = await stripe().checkout.sessions.retrieve(checkoutSessionId)
    /* a session for another workspace proves nothing about this one */
    if (session.metadata?.workspaceId !== ws.id) return null
    const sub = session.subscription
    subscriptionId = typeof sub === 'string' ? sub : (sub?.id ?? subscriptionId)
  }
  if (!subscriptionId) return null
  const sub = await stripe().subscriptions.retrieve(subscriptionId)
  if (sub.metadata?.workspaceId && sub.metadata.workspaceId !== ws.id) return null
  return subscriptionPatch(sub)
}

/** Keep the billed quantity equal to the member count. Stripe prorates the
 *  difference on the next invoice. Silently nothing without a live
 *  subscription — a workspace that never paid has no quantity to keep. */
export async function syncSeats(ws: BillableWorkspace, seats: number): Promise<void> {
  if (!ws.stripeSubscriptionId) return
  const sub = await stripe().subscriptions.retrieve(ws.stripeSubscriptionId)
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return
  const item = sub.items.data[0]
  if (!item || item.quantity === seats) return
  await stripe().subscriptionItems.update(item.id, { quantity: Math.max(1, seats) })
}

/** Deleting a workspace ends its subscription now — nobody should keep
 *  paying for a thing that no longer exists. */
export async function cancelSubscription(ws: BillableWorkspace): Promise<void> {
  if (!ws.stripeSubscriptionId) return
  await cancelSubscriptionById(ws.stripeSubscriptionId)
}

export async function cancelSubscriptionById(id: string): Promise<void> {
  try {
    await stripe().subscriptions.cancel(id)
  } catch (err) {
    /* already gone on Stripe's side is the outcome we wanted */
    if (!(err instanceof Stripe.errors.StripeError && err.code === 'resource_missing')) throw err
  }
}

/** Verify a webhook delivery. Throws on a bad signature; the caller answers 400. */
export function parseWebhook(rawBody: Buffer, signature: string | undefined): Stripe.Event {
  if (!WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not set')
  if (!signature) throw new Error('missing stripe-signature header')
  return stripe().webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET)
}

export function webhookConfigured(): boolean {
  return !!SECRET_KEY && !!WEBHOOK_SECRET
}

/** The subscription an event is about, with the workspace it belongs to.
 *  checkout.session.completed needs one round-trip to Stripe for the
 *  subscription object; the subscription.* events carry it inline. */
export async function subscriptionFromEvent(
  event: Stripe.Event,
): Promise<{ workspaceId: string; patch: SubscriptionPatch } | null> {
  let sub: Stripe.Subscription | null = null
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      sub = event.data.object
      break
    case 'checkout.session.completed': {
      const session = event.data.object
      const id = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id
      if (id) sub = await stripe().subscriptions.retrieve(id)
      break
    }
    default:
      return null
  }
  const workspaceId = sub?.metadata?.workspaceId
  if (!sub || !workspaceId) return null
  return { workspaceId, patch: subscriptionPatch(sub, event.created) }
}

/* ------------------------------------------------------------------ */
/* /api/billing — the catalogue, for the pricing modal                 */
/* ------------------------------------------------------------------ */

export const billingRouter = express.Router()

billingRouter.get('/plans', (_req, res) => {
  res.json({
    enabled: billingEnabled(),
    plans: PLANS,
    /* which intervals can actually be bought here */
    intervals: (Object.keys(PRICES) as BillingInterval[]).filter((k) => !!PRICES[k]),
  })
})
