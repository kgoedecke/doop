import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client } from './harness.ts'
import { woff2 } from './fontFiles.ts'
import { startPrivateServer } from './privateServer.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=',
  'base64',
)
let fixture: Awaited<ReturnType<typeof startPrivateServer>>
let owner: Client
let foreign: Client
let mcp: McpClient
let key: { id: string; secret: string }
let otherKey: { id: string; secret: string }
let canvasId: string
let foreignCanvasId: string

beforeAll(async () => {
  fixture = await startPrivateServer()
  owner = await new Client(fixture.server).signUp('resource-owner@test.dev', 'Resource Owner')
  foreign = await new Client(fixture.server).signUp('resource-foreign@test.dev', 'Foreign Company')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Private resources' })).json()).id
  foreignCanvasId = (await (await foreign.post('/api/canvases', { name: 'Foreign resources' })).json()).id
  key = await (await owner.post('/api/agent-keys', { name: 'Ticket owner' })).json()
  otherKey = await (await foreign.post('/api/agent-keys', { name: 'Foreign ticket actor' })).json()
  mcp = new McpClient({ name: 'private-resource-owner', version: '1' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${fixture.server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key.secret}` } },
    }),
  )
}, 60_000)

afterAll(async () => {
  try {
    await mcp?.close()
  } finally {
    await fixture?.close()
  }
})

async function upload(actor: Client, parent: string) {
  return actor.req(`/api/canvases/${parent}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG),
  })
}

