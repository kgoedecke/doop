import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'
import { visitPrivateReferences } from '../shared/privateReferences.ts'
import type { Frame } from '../shared/types.ts'
import type { ResourceCopyEntry, ResourceCopyResult } from '../shared/resourceCopies.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=',
  'base64',
)
let fixture: Awaited<ReturnType<typeof startPrivateServer>>
let owner: Client
let copier: Client
let outsider: Client

beforeAll(async () => {
  fixture = await startPrivateServer()
  owner = await new Client(fixture.server).signUp('clip-source@test.dev', 'Source owner')
  copier = await new Client(fixture.server).signUp('clip-target@test.dev', 'Copy owner')
  outsider = await new Client(fixture.server).signUp('clip-outsider@test.dev', 'Other company')
}, 60_000)
afterAll(async () => {
  await fixture?.close()
})

async function context() {
  const source = await (await owner.post('/api/canvases', { name: 'Clipboard source' })).json()
  const destination = await (await copier.post('/api/canvases', { name: 'Clipboard destination' })).json()
  const member = await owner.post(`/api/canvases/${source.id}/members`, { email: 'clip-target@test.dev' })
  expect(member.status).toBe(200)
  const { userId } = await member.json()
  const file = await owner.req(`/api/canvases/${source.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG),
  })
  expect(file.status).toBe(200)
  const { url } = await file.json()
  const created = await owner.post(`/api/canvases/${source.id}/frames`, {
    name: 'Snapshot',
    html: `<img src="${url}">`,
  })
  expect(created.status).toBe(200)
  const frame = (await created.json()) as Frame
  await expect
    .poll(async () => (await fixture.db.query('SELECT * FROM asset_refs WHERE frame_id=$1', [frame.id])).rowCount)
    .toBe(1)
  const entry: ResourceCopyEntry = {
    sourceFrameId: frame.id,
    sourceVersion: frame.updatedAt,
    html: `<img srcset="${url} 1x">`,
    css: `.piece{background:url("${url}")} .piece::before{content:"${url}"}`,
  }
  return {
    sourceId: source.id as string,
    destinationId: destination.id as string,
    userId: userId as string,
    frame,
    url: url as string,
    entry,
  }
}

async function copy(ctx: Awaited<ReturnType<typeof context>>, entries = [ctx.entry], actor = copier) {
  return actor.post(`/api/canvases/${ctx.destinationId}/resource-copies`, { entries })
}

async function targetCount(id: string) {
  return (await fixture.db.query('SELECT id FROM assets WHERE canvas_id=$1', [id])).rowCount
}

it('does not publish a failed metadata copy and reports uncertainty without SQL details', async () => {
  const ctx = await context()
  await fixture.db.query(`
    CREATE FUNCTION test_rejected_clip_copy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.canvas_id = '${ctx.destinationId}' THEN
        RAISE EXCEPTION 'private clipboard SQL sentinel';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_rejected_clip_copy BEFORE INSERT ON assets
      FOR EACH ROW EXECUTE FUNCTION test_rejected_clip_copy();
  `)
  const response = await copy(ctx)
  expect(response.status).toBe(503)
  const body = await response.json()
  expect(body).toMatchObject({ outcome: 'unknown', canvasId: ctx.destinationId })
  expect(body.candidateIds).toHaveLength(1)
  expect(JSON.stringify(body)).not.toContain('private clipboard SQL sentinel')
  expect(await targetCount(ctx.destinationId)).toBe(0)
  expect((await copier.get(`/a/${body.candidateIds[0]}.png`)).status).toBe(404)
  expect((await copier.get(`/api/canvases/${ctx.destinationId}`)).status).toBe(200)
  await fixture.db.query('DROP TRIGGER test_rejected_clip_copy ON assets; DROP FUNCTION test_rejected_clip_copy();')
  const retry = await copy(ctx)
  expect(retry.status).toBe(200)
  const result = (await retry.json()) as ResourceCopyResult
  expect(result.assets).toHaveLength(1)
  expect(body.candidateIds).not.toContain(result.assets[0]!.to)
  expect(await targetCount(ctx.destinationId)).toBe(1)
})

it('uses frozen source provenance and returns owned rewritten carriers before the normal destination write', async () => {
  const ctx = await context()
  expect(
    (await copier.post(`/api/canvases/${ctx.destinationId}/frames`, { name: 'Raw URL refused', html: ctx.entry.html }))
      .status,
  ).toBe(400)
  const response = await copy(ctx)
  expect(response.status).toBe(200)
  const result = (await response.json()) as ResourceCopyResult
  expect(result.canvasId).toBe(ctx.destinationId)
  expect(result.assets).toHaveLength(1)
  expect(result.assets[0]!.from).not.toBe(result.assets[0]!.to)
  const seen = new Set<string>()
  visitPrivateReferences(result.entries[0]!.html, fixture.server.base, (ref) => {
    seen.add(ref.id)
  })
  visitPrivateReferences(
    result.entries[0]!.css!,
    fixture.server.base,
    (ref) => {
      seen.add(ref.id)
    },
    'stylesheet',
  )
  expect(seen).toEqual(new Set([result.assets[0]!.to]))
  expect(result.entries[0]!.css).toContain(`content:"${ctx.url}"`) // ordinary CSS strings stay data
  const created = await copier.post(`/api/canvases/${ctx.destinationId}/frames`, {
    name: 'Authorized paste',
    html: `<style>${result.entries[0]!.css}</style>${result.entries[0]!.html}`,
  })
  expect(created.status).toBe(200)
  const loaded = await copier.get(new URL(result.assets[0]!.url).pathname)
  expect(loaded.status).toBe(200)
  expect(Buffer.from(await loaded.arrayBuffer())).toEqual(PNG)
  expect(await targetCount(ctx.destinationId)).toBe(1)
})

it('rejects legacy/ambiguous shapes, excess claims and actor fields without a compatibility decoder', async () => {
  const ctx = await context()
  for (const body of [
    { html: ctx.entry.html },
    { entries: [{ sourceFrameId: ctx.frame.id, html: ctx.entry.html }] },
    { entries: [ctx.entry], actorId: 'other-account' },
    { entries: Array.from({ length: 65 }, () => ctx.entry) },
  ])
    expect((await copier.post(`/api/canvases/${ctx.destinationId}/resource-copies`, body)).status).toBe(400)
  expect(await targetCount(ctx.destinationId)).toBe(0)
})

it('requires current source read and destination edit independently and refuses unreferenced private IDs', async () => {
  const ctx = await context()
  expect((await copy(ctx, undefined, outsider)).status).toBe(404)
  const otherDestination = await (await outsider.post('/api/canvases', { name: 'Other destination' })).json()
  expect(
    (await copier.post(`/api/canvases/${otherDestination.id}/resource-copies`, { entries: [ctx.entry] })).status,
  ).toBe(404)
  const extra = await owner.req(`/api/canvases/${ctx.sourceId}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG),
  })
  expect(extra.status).toBe(200)
  const { url } = await extra.json()
  expect((await copy(ctx, [{ ...ctx.entry, html: `<img src="${url}">`, css: '' }])).status).toBe(400)
  expect(await targetCount(ctx.destinationId)).toBe(0)
})

