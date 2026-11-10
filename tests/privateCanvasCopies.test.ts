import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { visitPrivateReferences } from '../shared/privateReferences.ts'
import { Client } from './harness.ts'
import { woff2 } from './fontFiles.ts'
import { startPrivateServer } from './privateServer.ts'
import type { Canvas } from '../shared/types.ts'
import type { CustomFont } from '../shared/fonts.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=',
  'base64',
)
let fixture: Awaited<ReturnType<typeof startPrivateServer>>
let owner: Client
let copier: Client
let foreign: Client

beforeAll(async () => {
  fixture = await startPrivateServer()
  owner = await new Client(fixture.server).signUp('copy-source@test.dev', 'Source owner')
  copier = await new Client(fixture.server).signUp('copy-target@test.dev', 'Copy owner')
  foreign = await new Client(fixture.server).signUp('copy-foreign@test.dev', 'Other company')
}, 60_000)
afterAll(async () => {
  await fixture?.close()
})

async function makeSource(name: string) {
  const created = await owner.post('/api/canvases', { name })
  expect(created.status).toBe(200)
  const canvas = (await created.json()) as Canvas
  expect((await owner.post(`/api/canvases/${canvas.id}/members`, { email: 'copy-target@test.dev' })).status).toBe(200)
  const upload = await owner.req(`/api/canvases/${canvas.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG),
  })
  expect(upload.status).toBe(200)
  const { url } = await upload.json()
  const fontBytes = woff2({ family: 'Copy Face' })
  const fontUpload = await owner.req(`/api/fonts?canvas=${canvas.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'copy.woff2' },
    body: new Uint8Array(fontBytes),
  })
  expect(fontUpload.status).toBe(200)
  const font = (await fontUpload.json()) as CustomFont
  const tokens = await owner.post(`/api/canvases/${canvas.id}/tokens`, {
    tokens: [{ name: '--hero-image', type: 'color', value: `url("${url}")`, themes: { dark: `url("${url}")` } }],
  })
  expect(tokens.status).toBe(200)
  expect((await tokens.json()).results[0].result).toBe('created')
  const frameResponse = await owner.post(`/api/canvases/${canvas.id}/frames`, {
    name: 'Owned images and font',
    html: `<html><head><style>.picture{background:url("${url}")}</style></head><body><h1 style="font-family:'Copy Face'">Copy</h1><img srcset="${url} 1x"><svg><image href="${url}" /></svg><pre>${url}</pre></body></html>`,
  })
  expect(frameResponse.status).toBe(200)
  const frame = await frameResponse.json()
  expect((await owner.post(`/api/canvases/${canvas.id}/references`, { frameId: frame.id })).status).toBe(200)
  return {
    canvas: (await (await owner.get(`/api/canvases/${canvas.id}`)).json()) as Canvas,
    url: url as string,
    font,
    fontBytes,
  }
}

function privateIds(html: string): Set<string> {
  const ids = new Set<string>()
  visitPrivateReferences(html, fixture.server.base, (reference) => {
    ids.add(reference.id)
  })
  return ids
}

async function assertCopy(source: Awaited<ReturnType<typeof makeSource>>, copy: Canvas) {
  expect(copy.id).not.toBe(source.canvas.id)
  const sourceRows = (await fixture.db.query('SELECT id FROM assets WHERE canvas_id=$1', [source.canvas.id])).rows
  const copied = (await fixture.db.query('SELECT id, ext FROM assets WHERE canvas_id=$1', [copy.id])).rows
  expect(copied).toHaveLength(2)
  const ids = new Set<string>(copied.map((row) => row.id))
  for (const row of sourceRows) expect(ids.has(row.id)).toBe(false)
  expect(privateIds(copy.frames[0]!.html)).toEqual(ids)
  expect(privateIds(copy.references![0]!.html)).toEqual(ids)
  expect(copy.references![0]!.frameId).toBe(copy.frames[0]!.id)
  expect(copy.frames[0]!.html).toContain(`<pre>${source.url}</pre>`) // ordinary text stays data
  expect(copy.tokens).toHaveLength(1)
  expect(copy.tokens![0]!.value).not.toContain(source.url)
  expect(copy.tokens![0]!.themes!.dark).not.toContain(source.url)
  const fontsResponse = await copier.get(`/api/fonts?canvas=${copy.id}`)
  expect(fontsResponse.status).toBe(200)
  const fonts = (await fontsResponse.json()) as CustomFont[]
  expect(fonts).toHaveLength(1)
  expect(fonts[0]!.url).not.toBe(source.font.url)
  const font = await copier.get(new URL(fonts[0]!.url).pathname)
  expect(font.status).toBe(200)
  expect(Buffer.from(await font.arrayBuffer())).toEqual(source.fontBytes)
  const imageId = copied.find((row) => row.ext === 'png')!.id
  const image = await copier.get(`/a/${imageId}.png`)
  expect(image.status).toBe(200)
  expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG)
  expect(
    (await fixture.db.query('SELECT canvas_id FROM asset_refs WHERE frame_id=$1', [copy.frames[0]!.id])).rows,
  ).toEqual([{ canvas_id: copy.id }, { canvas_id: copy.id }])
  expect((await owner.get(`/api/canvases/${copy.id}`)).status).toBe(403)
}

