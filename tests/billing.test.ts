import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { Client, startServer, type Server } from './harness.ts'
import { isWorkspaceActive, workspaceStatusFrom, TEAM_SEAT_PRICE, seatPerMonth, formatUsd } from '../shared/billing.ts'

/**
 * Billing-gated workspaces: with Stripe configured a fresh workspace cannot
 * grow until a subscription exists. The subscription arrives the way it
 * does in production — a signed webhook — built here with Stripe's own
 * test-signature helper, so nothing touches the network.
 */

const PORT = 4998
const WEBHOOK_SECRET = 'whsec_test_doop'

let server: Server

beforeAll(async () => {
  server = await startServer(PORT, {
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
    STRIPE_SECRET_KEY: 'sk_test_doop_fake',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_TEAM_MONTHLY: 'price_month',
    STRIPE_PRICE_TEAM_YEARLY: 'price_year',
  })
}, 70_000)

afterAll(() => server?.stop())

describe('plan catalogue', () => {
  it('prices a seat at roughly $20 a month', () => {
    expect(TEAM_SEAT_PRICE.month).toBe(2000)
    expect(seatPerMonth('year')).toBe(1600)
    expect(formatUsd(2000)).toBe('$20')
    expect(formatUsd(1650)).toBe('$16.50')
  })

  it('folds Stripe statuses into the product’s', () => {
    expect(workspaceStatusFrom('active')).toBe('active')
    expect(workspaceStatusFrom('trialing')).toBe('trialing')
    expect(workspaceStatusFrom('past_due')).toBe('past_due')
    expect(workspaceStatusFrom('unpaid')).toBe('past_due')
    expect(workspaceStatusFrom('canceled')).toBe('canceled')
    expect(workspaceStatusFrom('incomplete')).toBe('inactive')
    expect(isWorkspaceActive('past_due')).toBe(true)
    expect(isWorkspaceActive('canceled')).toBe(false)
  })
})

