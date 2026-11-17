import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { Client, startServer, type Server } from './harness.ts'
import { ttf } from './fontFiles.ts'
import { FREE_FONT_FAMILIES, FREE_UPLOAD_BYTES } from '../shared/billing.ts'

/**
 * What Pro lifts, against a server that sells plans: Free uploads stop at
 * 5 MB and a Free font library at two families, each refusal naming Pro;
 * a member of a paid workspace gets the bigger limits on their personal
 * canvases too. (Without billing nothing is limited: the font and asset
 * suites run on such a server.)
 */

const WEBHOOK_SECRET = 'whsec_test_plan_limits'

let server: Server
let owner: Client
let canvasId: string

beforeAll(async () => {
  server = await startServer({
    STRIPE_SECRET_KEY: 'sk_test_doop_fake',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_TEAM_MONTHLY: 'price_month',
  })
  owner = await new Client(server).signUp('limits-owner@test.dev', 'Owner')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Mine' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

function uploadFont(bytes: Buffer, fileName: string) {
  return owner.req('/api/fonts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fileName) },
    body: new Uint8Array(bytes),
  })
}

/** A PNG-signed file of the given size: the type is sniffed from its first bytes. */
function png(bytes: number) {
  const buf = Buffer.alloc(bytes)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return owner.req(`/api/canvases/${canvasId}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(buf),
  })
}

function activate(workspaceId: string) {
  const payload = JSON.stringify({
    id: 'evt_limits_1',
    object: 'event',
    type: 'customer.subscription.updated',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'sub_limits_1',
        object: 'subscription',
        status: 'active',
        customer: 'cus_limits_1',
        cancel_at_period_end: false,
        metadata: { workspaceId },
        items: {
          object: 'list',
          data: [
            {
              id: 'si_limits_1',
              object: 'subscription_item',
              quantity: 1,
              price: { id: 'price_month', object: 'price', recurring: { interval: 'month' } },
            },
          ],
        },
      },
    },
  })
  const signature = new Stripe('sk_test_doop_fake').webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  })
  return fetch(`${server.base}/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: payload,
  })
}

describe('the Free plan', () => {
  it('tells the app plans are on sale and the account is on Free', async () => {
    const me = await (await owner.get('/api/me')).json()
    expect(me).toMatchObject({ plan: 'free', billing: true })
    const plans = await (await owner.get('/api/billing/plans')).json()
    expect(plans.plans.map((p: { name: string }) => p.name)).toEqual(['Free', 'Pro', 'Enterprise'])
  })

  it('holds two font families, and more faces of either', async () => {
    expect(FREE_FONT_FAMILIES).toBe(2)
    expect((await uploadFont(ttf({ family: 'Alpha' }), 'Alpha.ttf')).status).toBe(200)
    expect((await uploadFont(ttf({ family: 'Beta' }), 'Beta.ttf')).status).toBe(200)
    expect((await uploadFont(ttf({ family: 'Alpha', weight: 700 }), 'Alpha-Bold.ttf')).status).toBe(200)

    const third = await uploadFont(ttf({ family: 'Gamma' }), 'Gamma.ttf')
    expect(third.status).toBe(402)
    const body = await third.json()
    expect(body.upgrade).toBe('fonts')
    expect(body.error).toMatch(/Pro/)
  })

  it('takes images up to 5 MB and says what Pro allows past that', async () => {
    expect((await png(1024)).status).toBe(200)
    const big = await png(FREE_UPLOAD_BYTES + 1024)
    expect(big.status).toBe(400)
    expect((await big.json()).error).toMatch(/Free plan; Pro uploads up to 100 MB/)
  })
})

describe('on Pro', () => {
  beforeAll(async () => {
    const ws = await (await owner.post('/api/workspaces', { name: 'Pro Co' })).json()
    const res = await activate(ws.id)
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await (await owner.get('/api/me')).json()).plan).toBe('team')
  })

  it('lifts the limits on the member’s personal canvases and library', async () => {
    expect((await png(FREE_UPLOAD_BYTES + 1024)).status).toBe(200)
    expect((await uploadFont(ttf({ family: 'Gamma' }), 'Gamma.ttf')).status).toBe(200)
  })
})