it('copies each private asset once, rewrites HTML/CSS/SVG/srcset/reference/token/font carriers, and survives source deletion', async () => {
  const source = await makeSource('Independent resource source')
  expect((await foreign.post(`/api/canvases/${source.canvas.id}/duplicate`)).status).toBe(403)
  const response = await copier.post(`/api/canvases/${source.canvas.id}/duplicate`)
  expect(response.status).toBe(200)
  const copy = (await response.json()) as Canvas
  await assertCopy(source, copy)
  expect((await owner.delete(`/api/canvases/${source.canvas.id}`)).status).toBe(200)
  await fixture.restart()
  const restored = await copier.get(`/api/canvases/${copy.id}`)
  expect(restored.status).toBe(200)
  await assertCopy(source, (await restored.json()) as Canvas)
  expect((await copier.get(new URL(source.url).pathname)).status).toBe(404)
}, 20_000)

it('rolls back the whole metadata graph on DB failure, exposes bounded uncertainty, and leaves orphan objects unroutable', async () => {
  const source = await makeSource('Rejected resource source')
  await fixture.db.query(`
    CREATE FUNCTION test_rejected_copy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM canvases WHERE id=NEW.canvas_id AND name='Rejected resource source copy') THEN
        RAISE EXCEPTION 'private copy SQL sentinel';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_rejected_copy BEFORE INSERT ON assets FOR EACH ROW EXECUTE FUNCTION test_rejected_copy();
  `)
  const before = await (await copier.get('/api/canvases')).json()
  const directory = path.join(fixture.server.dataDir, 'data', 'assets')
  const existing = new Set(await readdir(directory))
  const response = await copier.post(`/api/canvases/${source.canvas.id}/duplicate`)
  expect(response.status).toBe(503)
  const body = await response.json()
  expect(body.outcome).toBe('unknown')
  expect(body.candidateId).toBeTruthy()
  expect(JSON.stringify(body)).not.toContain('private copy SQL sentinel')
  expect(await (await copier.get('/api/canvases')).json()).toEqual(before)
  for (const table of ['canvases', 'assets', 'fonts', 'frames', 'asset_refs', 'design_tokens', 'memory_references']) {
    expect(
      (
        await fixture.db.query(`SELECT * FROM ${table} WHERE ${table === 'canvases' ? 'id' : 'canvas_id'}=$1`, [
          body.candidateId,
        ])
      ).rows,
    ).toEqual([])
  }
  const orphans = (await readdir(directory)).filter((name) => !existing.has(name))
  expect(orphans).toHaveLength(2)
  for (const name of orphans) expect((await copier.get(`/a/${name}`)).status).toBe(404)
})

it('linearizes an authorized copy at transaction entry while a competing source deletion completes', async () => {
  const source = await makeSource('Held copy source')
  const LOCK = 735194
  await fixture.db.query(`
    CREATE FUNCTION test_held_copy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name='Held copy source copy' THEN PERFORM pg_advisory_xact_lock(${LOCK}); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_held_copy BEFORE INSERT ON canvases FOR EACH ROW EXECUTE FUNCTION test_held_copy();
  `)
  await fixture.db.query('SELECT pg_advisory_lock($1)', [LOCK])
  const before = await (await copier.get('/api/canvases')).json()
  let completed = false
  const copying = copier.post(`/api/canvases/${source.canvas.id}/duplicate`).finally(() => {
    completed = true
  })
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
    expect(completed).toBe(false)
    expect(await (await copier.get('/api/canvases')).json()).toEqual(before)
    expect((await owner.delete(`/api/canvases/${source.canvas.id}`)).status).toBe(200)
    expect((await fixture.db.query('SELECT id FROM canvases WHERE id=$1', [source.canvas.id])).rows).toEqual([])
  } finally {
    await fixture.db.query('SELECT pg_advisory_unlock($1)', [LOCK])
  }
  const response = await copying
  expect(response.status).toBe(200)
  await assertCopy(source, (await response.json()) as Canvas)
}, 20_000)