/** A subscription event as Stripe would deliver it, signed with the test secret. */
function subscriptionEvent(
  id: string,
  type: string,
  created: number,
  sub: { workspaceId: string; status: string; seats?: number; periodEnd?: number; subId?: string },
) {
  const items = sub.seats
    ? [
        {
          id: 'si_test_1',
          object: 'subscription_item',
          quantity: sub.seats,
          current_period_end: sub.periodEnd,
          price: { id: 'price_month', object: 'price', recurring: { interval: 'month' } },
        },
      ]
    : []
  const payload = JSON.stringify({
    id,
    object: 'event',
    type,
    created,
    data: {
      object: {
        id: sub.subId ?? 'sub_test_1',
        object: 'subscription',
        status: sub.status,
        customer: 'cus_test_1',
        cancel_at_period_end: false,
        metadata: { workspaceId: sub.workspaceId },
        items: { object: 'list', data: items },
      },
    },
  })
  const stripe = new Stripe('sk_test_doop_fake')
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
  return fetch(`${server.base}/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: payload,
  })
}

describe('workspaces behind Stripe', () => {
  let owner: Client
  let mate: Client
  let workspaceId: string
  const t0 = Math.floor(Date.now() / 1000)

  beforeAll(async () => {
    owner = new Client(server)
    mate = new Client(server)
    await owner.signUp('bill-owner@test.dev', 'Owner')
    await mate.signUp('bill-mate@test.dev', 'Mate')
  })

  it('reports billing as enabled with both intervals', async () => {
    const plans = await (await owner.get('/api/billing/plans')).json()
    expect(plans.enabled).toBe(true)
    expect(plans.intervals).toEqual(['month', 'year'])
    expect(plans.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'team', 'enterprise'])
  })

  it('a new workspace is a shell: it cannot grow until paid', async () => {
    const ws = await (await owner.post('/api/workspaces', { name: 'Paid Co' })).json()
    workspaceId = ws.id
    expect(ws.active).toBe(false)
    expect(ws.status).toBe('inactive')

    const invite = await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'bill-mate@test.dev' })
    expect(invite.status).toBe(402)
    expect((await invite.json()).error).toBe('workspace_plan_required')
    const create = await owner.post('/api/canvases', { name: 'Nope', workspaceId })
    expect(create.status).toBe(402)
    const personal = await (await owner.post('/api/canvases', { name: 'Mine' })).json()
    const move = await owner.req(`/api/canvases/${personal.id}/workspace`, {
      method: 'PUT',
      body: JSON.stringify({ workspaceId }),
    })
    expect(move.status).toBe(402)
    expect((await (await owner.get('/api/me')).json()).plan).toBe('free')
  })

  it('rejects an unsigned webhook', async () => {
    const res = await fetch(`${server.base}/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'customer.subscription.updated' }),
    })
    expect(res.status).toBe(400)
  })

  it('a signed subscription event activates the workspace', async () => {
    const periodEnd = t0 + 30 * 86_400
    const res = await subscriptionEvent('evt_1', 'customer.subscription.updated', t0, {
      workspaceId,
      status: 'active',
      seats: 3,
      periodEnd,
    })
    expect(res.status, await res.clone().text()).toBe(200)

    const ws = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(ws.status).toBe('active')
    expect(ws.active).toBe(true)
    expect(ws.plan).toBe('team')
    expect(ws.interval).toBe('month')
    expect(ws.seats).toBe(3)
    expect(ws.currentPeriodEnd).toBe(periodEnd * 1000)
    expect(ws.billing).toEqual({ enabled: true, portal: true })
    expect((await (await owner.get('/api/me')).json()).plan).toBe('team')

    /* and now it grows */
    expect(
      (await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'bill-mate@test.dev', role: 'admin' }))
        .status,
    ).toBe(200)
    expect((await owner.post('/api/canvases', { name: 'Yes', workspaceId })).status).toBe(200)
    /* a pending invite for someone who has not signed up yet */
    expect((await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'pending@test.dev' })).status).toBe(200)
  })

  it('refuses a second checkout while a subscription is live, and billing is the owner’s', async () => {
    const again = await owner.post(`/api/workspaces/${workspaceId}/billing/checkout`, { interval: 'month' })
    expect(again.status).toBe(409)
    /* the admin runs the people list, not the bill */
    expect((await mate.post(`/api/workspaces/${workspaceId}/billing/checkout`, { interval: 'month' })).status).toBe(403)
    expect((await mate.post(`/api/workspaces/${workspaceId}/billing/portal`)).status).toBe(403)
  })

  it('a canceled subscription freezes growth but keeps the canvases open', async () => {
    const res = await subscriptionEvent('evt_2', 'customer.subscription.deleted', t0 + 10, {
      workspaceId,
      status: 'canceled',
    })
    expect(res.status).toBe(200)
    const ws = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(ws.status).toBe('canceled')
    expect(ws.active).toBe(false)
    expect((await owner.post('/api/canvases', { name: 'Frozen', workspaceId })).status).toBe(402)
    /* the teammate still opens the canvas made while it was paid */
    const list = await (await mate.get('/api/canvases')).json()
    const inside = list.filter((c: { workspaceId?: string }) => c.workspaceId === workspaceId)
    expect(inside).toHaveLength(1)
    expect((await mate.get(`/api/canvases/${inside[0].id}`)).status).toBe(200)
  })

  it('a late-arriving older event cannot roll the cancellation back', async () => {
    const res = await subscriptionEvent('evt_stale', 'customer.subscription.updated', t0 + 5, {
      workspaceId,
      status: 'active',
      seats: 3,
      periodEnd: t0 + 30 * 86_400,
    })
    expect(res.status).toBe(200)
    const ws = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(ws.status).toBe('canceled')
    expect(ws.active).toBe(false)
  })

  it('an invite is kept while the workspace is lapsed and honoured on reactivation', async () => {
    const pending = new Client(server)
    await pending.signUp('pending@test.dev', 'Pending')
    /* signed up while canceled: not in, invite still on file */
    expect((await (await pending.get('/api/workspaces')).json()).workspaces).toEqual([])
    let ws = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(ws.invites.map((i: { email: string }) => i.email)).toEqual(['pending@test.dev'])

    /* the owner subscribes again — a new subscription id */
    const res = await subscriptionEvent('evt_3', 'customer.subscription.created', t0 + 20, {
      workspaceId,
      status: 'active',
      seats: 3,
      periodEnd: t0 + 60 * 86_400,
      subId: 'sub_test_2',
    })
    expect(res.status).toBe(200)
    ws = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(ws.status).toBe('active')
    expect(ws.invites).toEqual([])
    expect(ws.members.map((m: { email: string }) => m.email)).toContain('pending@test.dev')
    expect((await (await pending.get('/api/workspaces')).json()).workspaces).toHaveLength(1)
  })

  it('survives a restart with the billing state intact', async () => {
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer(
      PORT,
      {
        BETTER_AUTH_URL: `http://localhost:${PORT}`,
        STRIPE_SECRET_KEY: 'sk_test_doop_fake',
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STRIPE_PRICE_TEAM_MONTHLY: 'price_month',
        STRIPE_PRICE_TEAM_YEARLY: 'price_year',
      },
      server.dataDir,
    )
    const ws = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(ws.status).toBe('active')
    expect(ws.seats).toBe(3)
    expect(ws.memberCount).toBe(3)
  }, 70_000)

  it('an event for an unknown workspace is acknowledged and ignored', async () => {
    const payload = JSON.stringify({
      id: 'evt_test_3',
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_x',
          object: 'subscription',
          status: 'active',
          customer: 'cus_x',
          metadata: { workspaceId: 'nope' },
          items: { object: 'list', data: [] },
          cancel_at_period_end: false,
        },
      },
    })
    const stripe = new Stripe('sk_test_doop_fake')
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
    const res = await fetch(`${server.base}/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
      body: payload,
    })
    expect(res.status).toBe(200)
  })
})
