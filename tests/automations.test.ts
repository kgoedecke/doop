import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import {
  AUTOMATION_EXAMPLES,
  describeSchedule,
  incompleteReason,
  nextRunAt,
  normalizeSchedule,
  normalizeSteps,
  wallClock,
} from '../shared/automations.ts'
import {
  creativeHtml,
  frameHeight,
  imageHeight,
  metaFrameMarker,
  signState,
  toCreative,
  toCreatives,
  verifyState,
} from '../server/meta.ts'

/* ------------------------------------------------------------------ */
/* Pure: schedule math                                                 */

describe('nextRunAt', () => {
  /* 2026-09-09 is a Wednesday */
  const wed = Date.UTC(2026, 8, 9, 12, 0)

  it('fires next Monday 09:00 in the zone, not in UTC', () => {
    const at = nextRunAt({ kind: 'weekly', weekday: 1, hour: 9, minute: 0, tz: 'Europe/Berlin' }, wed)
    const w = wallClock(at, 'Europe/Berlin')
    expect([w.weekday, w.hour, w.minute]).toEqual([1, 9, 0])
    expect(new Date(at).toISOString()).toBe('2026-09-14T07:00:00.000Z') // CEST = UTC+2
  })

  it('same day when the time is still ahead, next occurrence when it has passed', () => {
    const daily = { kind: 'daily' as const, weekday: 0, hour: 15, minute: 30, tz: 'UTC' }
    expect(new Date(nextRunAt(daily, wed)).toISOString()).toBe('2026-09-09T15:30:00.000Z')
    const later = Date.UTC(2026, 8, 9, 15, 30)
    expect(new Date(nextRunAt(daily, later)).toISOString()).toBe('2026-09-10T15:30:00.000Z')
  })

  it('weekdays skips the weekend', () => {
    const fri = Date.UTC(2026, 8, 11, 20, 0)
    const at = nextRunAt({ kind: 'weekdays', weekday: 0, hour: 9, minute: 0, tz: 'UTC' }, fri)
    expect(new Date(at).toISOString()).toBe('2026-09-14T09:00:00.000Z')
  })

  it('survives a DST change between now and the run', () => {
    /* Berlin leaves DST on 2026-10-25; a Monday 09:00 after it is UTC+1 */
    const before = Date.UTC(2026, 9, 23, 12, 0)
    const at = nextRunAt({ kind: 'weekly', weekday: 1, hour: 9, minute: 0, tz: 'Europe/Berlin' }, before)
    expect(new Date(at).toISOString()).toBe('2026-10-26T08:00:00.000Z')
  })

  it('falls back to UTC for a zone it does not know', () => {
    const at = nextRunAt({ kind: 'daily', weekday: 0, hour: 9, minute: 0, tz: 'Mars/Olympus' }, wed)
    expect(new Date(at).toISOString()).toBe('2026-09-10T09:00:00.000Z')
  })
})