it('reports stale source revision as conflict and never silently copies the changed frame', async () => {
  const ctx = await context()
  expect((await owner.patch(`/api/frames/${ctx.frame.id}`, { html: '<p>changed source</p>' })).status).toBe(200)
  expect((await copy(ctx)).status).toBe(409)
  expect(await targetCount(ctx.destinationId)).toBe(0)
})

async function holdAssetRead() {
  await fixture.db.query('BEGIN')
  await fixture.db.query('LOCK TABLE assets IN ACCESS EXCLUSIVE MODE')
}
async function assetReadBlocked() {
  await expect
    .poll(
      async () => {
        // pg_stat_activity is transaction-cached, including in the lock-holder.
        // Refresh observation without releasing the production read barrier.
        await fixture.db.query('SELECT pg_stat_clear_snapshot()')
        return Number(
          (
            await fixture.db.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='relation' AND query ILIKE '%from "assets"%'`,
            )
          ).rows[0].count,
        )
      },
      { timeout: 5_000 },
    )
    .toBe(1)
}

it('rechecks source membership after a real DB-blocked asset read', async () => {
  const ctx = await context()
  await holdAssetRead()
  const copying = copy(ctx)
  try {
    await assetReadBlocked()
    expect((await owner.delete(`/api/canvases/${ctx.sourceId}/members/${ctx.userId}`)).status).toBe(200)
  } finally {
    await fixture.db.query('COMMIT')
    await (await copying).arrayBuffer()
  }
  expect((await copying).status).toBe(404)
  expect(await targetCount(ctx.destinationId)).toBe(0)
}, 15_000)

it('rechecks source revision after a real DB-blocked asset read', async () => {
  const ctx = await context()
  await holdAssetRead()
  const copying = copy(ctx)
  try {
    await assetReadBlocked()
    expect((await owner.patch(`/api/frames/${ctx.frame.id}`, { html: '<p>new revision during copy</p>' })).status).toBe(
      200,
    )
  } finally {
    await fixture.db.query('COMMIT')
    await (await copying).arrayBuffer()
  }
  expect((await copying).status).toBe(409)
  expect(await targetCount(ctx.destinationId)).toBe(0)
}, 15_000)

it('does not publish destination files when its parent is deleted during the read', async () => {
  const ctx = await context()
  await holdAssetRead()
  const copying = copy(ctx)
  let deleting: Promise<Response> | undefined
  try {
    await assetReadBlocked()
    deleting = copier.delete(`/api/canvases/${ctx.destinationId}`)
    await expect.poll(async () => (await copier.get(`/api/canvases/${ctx.destinationId}`)).status).toBe(404)
  } finally {
    await fixture.db.query('COMMIT')
    await (await copying).arrayBuffer()
  }
  expect((await copying).status).toBe(404)
  expect((await deleting!).status).toBe(200)
  expect(await targetCount(ctx.destinationId)).toBe(0)
}, 15_000)

it('rechecks the actor account after a real DB-blocked asset read', async () => {
  const ctx = await context()
  await holdAssetRead()
  let locked = true
  const copying = copy(ctx)
  try {
    await assetReadBlocked()
    await fixture.db.query('UPDATE "user" SET banned=true WHERE id=$1', [ctx.userId])
    await fixture.db.query('COMMIT')
    locked = false
    const response = await copying
    await response.arrayBuffer()
    expect(response.status).toBe(404)
    expect(await targetCount(ctx.destinationId)).toBe(0)
  } finally {
    if (locked) await fixture.db.query('COMMIT')
    await (await copying).arrayBuffer().catch(() => {})
    await fixture.db.query('UPDATE "user" SET banned=false WHERE id=$1', [ctx.userId])
  }
}, 15_000)
