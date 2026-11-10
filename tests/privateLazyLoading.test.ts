import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=',
  'base64',
)
const marker = 'Private cold canvas marker'
let fixture: Awaited<ReturnType<typeof startPrivateServer>>
let owner: Client
let member: Client
let foreign: Client
let canvasId: string
let workspaceId: string
let frameId: string
let memberId: string
let assetPath: string
let coldLoaded: number
const stats = async () =>
  (await fetch(fixture.server.base + '/healthz/store')).json() as Promise<{
    loaded: number
    loading: number
    held: number
  }>

beforeAll(async () => {
  fixture = await startPrivateServer()
  owner = await new Client(fixture.server).signUp('lazy-owner@test.dev', 'Owner')
  member = await new Client(fixture.server).signUp('lazy-member@test.dev', 'Member')
  foreign = await new Client(fixture.server).signUp('lazy-foreign@test.dev', 'Foreign')
  memberId = (await (await member.get('/api/me')).json()).id
  workspaceId = (await (await owner.post('/api/workspaces', { name: 'Cold private workspace' })).json()).id
  expect((await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'lazy-member@test.dev' })).status).toBe(
    200,
  )
  canvasId = (await (await owner.post('/api/canvases', { name: marker, workspaceId })).json()).id
  const upload = await owner.req(`/api/canvases/${canvasId}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG),
  })
  expect(upload.status).toBe(200)
  assetPath = new URL((await upload.json()).url).pathname
  const created = await owner.post(`/api/canvases/${canvasId}/frames`, {
    name: marker,
    width: 320,
    height: 240,
    html: `<html><body><h1>${marker}</h1><img src="${assetPath}"></body></html>`,
    rotation: 30,
  })
  expect(created.status).toBe(200)
  frameId = (await created.json()).id
  await fixture.restart()
  coldLoaded = (await stats()).loaded
}, 60_000)

afterAll(async () => {
  await fixture?.close()
})

it('denies foreign HTTP and socket requests without loading the cold private canvas', async () => {
  expect((await foreign.get(`/api/canvases/${canvasId}`)).status).toBe(403)
  expect(await foreign.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4403 })
  expect((await fetch(fixture.server.base + `/api/canvases/${canvasId}`)).status).toBe(401)
  expect((await stats()).loaded).toBe(coldLoaded)
  expect((await stats()).held).toBe(0)
})

it('renders an authorized cold frame at a fractional scale with its private asset, without hydrating its canvas', async () => {
  const image = await owner.get(`/i/${frameId}.png?scale=1.5`)
  expect(image.status).toBe(200)
  const bytes = Buffer.from(await image.arrayBuffer())
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([480, 360])
  expect((await stats()).loaded).toBe(coldLoaded)
  expect(Buffer.from(await (await owner.get(assetPath)).arrayBuffer())).toEqual(PNG)
  expect((await foreign.get(`/i/${frameId}.png?scale=1.5`)).status).toBe(404)
}, 30_000)

it('rechecks membership after a blocked HTML load and releases the request hold', async () => {
  await fixture.db.query('BEGIN')
  await fixture.db.query('LOCK TABLE frames IN ACCESS EXCLUSIVE MODE')
  const pending = member.get(`/api/canvases/${canvasId}`)
  try {
    await expect.poll(async () => (await stats()).loading, { timeout: 5000 }).toBe(1)
    expect((await stats()).held).toBe(1)
    expect((await owner.delete(`/api/workspaces/${workspaceId}/members/${memberId}`)).status).toBe(200)
  } finally {
    await fixture.db.query('ROLLBACK')
  }
  const response = await pending
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain(marker)
  await expect.poll(async () => (await stats()).held).toBe(0)
  expect((await member.get(assetPath)).status).toBe(404)
  expect((await member.get(`/i/${frameId}.png`)).status).toBe(404)
  const allowed = await owner.get(`/api/canvases/${canvasId}`)
  expect(allowed.status).toBe(200)
  const canvas = await allowed.json()
  expect(canvas.frames.find((frame: { id: string }) => frame.id === frameId).rotation).toBe(30)
  expect(JSON.stringify(canvas)).toContain(marker)
}, 30_000)