async function ticket() {
  const result = await mcp.callTool({
    name: 'upload_asset',
    arguments: { canvas_id: canvasId, local_file: true, agent_name: 'Resource test' },
  })
  expect(result.isError).not.toBe(true)
  const block = (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')!
  const data = JSON.parse(block.text!)
  expect(data.command).toContain('$DOOP_MCP_TOKEN')
  expect(data.command).not.toContain(key.secret)
  return new URL(data.upload_url).pathname as string
}

async function redeem(path: string, secret?: string) {
  return fetch(fixture.server.base + path, {
    method: 'PUT',
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    body: new Uint8Array(PNG),
  })
}

it('stores one authoritative parent and rejects missing parents at the actual database boundary', async () => {
  const response = await upload(owner, canvasId)
  expect(response.status).toBe(200)
  const id = /\/a\/([\w-]+)\./.exec((await response.json()).url)![1]
  const row = (await fixture.db.query('SELECT * FROM assets WHERE id = $1', [id])).rows[0]
  expect(row.canvas_id).toBe(canvasId)
  await expect(fixture.db.query('UPDATE assets SET canvas_id = NULL WHERE id = $1', [id])).rejects.toMatchObject({
    code: '23502',
  })
  await expect(
    fixture.db.query('UPDATE assets SET canvas_id = $1 WHERE id = $2', ['missing-parent', id]),
  ).rejects.toMatchObject({ code: '23503' })
  expect((await upload(foreign, canvasId)).status).toBe(403)
  const frame = await (
    await foreign.post(`/api/canvases/${foreignCanvasId}/frames`, { name: 'Foreign frame', html: '<p>other</p>' })
  ).json()
  await expect
    .poll(async () => (await fixture.db.query('SELECT id FROM frames WHERE id=$1', [frame.id])).rowCount)
    .toBe(1)
  await expect(
    fixture.db.query('INSERT INTO asset_refs(asset_id, frame_id, canvas_id) VALUES ($1,$2,$3)', [
      id,
      frame.id,
      foreignCanvasId,
    ]),
  ).rejects.toMatchObject({ code: '23503', constraint: 'asset_refs_asset_id_canvas_id_assets_id_canvas_id_fk' })
})

it('refuses raw cross-canvas URLs before HTML publication even when the actor can read both canvases', async () => {
  const uploaded = await upload(owner, canvasId)
  expect(uploaded.status).toBe(200)
  const { url } = await uploaded.json()
  const destination = (await (await owner.post('/api/canvases', { name: 'Separate destination' })).json()).id
  const variants = [
    `<img src="${url}">`,
    `<img srcset="${url} 1x">`,
    `<svg><image xlink:href="${url}" /></svg>`,
    `<style>.x{background:url("${url}")}</style>`,
    `<div style="background:url('${url}')"></div>`,
    `<iframe srcdoc="&lt;img src=&quot;${url}&quot;&gt;"></iframe>`,
  ]
  for (const html of variants) {
    const result = await owner.post(`/api/canvases/${destination}/frames`, { name: 'Refused raw paste', html })
    expect(result.status).toBe(400)
  }
  expect((await (await owner.get(`/api/canvases/${destination}`)).json()).frames).toEqual([])
  const frame = await (
    await owner.post(`/api/canvases/${destination}/frames`, { name: 'Unchanged destination', html: '<p>original</p>' })
  ).json()
  expect((await owner.patch(`/api/frames/${frame.id}`, { html: variants[0] })).status).toBe(400)
  expect((await (await owner.get(`/api/canvases/${destination}`)).json()).frames[0].html).toContain('<p')
  expect((await (await owner.get(`/api/canvases/${destination}`)).json()).frames[0].html).not.toContain(url)
})

it('requires an explicit accessible parent for fonts and profile photos on the actual PostgreSQL service', async () => {
  expect((await owner.get('/api/fonts')).status).toBe(400)
  const font = await owner.req(`/api/fonts?canvas=${canvasId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'private.woff2' },
    body: new Uint8Array(woff2({ family: 'Private Face' })),
  })
  expect(font.status).toBe(200)
  const saved = await font.json()
  const row = (
    await fixture.db.query(
      'SELECT f.canvas_id AS font_parent, a.canvas_id AS asset_parent FROM fonts f JOIN assets a ON a.id=f.asset_id WHERE f.id=$1',
      [saved.id],
    )
  ).rows[0]
  expect(row).toEqual({ font_parent: canvasId, asset_parent: canvasId })
  expect((await foreign.get(`/api/fonts?canvas=${canvasId}`)).status).toBe(404)
  const avatar = (parent?: string) =>
    owner.req(`/api/me/avatar${parent ? `?canvas=${parent}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(PNG),
    })
  expect((await avatar()).status).toBe(400)
  expect((await avatar(foreignCanvasId)).status).toBe(404)
  const photo = await avatar(canvasId)
  expect(photo.status).toBe(200)
  const assetId = /\/a\/([\w-]+)\./.exec((await photo.json()).image)![1]
  expect((await fixture.db.query('SELECT canvas_id FROM assets WHERE id=$1', [assetId])).rows[0].canvas_id).toBe(
    canvasId,
  )
})

it('requires the current same-actor MCP credential in addition to a single-use ticket', async () => {
  const path = await ticket()
  expect((await redeem(path)).status).toBe(401)
  expect((await redeem(path, otherKey.secret)).status).toBe(404)
  const first = await redeem(path, key.secret)
  expect(first.status).toBe(200)
  expect((await redeem(path, key.secret)).status).toBe(410)
  const id = /\/a\/([\w-]+)\./.exec((await first.json()).url)![1]
  expect((await fixture.db.query('SELECT canvas_id FROM assets WHERE id=$1', [id])).rows[0].canvas_id).toBe(canvasId)
})

it('allows exactly one of two competing authenticated ticket redemptions', async () => {
  const path = await ticket()
  const before = Number(
    (await fixture.db.query('SELECT count(*) FROM assets WHERE canvas_id=$1', [canvasId])).rows[0].count,
  )
  const results = await Promise.all([redeem(path, key.secret), redeem(path, key.secret)])
  expect(results.map((response) => response.status).sort()).toEqual([200, 410])
  for (const response of results) await response.arrayBuffer()
  expect(
    Number((await fixture.db.query('SELECT count(*) FROM assets WHERE canvas_id=$1', [canvasId])).rows[0].count),
  ).toBe(before + 1)
  expect((await redeem(path, key.secret)).status).toBe(410)
})

it('a newly banned actor cannot redeem a ticket using a previously verified credential', async () => {
  const path = await ticket()
  const actorId = (await fixture.db.query('SELECT user_id FROM agent_keys WHERE id=$1', [key.id])).rows[0].user_id
  await fixture.db.query('UPDATE "user" SET banned=true WHERE id=$1', [actorId])
  try {
    expect((await redeem(path, key.secret)).status).toBe(401)
  } finally {
    await fixture.db.query('UPDATE "user" SET banned=false WHERE id=$1', [actorId])
  }
  expect((await redeem(path, key.secret)).status).toBe(200)
})

it.each([
  [
    'account',
    'ALTER TABLE "user" RENAME COLUMN banned TO test_unavailable_banned',
    'ALTER TABLE "user" RENAME COLUMN test_unavailable_banned TO banned',
  ],
  [
    'OAuth',
    'ALTER TABLE oauth_access_token RENAME TO test_unavailable_oauth',
    'ALTER TABLE test_unavailable_oauth RENAME TO oauth_access_token',
  ],
])(
  'reports unavailable %s authorization as bounded 503 without consuming the ticket',
  async (kind, disable, restore) => {
    const path = await ticket()
    const secret = kind === 'account' ? key.secret : 'opaque-invalid-oauth-token'
    await fixture.db.query(disable)
    try {
      const upload = await redeem(path, secret)
      expect(upload.status).toBe(503)
      expect(await upload.json()).toEqual({ error: 'MCP authentication is temporarily unavailable' })
      const request = await fetch(`${fixture.server.base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'unavailable-test',
          method: 'tools/call',
          params: { name: 'get_profile', arguments: {} },
        }),
      })
      expect(request.status).toBe(503)
      expect(request.headers.has('WWW-Authenticate')).toBe(false)
      expect(await request.json()).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'MCP authentication is temporarily unavailable' },
      })
    } finally {
      await fixture.db.query(restore)
    }
    expect((await redeem(path, key.secret)).status).toBe(200)
  },
)

