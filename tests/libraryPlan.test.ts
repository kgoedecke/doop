import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The workspace library behind billing: with Stripe configured a library needs
 * a workspace whose plan is live. The subscription arrives as a signed webhook,
 * built with Stripe's own test-signature helper, so nothing touches the network.
 */

const WEBHOOK_SECRET = 'whsec_test_doop'

let server: Server
let owner: Client
let workspaceId: string
let libraryId: string
let consumerId: string
let buttonId: string
const t0 = Math.floor(Date.now() / 1000)

const json = async <T>(res: Response) => (await res.json()) as T

function subscription(id: string, created: number, status: 'active' | 'canceled') {
  const payload = JSON.stringify({
    id,
    object: 'event',
    type: status === 'active' ? 'customer.subscription.updated' : 'customer.subscription.deleted',
    created,
    data: {
      object: {
        id: 'sub_test_1',
        object: 'subscription',
        status,
        customer: 'cus_test_1',
        cancel_at_period_end: false,
        metadata: { workspaceId },
        items: {
          object: 'list',
          data:
            status === 'active'
              ? [
                  {
                    id: 'si_test_1',
                    object: 'subscription_item',
                    quantity: 1,
                    current_period_end: created + 30 * 86_400,
                    price: { id: 'price_month', object: 'price', recurring: { interval: 'month' } },
                  },
                ]
              : [],
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

interface LibraryBody {
  billing: boolean
  entitled: boolean
  blocked?: string
  workspaceId?: string
  library: boolean
  updates: { id: string }[]
}
const libraryOf = async (id: string) => json<LibraryBody>(await owner.get(`/api/canvases/${id}/library`))
const offered = async (id: string) =>
  (await json<{ library?: boolean }[]>(await owner.get(`/api/canvases/${id}/component-libraries`))).filter(
    (entry) => entry.library,
  )

beforeAll(async () => {
  server = await startServer({
    STRIPE_SECRET_KEY: 'sk_test_doop_fake',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_TEAM_MONTHLY: 'price_month',
    STRIPE_PRICE_TEAM_YEARLY: 'price_year',
  })
  owner = await new Client(server).signUp('library-plan@test.dev', 'Owner')
  workspaceId = (await json<{ id: string }>(await owner.post('/api/workspaces', { name: 'Team' }))).id
}, 70_000)

afterAll(() => server?.stop())

describe('workspace library behind a plan', () => {
  it('tells a personal canvas that a library is a workspace thing, with billing on', async () => {
    const personal = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Mine' }))).id
    await owner.post(`/api/canvases/${personal}/components`, { name: 'Chip', html: '<span>New</span>' })
    expect(await libraryOf(personal)).toMatchObject({ billing: true, entitled: false, blocked: 'no_workspace' })
    const res = await owner.post(`/api/canvases/${personal}/library/publish`, {})
    expect(res.status).toBe(402)
    expect((await json<{ error: string }>(res)).error).toBe('library_needs_workspace')
  })

  it('publishes and shares while the plan is live', async () => {
    expect((await subscription('evt_1', t0, 'active')).status).toBe(200)
    libraryId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Kit', workspaceId }))).id
    consumerId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Site', workspaceId }))).id
    const made = await owner.post(`/api/canvases/${libraryId}/components`, {
      name: 'Button',
      html: '<button class="btn">Go</button>',
      css: '.btn { padding: 8px }',
    })
    buttonId = (await json<{ component: { id: string } }>(made)).component.id
    expect(await libraryOf(libraryId)).toMatchObject({ billing: true, entitled: true })
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
    expect(await offered(consumerId)).toHaveLength(1)
    const used = await owner.post(`/api/canvases/${consumerId}/components/import`, {
      sourceCanvasId: libraryId,
      component: 'Button',
    })
    expect(used.status).toBe(200)
  })

  it('stops publishing and new use when the plan lapses, naming the workspace to upgrade', async () => {
    expect((await subscription('evt_2', t0 + 10, 'canceled')).status).toBe(200)
    expect(await libraryOf(libraryId)).toMatchObject({
      billing: true,
      entitled: false,
      blocked: 'plan_required',
      workspaceId,
      /* what it published is still on record, for when the plan returns */
      library: true,
    })
    const res = await owner.post(`/api/canvases/${libraryId}/library/publish`, {})
    expect(res.status).toBe(402)
    expect(await json<{ error: string; workspaceId: string }>(res)).toMatchObject({
      error: 'workspace_plan_required',
      workspaceId,
    })
    /* nothing is offered to a canvas that does not use it yet, by listing or by name */
    expect(await offered(consumerId)).toEqual([])
    const fresh = await owner.post(`/api/canvases/${consumerId}/frames`, {
      name: 'Later',
      html: '<!doctype html><html><head></head><body><doop-use component="Nope"></doop-use></body></html>',
    })
    expect(fresh.status).toBe(200)
    /* a canvas already using the component keeps it, instances and all */
    const canvas = await json<{ components?: { id: string }[] }>(await owner.get(`/api/canvases/${consumerId}`))
    expect(canvas.components?.map((def) => def.id)).toEqual([buttonId])
  })

  it('offers the library again once the plan is back', async () => {
    expect((await subscription('evt_3', t0 + 20, 'active')).status).toBe(200)
    expect(await libraryOf(libraryId)).toMatchObject({ entitled: true, library: true })
    const other = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Docs', workspaceId }))).id
    expect(await offered(other)).toHaveLength(1)
    expect((await owner.post(`/api/canvases/${libraryId}/library/publish`, {})).status).toBe(200)
  })
})
