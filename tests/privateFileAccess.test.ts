import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, type Server } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=',
  'base64',
)
let fixture: Awaited<ReturnType<typeof startPrivateServer>> | undefined
let server: Server
let alice: Client
let bob: Client
let assetPath: string
let canvasId: string

beforeAll(async () => {
  fixture = await startPrivateServer()
  server = fixture.server
  alice = await new Client(server).signUp('private-a@test.dev', 'Company A')
  bob = await new Client(server).signUp('private-b@test.dev', 'Company B')
  const workspaceA = await (await alice.post('/api/workspaces', { name: 'Private A' })).json()
  const workspaceB = await (await bob.post('/api/workspaces', { name: 'Private B' })).json()
  expect(workspaceA.id).toBeTruthy()
  expect(workspaceB.id).toBeTruthy()
  const created = await alice.post('/api/canvases', { name: 'Private bytes', workspaceId: workspaceA.id })
  expect(created.status).toBe(200)
  const canvas = await created.json()
  canvasId = canvas.id
  expect((await bob.get(`/api/canvases/${canvas.id}`)).status).toBe(403)
  const uploaded = await alice.req(`/api/canvases/${canvas.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG),
  })
  expect(uploaded.status).toBe(200)
  assetPath = new URL((await uploaded.json()).url).pathname
  const warmed = await alice.get(assetPath)
  expect(warmed.status).toBe(200)
  expect(Buffer.from(await warmed.arrayBuffer())).toEqual(PNG)
}, 60_000)

afterAll(async () => {
  await fixture?.close()
})

describe('private asset URLs after an authorized warm read', () => {
  for (const principal of ['anonymous', 'foreign'] as const) {
    it.each([
      ['plain', 'GET', {}],
      ['head', 'HEAD', {}],
      ['range', 'GET', { Range: 'bytes=0-7' }],
    ] as const)(`denies ${principal} %s without resource bytes or metadata`, async (_variant, method, headers) => {
      const response =
        principal === 'foreign'
          ? await bob.req(assetPath, { method, headers })
          : await fetch(server.base + assetPath, { method, headers, redirect: 'manual' })
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type') ?? '').not.toContain('image/')
      expect(response.headers.get('location')).toBeNull()
      expect((await response.arrayBuffer()).byteLength).toBe(0)
    })
  }
})

describe('private frame images after an authorized render', () => {
  let imagePath: string
  beforeAll(async () => {
    const created = await alice.post(`/api/canvases/${canvasId}/frames`, {
      name: 'Private frame',
      width: 320,
      height: 240,
      html: `<html><body><h1>Private A</h1><img src="${server.base}${assetPath}"></body></html>`,
    })
    expect(created.status).toBe(200)
    imagePath = `/i/${(await created.json()).id}.png`
    const warmed = await alice.get(imagePath)
    expect(warmed.status).toBe(200)
    expect((await warmed.arrayBuffer()).byteLength).toBeGreaterThan(100)
  }, 30_000)

  for (const principal of ['anonymous', 'foreign'] as const) {
    it.each(['GET', 'HEAD'] as const)(`denies ${principal} %s on the warm frame image`, async (method) => {
      const response =
        principal === 'foreign'
          ? await bob.req(imagePath, { method })
          : await fetch(server.base + imagePath, { method, redirect: 'manual' })
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type') ?? '').not.toContain('image/')
      expect((await response.arrayBuffer()).byteLength).toBe(0)
    })
  }
})

const variants = [
  ['conditional', 'GET', { 'If-None-Match': '*' }],
  ['modified', 'GET', { 'If-Modified-Since': 'Wed, 21 Oct 2099 07:28:00 GMT' }],
  ['multi-range', 'GET', { Range: 'bytes=0-1,4-6' }],
  ['if-range', 'GET', { Range: 'bytes=0-7', 'If-Range': 'secret-validator' }],
  ['download', 'GET', {}],
] as const

describe('private response variants', () => {
  for (const principal of ['anonymous', 'foreign'] as const) {
    it.each(variants)(
      `denies ${principal} %s without validators or object metadata`,
      async (variant, method, headers) => {
        const path = assetPath + (variant === 'download' ? '?download' : '')
        const response =
          principal === 'foreign'
            ? await bob.req(path, { method, headers })
            : await fetch(server.base + path, { method, headers, redirect: 'manual' })
        expect(response.status).toBe(404)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(response.headers.get('vary')).toContain('Cookie')
        for (const key of [
          'etag',
          'last-modified',
          'content-type',
          'content-disposition',
          'location',
          'access-control-allow-origin',
        ])
          expect(response.headers.get(key)).toBeNull()
        expect(await response.text()).toBe('')
      },
    )
  }
  it.each(variants)(
    'authorized %s returns current complete bytes with no validator',
    async (variant, method, headers) => {
      const response = await alice.req(assetPath + (variant === 'download' ? '?download' : ''), { method, headers })
      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('accept-ranges')).toBe('none')
      expect(response.headers.get('etag')).toBeNull()
      expect(response.headers.get('last-modified')).toBeNull()
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    },
  )
  it.each([
    '/a/missing.png',
    '/a/../a/missing.png',
    '/a/%6dissing.png',
    '/a/missing.PNG',
    '/A/missing.png',
    '/a/missing.svg/extra',
    '/%61/missing.png',
    '/i/missing.png',
    '/i/missing.gif',
    '/a/',
    '/a',
  ])('rejects missing or noncanonical %s opaquely', async (path) => {
    const response = await alice.get(path)
    expect(response.status).toBe(404)
    expect(response.headers.get('etag')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toBe('')
  })
  it('wrong extension and another authenticated company are indistinguishable from missing', async () => {
    const responses = await Promise.all([
      alice.get(assetPath.replace(/\.[^.]+$/, '.svg')),
      bob.get(assetPath),
      alice.get('/a/missing.png'),
    ])
    for (const r of responses) {
      expect(r.status).toBe(404)
      expect(await r.text()).toBe('')
    }
  })
  it('Host, proxy, Origin and Referer headers never grant an anonymous read', async () => {
    const hostVariants: Record<string, string>[] = [
      { Host: 'other.test' },
      { 'X-Forwarded-Host': 'other.test', 'X-Forwarded-Proto': 'https' },
      { Origin: server.base, Referer: `${server.base}/c/${canvasId}` },
    ]
    for (const headers of hostVariants) {
      const response = await fetch(server.base + assetPath, { headers, redirect: 'manual' })
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
    }
  })
  it('even a valid normal MCP agent credential does not authorize a cookie-less file URL', async () => {
    const key = await (await alice.post('/api/agent-keys', { name: 'File non-authority' })).json()
    expect(key.secret).toBeTruthy()
    try {
      const response = await fetch(server.base + assetPath, {
        headers: { Authorization: `Bearer ${key.secret}` },
        redirect: 'manual',
      })
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
    } finally {
      await alice.delete(`/api/agent-keys/${key.id}`)
    }
  })
  it('expired browser sessions fail before a warmed asset can be reused', async () => {
    const user = (await fixture!.db.query('SELECT id FROM "user" WHERE email=$1', ['private-a@test.dev'])).rows[0]
    const sessions = (await fixture!.db.query('SELECT * FROM "session" WHERE user_id=$1', [user.id])).rows
    expect(sessions.length).toBeGreaterThan(0)
    try {
      await fixture!.db.query('UPDATE "session" SET expires_at=now()-interval \'1 day\' WHERE user_id=$1', [user.id])
      const r = await alice.get(assetPath)
      expect(r.status).toBe(404)
      expect(await r.text()).toBe('')
    } finally {
      for (const row of sessions)
        await fixture!.db.query(
          'INSERT INTO "session" SELECT * FROM json_populate_record(NULL::"session",$1::json) ON CONFLICT (id) DO UPDATE SET expires_at=EXCLUDED.expires_at',
          [JSON.stringify(row)],
        )
    }
  })
  it('current account bans deny previously warm bytes', async () => {
    expect((await alice.get(assetPath)).status).toBe(200)
    const user = (await fixture!.db.query('SELECT id FROM "user" WHERE email=$1', ['private-a@test.dev'])).rows[0]
    try {
      await fixture!.db.query('UPDATE "user" SET banned=true WHERE id=$1', [user.id])
      const r = await alice.get(assetPath)
      expect(r.status).toBe(404)
      expect(await r.text()).toBe('')
    } finally {
      await fixture!.db.query('UPDATE "user" SET banned=false WHERE id=$1', [user.id])
    }
  })
  it('normal account database outage returns bounded availability with no SQL, file metadata or validator', async () => {
    expect((await alice.get(assetPath)).status).toBe(200)
    try {
      await fixture!.db.query('ALTER TABLE "user" RENAME COLUMN banned TO test_unavailable_banned')
      const r = await alice.get(assetPath)
      expect(r.status).toBe(503)
      expect(await r.text()).toBe('{"error":"private read is temporarily unavailable"}')
      expect(r.headers.get('etag')).toBeNull()
      expect(r.headers.get('location')).toBeNull()
      expect(r.headers.get('cache-control')).toBe('private, no-store')
    } finally {
      await fixture!.db.query('ALTER TABLE "user" RENAME COLUMN test_unavailable_banned TO banned')
    }
  })
})