it('a revoked credential cannot redeem a ticket; a fresh credential for the frozen actor can', async () => {
  const path = await ticket()
  expect((await owner.delete(`/api/agent-keys/${key.id}`)).status).toBe(200)
  expect((await redeem(path, key.secret)).status).toBe(401)
  const replacement = await (await owner.post('/api/agent-keys', { name: 'Replacement owner' })).json()
  expect((await redeem(path, replacement.secret)).status).toBe(200)
})

it('orders a competing child write and deletion through shutdown without resurrecting its frame or refs', async () => {
  const LOCK = 735193
  await fixture.db.query(`
    CREATE FUNCTION test_deleted_child_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name = 'Deleted child frame' THEN PERFORM pg_advisory_xact_lock(${LOCK}); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_deleted_child_barrier BEFORE INSERT ON frames
      FOR EACH ROW EXECUTE FUNCTION test_deleted_child_barrier();
  `)
  await fixture.db.query('SELECT pg_advisory_lock($1)', [LOCK])
  const uploaded = await upload(owner, canvasId)
  expect(uploaded.status).toBe(200)
  const { url } = await uploaded.json()
  const response = await owner.post(`/api/canvases/${canvasId}/frames`, {
    name: 'Deleted child frame',
    html: `<img src="${url}">`,
  })
  expect(response.status).toBe(200)
  const frame = await response.json()
  try {
    await expect
      .poll(async () =>
        Number(
          (
            await fixture.db.query(
              "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
            )
          ).rows[0].count,
        ),
      )
      .toBe(1)
    expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.frames.some((f: { id: string }) => f.id === frame.id)).toBe(false)
    expect((await owner.patch(`/api/frames/${frame.id}`, { html: '<p>stale claimant</p>' })).status).toBe(404)
  } finally {
    await fixture.db.query('SELECT pg_advisory_unlock($1)', [LOCK])
  }
  await fixture.restart()
  for (const table of ['frames', 'asset_refs', 'frame_versions']) {
    expect(
      (await fixture.db.query(`SELECT * FROM ${table} WHERE ${table === 'frames' ? 'id' : 'frame_id'}=$1`, [frame.id]))
        .rows,
    ).toEqual([])
  }
}, 20_000)

it('removes memory authority first, orders a competing frame write, and cascades private children before acknowledging deletion', async () => {
  const LOCK = 735192
  await fixture.db.query(`
    CREATE FUNCTION test_private_frame_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name = 'Held private frame' THEN PERFORM pg_advisory_xact_lock(${LOCK}); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_private_frame_barrier BEFORE INSERT OR UPDATE ON frames
      FOR EACH ROW EXECUTE FUNCTION test_private_frame_barrier();
  `)
  await fixture.db.query('SELECT pg_advisory_lock($1)', [LOCK])
  const uploaded = await upload(owner, canvasId)
  expect(uploaded.status).toBe(200)
  const { url } = await uploaded.json()
  const frame = await owner.post(`/api/canvases/${canvasId}/frames`, {
    name: 'Held private frame',
    html: `<img src="${url}">`,
  })
  expect(frame.status).toBe(200)
  await expect
    .poll(async () =>
      Number(
        (
          await fixture.db.query(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
          )
        ).rows[0].count,
      ),
    )
    .toBe(1)
  let completed = false
  const deleting = owner.delete(`/api/canvases/${canvasId}`).finally(() => {
    completed = true
  })
  try {
    await expect.poll(async () => (await owner.get(`/api/canvases/${canvasId}`)).status).toBe(404)
    expect(completed).toBe(false)
    expect((await upload(owner, canvasId)).status).toBe(404)
    expect((await fixture.db.query('SELECT id FROM canvases WHERE id=$1', [canvasId])).rows).toHaveLength(1)
  } finally {
    await fixture.db.query('SELECT pg_advisory_unlock($1)', [LOCK])
  }
  expect((await deleting).status).toBe(200)
  for (const table of ['canvases', 'frames', 'assets', 'asset_refs', 'fonts', 'frame_versions']) {
    expect(
      (
        await fixture.db.query(`SELECT * FROM ${table} WHERE ${table === 'canvases' ? 'id' : 'canvas_id'}=$1`, [
          canvasId,
        ])
      ).rows,
    ).toEqual([])
  }
  await expect(
    fixture.db.query('UPDATE canvases SET name=$1 WHERE id=$2 RETURNING id', ['Late mutation', canvasId]),
  ).resolves.toMatchObject({ rowCount: 0 })
  await fixture.restart()
  expect((await owner.get(`/api/canvases/${canvasId}`)).status).toBe(404)
  expect((await fixture.db.query('SELECT id FROM frames WHERE canvas_id=$1', [canvasId])).rows).toEqual([])
}, 20_000)
