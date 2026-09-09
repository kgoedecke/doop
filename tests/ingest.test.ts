import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { describeSyncFlow } from '../server/ingest.ts'
import type { Frame } from '../shared/types.ts'

/**
 * Design-sync ingest: the doop-sync snippet's endpoint and the key-management
 * REST, exercised against the real server. The page-interval throttle is
 * disabled via env so consecutive writes to the same page can be asserted.
 */

const PORT = 4980

let server: Server
let BASE: string

beforeAll(async () => {
  server = await startServer(PORT, { SYNC_PAGE_INTERVAL_MS: '0' })
  BASE = server.base
}, 70_000)

afterAll(() => server?.stop())

const SNAPSHOT = (marker: string) =>
  `<html><head><title>t</title><meta http-equiv="refresh" content="1"><base href="https://evil.example/"></head>` +
  `<body onload="alert(1)"><script>alert(1)</script><h1 onclick="x()">${marker}</h1>` +
  `<a href="javascript:alert(1)">x</a><iframe src="https://x.example"></iframe></body></html>`

describe('design sync ingest', () => {
  let owner: Client
  let stranger: Client
  let canvasId: string
  let secret: string
  let keyId: string

  beforeAll(async () => {
    owner = new Client(server)
    stranger = new Client(server)
    await owner.signUp('sync-owner@test.dev', 'Owner')
    await stranger.signUp('sync-stranger@test.dev', 'Stranger')
    const canvas = await (await owner.post('/api/canvases', { name: 'Synced' })).json()
    canvasId = canvas.id
  })

  it('members can mint keys; strangers cannot', async () => {
    expect((await stranger.post(`/api/canvases/${canvasId}/sync-keys`, { name: 'nope' })).status).toBe(403)
    expect((await stranger.get(`/api/canvases/${canvasId}/sync-keys`)).status).toBe(403)

    const res = await owner.post(`/api/canvases/${canvasId}/sync-keys`, { name: 'Admin app' })
    expect(res.status).toBe(200)
    const key = await res.json()
    expect(key.secret).toMatch(/^dk_/)
    expect(key.name).toBe('Admin app')
    secret = key.secret
    keyId = key.id

    const list = await (await owner.get(`/api/canvases/${canvasId}/sync-keys`)).json()
    expect(list).toHaveLength(1)
    expect(list[0].frames).toBe(0)
  })

  it('answers CORS preflight and stamps CORS on responses', async () => {
    const preflight = await fetch(`${BASE}/ingest/${secret}`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    const bad = await fetch(`${BASE}/ingest/dk_00000000000000000000000000`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: '/x', html: '<p>x</p>' }),
    })
    expect(bad.status).toBe(404)
    expect(bad.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('creates a frame from a snapshot and scrubs it', async () => {
    const res = await fetch(`${BASE}/ingest/${secret}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: '/orders/:id',
        title: 'Orders',
        url: 'https://intranet.example/orders/1',
        width: 1440,
        height: 2000,
        html: SNAPSHOT('one'),
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.created).toBe(true)

    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.frames).toHaveLength(1)
    const frame = canvas.frames[0]
    expect(frame.name).toBe('Orders')
    expect(frame.width).toBe(1440)
    expect(frame.html).toContain('one')
    expect(frame.html).toContain('doop-sync-page')
    expect(frame.html).toContain('Content-Security-Policy')
    /* the app's base is kept, the snapshot's own base and scripts are not */
    expect(frame.html).toContain('base href="https://intranet.example/orders/1"')
    expect(frame.html).not.toContain('evil.example')
    expect(frame.html).not.toContain('<script')
    expect(frame.html).not.toContain('<iframe')
    expect(frame.html).not.toContain('onload=')
    expect(frame.html).not.toContain('onclick=')
    expect(frame.html).not.toContain('javascript:')
    expect(frame.html).not.toContain('http-equiv="refresh"')
  })

  it('updates the same frame on re-sync and reports unchanged replays', async () => {
    const send = (html: string) =>
      fetch(`${BASE}/ingest/${secret}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: '/orders/:id', title: 'Orders v2', url: 'https://intranet.example/', html }),
      })
    const updated = await (await send(SNAPSHOT('two'))).json()
    expect(updated.updated).toBe(true)
    const replay = await (await send(SNAPSHOT('two'))).json()
    expect(replay.unchanged).toBe(true)

    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.frames).toHaveLength(1)
    expect(canvas.frames[0].html).toContain('two')
    expect(canvas.frames[0].name).toBe('Orders v2')
  })

  it('a new page becomes a second frame in the same row', async () => {
    const res = await fetch(`${BASE}/ingest/${secret}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // sendBeacon's content type
      body: JSON.stringify({ page: '/settings', html: '<html><body><h2>Settings</h2></body></html>' }),
    })
    expect((await res.json()).created).toBe(true)
    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.frames).toHaveLength(2)
    const [a, b] = canvas.frames
    expect(b.y).toBe(a.y)
    expect(b.x).toBeGreaterThan(a.x + a.width)

    const list = await (await owner.get(`/api/canvases/${canvasId}/sync-keys`)).json()
    expect(list[0].frames).toBe(2)
    expect(list[0].lastUsedAt).toBeGreaterThan(0)
  })

  it('captures the flow map: link hotspots and traversal counts between frames', async () => {
    const post = (body: unknown) =>
      fetch(`${BASE}/ingest/${secret}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    /* snapshot with links: one to a synced page, one to a page nobody visited */
    const res = await post({
      page: '/orders/:id',
      title: 'Orders',
      html: SNAPSHOT('three'),
      links: [
        { to: '/settings', x: 40, y: 60, w: 120, h: 32, label: 'Settings' },
        { to: '/nowhere', x: 10, y: 10, w: 50, h: 20 },
      ],
      edges: [
        { from: '/orders/:id', to: '/settings' },
        { from: '/orders/:id', to: '/settings' },
      ],
    })
    expect(res.status).toBe(200)
    /* an unchanged screen can still flush navigations on their own */
    const slim = await (await post({ page: '/settings', edges: [{ from: '/settings', to: '/orders/:id' }] })).json()
    expect(slim).toEqual({ ok: true, edges: 1 })

    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    const frames = canvas.frames as { name: string; id: string }[]
    const orders = frames.find((f) => f.name === 'Orders')!.id
    const settings = frames.find((f) => f.name !== 'Orders')!.id

    const flow = await (await owner.get(`/api/canvases/${canvasId}/sync-flow`)).json()
    expect(flow.links).toHaveLength(1) // the /nowhere link has no frame to point at
    expect(flow.links[0]).toMatchObject({
      fromFrameId: orders,
      toFrameId: settings,
      x: 40,
      y: 60,
      width: 120,
      height: 32,
      label: 'Settings',
    })
    expect(flow.edges).toHaveLength(2)
    const counts = Object.fromEntries(
      flow.edges.map((e: { fromFrameId: string; count: number }) => [e.fromFrameId, e.count]),
    )
    expect(counts[orders]).toBe(2)
    expect(counts[settings]).toBe(1)

    /* an unchanged snapshot still refreshes hotspots — the first capture from
       a link-reporting snippet version arrives with identical HTML */
    const replay = await (
      await post({
        page: '/orders/:id',
        title: 'Orders',
        html: SNAPSHOT('three'),
        links: [{ to: '/settings', x: 8, y: 16, w: 90, h: 24, label: 'Go' }],
      })
    ).json()
    expect(replay.unchanged).toBe(true)
    const flow2 = await (await owner.get(`/api/canvases/${canvasId}/sync-flow`)).json()
    expect(flow2.links).toHaveLength(1)
    expect(flow2.links[0]).toMatchObject({ x: 8, y: 16, width: 90, height: 24, label: 'Go' })
  })

  it('marks recorded edges in a response header; the rate-limit 429 omits it', async () => {
    /* the snippet requeues its edge batch unless X-Doop-Edges proves the
       server stored it — the per-key rate limit fires before recording */
    const canvas = await (await owner.post('/api/canvases', { name: 'Rate limited' })).json()
    const key = await (await owner.post(`/api/canvases/${canvas.id}/sync-keys`, { name: 'burst' })).json()
    const post = () =>
      fetch(`${BASE}/ingest/${key.secret}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: '/a', edges: [{ from: '/a', to: '/b' }] }),
      })
    const first = await post()
    expect(first.status).toBe(200)
    expect(first.headers.get('x-doop-edges')).toBe('1')
    expect(first.headers.get('access-control-expose-headers')).toContain('X-Doop-Edges')
    let limited: Response | null = null
    for (let i = 0; i < 32 && !limited; i++) {
      const res = await post()
      if (res.status === 429) limited = res
    }
    expect(limited).not.toBeNull()
    expect(limited!.headers.get('x-doop-edges')).toBeNull() // not recorded — snippet must retry
  })

  it('rejects malformed payloads', async () => {
    const post = (body: unknown) =>
      fetch(`${BASE}/ingest/${secret}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await post({ page: 'not-rooted', html: '<p>x</p>' })).status).toBe(400)
    expect((await post({ page: '/x' })).status).toBe(400)
    expect((await post({ page: '/big', html: '<p>' + 'x'.repeat(3_100_000) + '</p>' })).status).toBe(413)
  })

  it('link-edit visitors can edit frames but cannot touch sync keys', async () => {
    /* the P1 from review: a share-link visitor must not be able to read or
       mint a durable bearer secret that outlives the link being turned off */
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })).status).toBe(200)
    expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(200) // link access works…
    expect((await stranger.get(`/api/canvases/${canvasId}/sync-keys`)).status).toBe(403)
    expect((await stranger.post(`/api/canvases/${canvasId}/sync-keys`, { name: 'sneaky' })).status).toBe(403)
    expect((await stranger.delete(`/api/canvases/${canvasId}/sync-keys/${keyId}`)).status).toBe(403)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' })).status).toBe(200)
  })

  it('revoked keys stop working immediately', async () => {
    expect((await owner.delete(`/api/canvases/${canvasId}/sync-keys/${keyId}`)).status).toBe(200)
    const res = await fetch(`${BASE}/ingest/${secret}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: '/x', html: '<p>x</p>' }),
    })
    expect(res.status).toBe(404)
  })
})

/* Pure formatter — what MCP get_canvas and the resident team read as flow
   context. No server needed. */
describe('describeSyncFlow', () => {
  const frame = (id: string, name: string): Frame =>
    ({
      id,
      canvasId: 'c',
      name,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      html: '',
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 't',
    }) as Frame

  it('renders edges most-traveled first, dedupes links by label', () => {
    const frames = [frame('f1', 'Catalog'), frame('f2', 'Checkout'), frame('f3', 'Home')]
    const lines = describeSyncFlow(
      {
        links: [
          { fromFrameId: 'f1', toFrameId: 'f2', x: 0, y: 0, width: 10, height: 10, label: 'Buy now' },
          { fromFrameId: 'f1', toFrameId: 'f2', x: 50, y: 9, width: 10, height: 10, label: 'Buy now' },
          { fromFrameId: 'f3', toFrameId: 'f1', x: 0, y: 0, width: 10, height: 10, label: null },
        ],
        edges: [
          { fromFrameId: 'f3', toFrameId: 'f1', count: 2, lastAt: 1 },
          { fromFrameId: 'f1', toFrameId: 'f2', count: 9, lastAt: 1 },
        ],
      },
      frames,
    )
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('"Catalog" (f1) → "Checkout" (f2): 9 real user navigations')
    expect(lines[1]).toBe('"Home" (f3) → "Catalog" (f1): 2 real user navigations')
    expect(lines[2]).toContain('links to "Checkout" (f2) via “Buy now”')
    expect(lines[3]).toBe('"Home" (f3) links to "Catalog" (f1)')
  })

  it('returns nothing for canvases without flow data', () => {
    expect(describeSyncFlow({ links: [], edges: [] }, [])).toEqual([])
  })
})

/* Import-once: with the grace window elapsed (SYNC_FREEZE_MS=0), a synced
   screen freezes — later captures don't rewrite it, edges still count. */
describe('design sync freeze', () => {
  let frozenServer: Server
  let owner: Client

  beforeAll(async () => {
    frozenServer = await startServer(4985, { SYNC_PAGE_INTERVAL_MS: '0', SYNC_FREEZE_MS: '0' })
    owner = new Client(frozenServer)
    await owner.signUp('freeze-owner@test.dev', 'Owner')
  }, 70_000)

  afterAll(() => frozenServer?.stop())

  it('first capture wins; later captures are told the screen is settled', async () => {
    const canvas = await (await owner.post('/api/canvases', { name: 'Frozen' })).json()
    const key = await (await owner.post(`/api/canvases/${canvas.id}/sync-keys`, { name: 'app' })).json()
    const post = (html: string, edges?: unknown[]) =>
      fetch(`${frozenServer.base}/ingest/${key.secret}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: '/home', html, edges }),
      })

    const first = await post('<html><body><h1>v1</h1></body></html>')
    expect((await first.json()).created).toBe(true)

    const second = await post('<html><body><h1>v2</h1></body></html>', [{ from: '/home', to: '/about' }])
    expect(second.headers.get('x-doop-synced')).toBe('1')
    expect(second.headers.get('x-doop-edges')).toBe('1') // navigations still count
    expect((await second.json()).frozen).toBe(true)

    const got = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
    expect(got.frames).toHaveLength(1)
    expect(got.frames[0].html).toContain('v1') // the rewrite was refused
    expect(got.frames[0].html).not.toContain('v2')
  })
})
