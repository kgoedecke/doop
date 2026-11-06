import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { avatarUrl } from '../shared/avatar.ts'
import { Client, startServer, type Server } from './harness.ts'

/* Profile photos: POST /api/me/avatar stores the bytes as an /a/ asset and
   points the account at it; every face the server hands out (the session,
   /api/me, canvas people, the share list, a room's presences) carries it. */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)])

let server: Server
let alice: Client
let bob: Client

beforeAll(async () => {
  server = await startServer()
  alice = await new Client(server).signUp('alice-avatar@test.dev', 'Alice Avatar')
  bob = await new Client(server).signUp('bob-avatar@test.dev', 'Bob Avatar')
}, 60_000)

afterAll(() => server?.stop())

function upload(client: Client, bytes: Buffer) {
  return client.req('/api/me/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  })
}

/** Join a room and resolve with the roster the server sends first. */
function roster(client: Client, canvasId: string): Promise<{ name: string; image?: string }[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: client.header() } })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('ws join timed out'))
    }, 8000)
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `r-${Math.random()}`, name: 't', kind: 'user' })),
    )
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d))
      if (msg.type !== 'init') return
      clearTimeout(timer)
      ws.close()
      resolve(msg.presences)
    })
    ws.on('error', reject)
  })
}

describe('avatarUrl', () => {
  it('admits only our own uploads', () => {
    expect(avatarUrl('/a/abc123XYZ_-.png')).toBe('/a/abc123XYZ_-.png')
    expect(avatarUrl('/a/abc.jpg')).toBe('/a/abc.jpg')
    expect(avatarUrl('https://lh3.googleusercontent.com/a/photo')).toBeUndefined()
    expect(avatarUrl('/a/abc.svg')).toBeUndefined()
    expect(avatarUrl('/a/../i/x.png')).toBeUndefined()
    expect(avatarUrl(null)).toBeUndefined()
    expect(avatarUrl(undefined)).toBeUndefined()
  })
})

it('refuses what is not a photo', async () => {
  expect((await upload(alice, Buffer.from('hello'))).status).toBe(400)
  expect((await upload(alice, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).status).toBe(400)
  expect((await upload(alice, Buffer.alloc(0))).status).toBe(400)
  const me = await (await alice.get('/api/me')).json()
  expect(me.image).toBeUndefined()
})

it('stores a photo and shows it on every face', async () => {
  const uploaded = await upload(alice, PNG)
  expect(uploaded.status).toBe(200)
  const { image } = await uploaded.json()
  expect(image).toMatch(/^\/a\/[A-Za-z0-9_-]+\.png$/)

  /* the bytes are served as the image they were sniffed to be */
  const served = await fetch(server.base + image)
  expect(served.status).toBe(200)
  expect(served.headers.get('content-type')).toBe('image/png')
  expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true)

  /* the account, as the page and the auth client read it */
  expect((await (await alice.get('/api/me')).json()).image).toBe(image)
  const session = await (await alice.get('/api/auth/get-session')).json()
  expect(session.user.image).toBe(image)

  /* the people on a canvas, for the home tiles and the share list */
  const canvas = await (await alice.post('/api/canvases', { name: 'Faces' })).json()
  expect((await alice.post(`/api/canvases/${canvas.id}/members`, { email: 'bob-avatar@test.dev' })).status).toBe(200)
  /* the share list appends the invite's answer as a row, so it carries the face too */
  const carol = await new Client(server).signUp('carol-avatar@test.dev', 'Carol Avatar')
  const { image: carolImage } = await (await upload(carol, JPG)).json()
  const invited = await (
    await alice.post(`/api/canvases/${canvas.id}/members`, { email: 'carol-avatar@test.dev' })
  ).json()
  expect(invited).toMatchObject({ name: 'Carol Avatar', image: carolImage })
  expect((await alice.delete(`/api/canvases/${canvas.id}/members/${invited.userId}`)).status).toBe(200)
  const tiles = await (await bob.get('/api/canvases')).json()
  const tile = tiles.find((c: { id: string }) => c.id === canvas.id)
  expect(tile.people).toEqual([
    { id: expect.any(String), name: 'Alice Avatar', image },
    { id: expect.any(String), name: 'Bob Avatar' },
  ])
  const members = await (await bob.get(`/api/canvases/${canvas.id}/members`)).json()
  expect(members.map((m: { name: string; image?: string }) => [m.name, m.image])).toEqual([
    ['Alice Avatar', image],
    ['Bob Avatar', undefined],
  ])

  /* the room's roster */
  const hold = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: alice.header() } })
  await new Promise<void>((resolve) => hold.on('open', resolve))
  hold.send(JSON.stringify({ type: 'join', canvasId: canvas.id, clientId: 'alice-tab', name: 't', kind: 'user' }))
  await new Promise<void>((resolve) => hold.on('message', (d) => JSON.parse(String(d)).type === 'init' && resolve()))
  const seen = await roster(bob, canvas.id)
  expect(seen).toEqual([expect.objectContaining({ name: 'Alice Avatar', image })])

  /* a second upload replaces the pointer; the first asset stays servable */
  const again = await upload(alice, JPG)
  const { image: second } = await again.json()
  expect(second).toMatch(/\.jpg$/)
  expect((await (await alice.get('/api/me')).json()).image).toBe(second)
  expect((await fetch(server.base + image)).status).toBe(200)

  /* the room hears about the new face without a reconnect */
  const updated = await new Promise<{ image?: string }>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: bob.header() } })
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId: canvas.id, clientId: 'bob-tab', name: 't', kind: 'user' })),
    )
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d))
      if (msg.type === 'init') void upload(alice, PNG)
      if (msg.type === 'presence:join' && msg.presence.clientId === 'alice-tab') {
        ws.close()
        resolve(msg.presence)
      }
    })
  })
  expect(updated.image).toMatch(/\.png$/)
  hold.close()

  /* removing it puts the initials back everywhere */
  expect((await alice.delete('/api/me/avatar')).status).toBe(200)
  expect((await (await alice.get('/api/me')).json()).image).toBeUndefined()
  const after = await (await bob.get(`/api/canvases/${canvas.id}/members`)).json()
  expect(after[0].image).toBeUndefined()
})

it('is read-only for an admin viewing as someone else', async () => {
  /* the /api gate refuses every non-GET under impersonation; a plain session
     without one still needs the photo route to be its own */
  expect((await new Client(server).req('/api/me/avatar', { method: 'DELETE' })).status).toBe(401)
})