describe('normalize', () => {
  it('coerces a schedule and rejects out-of-range fields', () => {
    expect(normalizeSchedule({ kind: 'nope', weekday: 9, hour: '7', minute: 61, tz: 'Nowhere/Here' })).toEqual({
      kind: 'weekly',
      weekday: 1,
      hour: 7,
      minute: 0,
      tz: 'UTC',
    })
    /* the clock reads in the runner's locale: 16:00 or 4:00 PM */
    expect(describeSchedule(normalizeSchedule({ kind: 'weekly', weekday: 5, hour: 16, minute: 0 }))).toMatch(
      /^Every Friday at (16:00|4:00 PM)$/,
    )
  })

  it('keeps only real steps, with real roles', () => {
    const steps = normalizeSteps([
      { type: 'pull', accountId: 'act_1', filter: 'everything', canvasId: 'c1' },
      { type: 'agent', prompt: ' Review it ', roles: ['bogus', 'ux', 'doop'], canvasId: 'c1' },
    ])
    expect(steps).toEqual([
      { id: 's1', type: 'pull', provider: 'meta', accountId: 'act_1', filter: 'active', canvasId: 'c1' },
      { id: 's2', type: 'agent', title: '', prompt: 'Review it', roles: ['ux'], canvasId: 'c1' },
    ])
    expect(normalizeSteps([{ type: 'webhook' }])).toBe('each step is a pull or an agent task')
  })

  it('says what is missing before an automation can run', () => {
    expect(incompleteReason([])).toBe('Add a step')
    expect(incompleteReason([{ id: 's1', type: 'agent', title: '', prompt: 'x', roles: ['doop'], canvasId: '' }])).toBe(
      'Pick a canvas for every step',
    )
    expect(
      incompleteReason([{ id: 's1', type: 'pull', provider: 'meta', accountId: '', filter: 'active', canvasId: 'c' }]),
    ).toBe('Pick a Meta ad account')
    expect(
      incompleteReason([{ id: 's1', type: 'agent', title: '', prompt: 'x', roles: ['doop'], canvasId: 'c' }]),
    ).toBeUndefined()
  })

  it('every example is complete once a canvas is picked', () => {
    for (const e of AUTOMATION_EXAMPLES) {
      const steps = normalizeSteps(e.steps.map((s) => ({ ...s, canvasId: 'c', accountId: 'act_1' })))
      expect(typeof steps).not.toBe('string')
      if (typeof steps !== 'string') expect(incompleteReason(steps)).toBeUndefined()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Pure: Meta                                                          */

describe('meta', () => {
  it('signs a state only its own user can redeem, for a while', () => {
    const state = signState('user-1')
    expect(verifyState(state)).toEqual({ userId: 'user-1' })
    expect(verifyState(state.slice(0, -2) + 'xx')).toBeUndefined()
    expect(verifyState(signState('user-1', Date.now() - 16 * 60_000))).toBeUndefined()
  })

  it('flattens the several creative shapes into one card', () => {
    expect(
      toCreative({
        id: '9',
        name: 'Spring sale',
        effective_status: 'ACTIVE',
        creative: {
          object_story_spec: {
            link_data: {
              name: 'Big headline',
              message: 'Body copy',
              picture: 'https://x/y.jpg',
              image_hash: 'abc123',
              call_to_action: { type: 'SHOP_NOW' },
            },
          },
        },
      }),
    ).toEqual({
      adId: '9',
      name: 'Spring sale',
      headline: 'Big headline',
      body: 'Body copy',
      cta: 'Shop Now',
      imageUrl: 'https://x/y.jpg',
      imageHash: 'abc123',
      creativeId: null,
      width: null,
      height: null,
      status: 'ACTIVE',
    })
  })

  it('expands dynamic-creative and carousel ads into one card per image', () => {
    const feed = toCreatives({
      id: '7',
      name: 'Dynamic',
      creative: { asset_feed_spec: { titles: [{ text: 'T' }], images: [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }] } },
    })
    expect(feed.map((c) => [c.adId, c.name, c.imageHash])).toEqual([
      ['7:a', 'Dynamic · 1', 'a'],
      ['7:b', 'Dynamic · 2', 'b'],
      ['7:c', 'Dynamic · 3', 'c'],
    ])
    const carousel = toCreatives({
      id: '8',
      name: 'Carousel',
      creative: {
        object_story_spec: {
          link_data: {
            message: 'Shared body',
            child_attachments: [
              { name: 'Card one', image_hash: 'x' },
              { name: 'Card two', image_hash: 'y', description: 'Own body' },
            ],
          },
        },
      },
    })
    expect(carousel.map((c) => [c.adId, c.headline, c.body])).toEqual([
      ['8:x', 'Card one', 'Shared body'],
      ['8:y', 'Card two', 'Own body'],
    ])
    /* a single-image ad stays one card */
    expect(toCreatives({ id: '9', creative: { image_hash: 'z' } })).toHaveLength(1)
  })

  it('sizes the frame to the image, whatever its aspect ratio', () => {
    expect(imageHeight({ width: null, height: null })).toBe(480)
    expect(imageHeight({ width: 1080, height: 1920 })).toBe(853)
    expect(imageHeight({ width: 1080, height: 1350 })).toBe(600)
    expect(frameHeight({ width: 1920, height: 1080 })).toBe(270 + 190)
  })

  it('stamps the ad id into the frame so a later pull can skip it', () => {
    const html = creativeHtml(
      {
        adId: '42',
        name: 'A <b>',
        headline: 'H',
        body: 'B',
        cta: 'Learn More',
        imageUrl: null,
        imageHash: null,
        creativeId: null,
        width: null,
        height: null,
        status: 'ACTIVE',
      },
      null,
    )
    expect(metaFrameMarker(html)).toBe('42')
    expect(html).toContain('A &lt;b&gt;')
    expect(html).not.toContain('<b>')
  })
})

/* ------------------------------------------------------------------ */
/* REST                                                                */

const PORT = 4994

let server: Server
let owner: Client
let other: Client

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  owner = new Client(server)
  await owner.signUp('owner@test.dev', 'Olive Owner')
  other = new Client(server)
  await other.signUp('other@test.dev', 'Otto Other')
}, 60_000)

afterAll(() => server?.stop())

it('creates, completes, runs and lists an automation for its owner only', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Ads' })).json()

  /* starts empty: saved, but not scheduled */
  const created = await (
    await owner.post('/api/automations', {
      name: 'Friday review',
      schedule: { kind: 'weekly', weekday: 5, hour: 16, minute: 0, tz: 'Europe/Berlin' },
      steps: [],
    })
  ).json()
  expect(created).toMatchObject({ name: 'Friday review', enabled: true, steps: [], nextRunAt: null, lastRun: null })

  /* a canvas the owner cannot reach is refused */
  const foreign = await (await other.post('/api/canvases', { name: 'Not yours' })).json()
  const refused = await owner.patch(`/api/automations/${created.id}`, {
    steps: [{ type: 'agent', prompt: 'Review', roles: ['ux'], canvasId: foreign.id }],
  })
  expect(refused.status).toBe(400)

  /* completing it schedules it */
  const saved = await (
    await owner.patch(`/api/automations/${created.id}`, {
      steps: [{ type: 'agent', prompt: 'Review every frame', roles: ['ux'], canvasId: canvas.id }],
    })
  ).json()
  expect(saved.steps).toEqual([
    { id: 's1', type: 'agent', title: '', prompt: 'Review every frame', roles: ['ux'], canvasId: canvas.id },
  ])
  expect(saved.nextRunAt).toBeGreaterThan(Date.now())
  expect(new Date(saved.nextRunAt).getUTCDay()).toBe(5)

  /* off = no next run; on again = scheduled again */
  expect((await (await owner.patch(`/api/automations/${created.id}`, { enabled: false })).json()).nextRunAt).toBeNull()
  /* a rename carries only the name — it must not switch the automation back on */
  const renamed = await (await owner.patch(`/api/automations/${created.id}`, { name: 'Friday UX review' })).json()
  expect(renamed).toMatchObject({ name: 'Friday UX review', enabled: false, nextRunAt: null })
  expect(renamed.steps).toHaveLength(1)
  expect(
    (await (await owner.patch(`/api/automations/${created.id}`, { enabled: true })).json()).nextRunAt,
  ).not.toBeNull()

  /* run now: the test server has no model account, so the agent step fails
     cleanly and the run says why */
  const run = await (await owner.post(`/api/automations/${created.id}/run`)).json()
  expect(run).toMatchObject({ automationId: created.id, status: 'failed', canvasId: canvas.id })
  expect(run.error).toMatch(/no model account/)
  expect(run.endedAt).toBeGreaterThanOrEqual(run.startedAt)

  const runs = await (await owner.get(`/api/automations/${created.id}/runs`)).json()
  expect(runs).toHaveLength(1)
  expect(runs[0].id).toBe(run.id)

  const [listed] = await (await owner.get('/api/automations')).json()
  expect(listed.lastRun).toMatchObject({ id: run.id, status: 'failed' })

  /* private to the owner */
  expect((await other.get(`/api/automations/${created.id}`)).status).toBe(404)
  expect(await (await other.get('/api/automations')).json()).toEqual([])
  expect((await other.delete(`/api/automations/${created.id}`)).status).toBe(404)

  expect((await owner.delete(`/api/automations/${created.id}`)).status).toBe(200)
  expect((await owner.get(`/api/automations/${created.id}`)).status).toBe(404)
})

it('reports Meta as not connected and not configured on a bare server', async () => {
  const status = await (await owner.get('/api/integrations')).json()
  expect(status).toEqual({ meta: { enabled: false, connected: false } })
  expect((await owner.post('/api/integrations/meta/start')).status).toBe(400)
  /* a pull step without a connection fails with the one-click fix named */
  const canvas = await (await owner.post('/api/canvases', { name: 'Pulls' })).json()
  const a = await (
    await owner.post('/api/automations', {
      name: 'Pull',
      steps: [{ type: 'pull', accountId: 'act_1', filter: 'active', canvasId: canvas.id }],
    })
  ).json()
  const run = await (await owner.post(`/api/automations/${a.id}/run`)).json()
  expect(run).toMatchObject({ status: 'failed', failure: 'reconnect' })
})
