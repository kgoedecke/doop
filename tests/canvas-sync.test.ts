import { createServer } from 'node:http'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { Client, startServer } from './harness.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import type { FrameChange, FrameSnapshot, FrameEdit } from '../src/actor.ts'
import * as schema from '../server/db/schema.ts'
import { canvasIndex, frameActor } from '../server/frame-sync.ts'

async function port() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return value
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Canvas did not converge')
}

async function json<T>(request: Promise<Response>): Promise<T> {
  const response = await request
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  return body as T
}

type SyncEvent = FrameSnapshot | FrameChange | { type: 'error'; requestId: string; message: string }

async function joinActor(websocketUrl: string, sockets: WebSocket[]) {
  const socket = new WebSocket(websocketUrl)
  sockets.push(socket)
  const events: SyncEvent[] = []
  socket.on('error', () => {})
  socket.on('message', (data) => {
    const event = JSON.parse(String(data)) as SyncEvent | { type: 'state_update'; changes: { committed?: SyncEvent } }
    if (event.type === 'state_update') {
      if (event.changes.committed) events.push(event.changes.committed)
    } else if (['frame-snapshot', 'error'].includes(event.type)) events.push(event)
  })
  await until(() => events.some((event) => event.type === 'frame-snapshot'))
  async function request(command: { type: 'write'; write: FrameEdit }) {
    const requestId = randomUUID()
    socket.send(JSON.stringify({ ...command, requestId }))
    await until(() => events.some((event) => 'requestId' in event && event.requestId === requestId))
    const event = events.find((event) => 'requestId' in event && event.requestId === requestId)!
    if (event.type === 'error') throw new Error(event.message)
    return event
  }
  return { socket, events, request }
}

it('recovers interrupted actor membership changes on access without resurrecting deleted frames', async () => {
  let server = await startServer(await port())
  try {
    const client = await new Client(server).signUp('frames@frame-actors.test', 'Owner')
    const canvas = await json<Canvas>(client.post('/api/canvases', { name: 'Whole frames' }))
    const by = { name: 'Owner', kind: 'user' as const, color: '#123456' }
    const frame = await json<Frame>(
      client.post(`/api/canvases/${canvas.id}/frames`, { name: 'Frame', html: '<main>Original</main>' }),
    )
    const actor = frameActor(frame.id)
    await expect(actor.write({ type: 'update', patch: { html: 'invalid mixed edit', width: -1 } }, by)).rejects.toThrow(
      'Invalid frame width',
    )
    expect((await actor.snapshot()).frame).toEqual(frame)
    const index = canvasIndex(canvas.id)
    const pendingFrame = { ...frame, id: `${canvas.id}.pending`, name: 'Recovered creation' }
    await index.reserve(pendingFrame.id)
    await frameActor(pendingFrame.id).initialize(pendingFrame)
    await index.remove(frame.id)
    expect((await index.snapshot()).frameIds).toEqual([])
    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    expect((await actor.snapshot()).deleted).toBe(false)
    server = await startServer(await port(), {}, dataDir)
    const restored = new Client(server)
    restored.cookies = new Map(client.cookies)
    await until(async () =>
      (await json<Canvas>(restored.get(`/api/canvases/${canvas.id}`))).frames.some((f) => f.id === pendingFrame.id),
    )
    await until(async () => (await actor.snapshot()).deleted)
    expect((await json<Canvas>(restored.get(`/api/canvases/${canvas.id}`))).frames.map((f) => f.id)).toEqual([
      pendingFrame.id,
    ])
    expect((await restored.post(`/api/canvases/${canvas.id}/frames`, { id: frame.id, name: 'Retry' })).status).toBe(404)
    expect(await actor.initialize(frame)).toBe(false)
    expect((await actor.snapshot()).frame).toBeNull()
    // Canvas deletion keeps SQL metadata until frame cleanup finishes, allowing a retry after a crash.
    await index.destroy()
    expect(await index.activate(pendingFrame.id)).toBe(false)
    expect(await index.reserve(`${canvas.id}.new`)).toBe(false)
    expect(await index.snapshot()).toMatchObject({ deleted: true, frameIds: [] })
    expect((await restored.get(`/api/canvases/${canvas.id}`)).status).toBe(404)
    await until(async () => (await frameActor(pendingFrame.id).snapshot()).deleted)
  } finally {
    server.stop()
    await server.stopped
  }
}, 120_000)

it('imports legacy SQL frames once, preserves references, and retries a partial import after restart', async () => {
  let server = await startServer(await port())
  const sockets: WebSocket[] = []
  try {
    const client = await new Client(server).signUp('migration@frame-actors.test', 'Owner')
    const canvas = await json<Canvas>(client.post('/api/canvases', { name: 'Legacy canvas' }))
    const frame: Frame = {
      id: randomUUID(),
      canvasId: canvas.id,
      name: 'Legacy frame',
      html: '<main>SQL content</main>',
      x: 10,
      y: 20,
      width: 640,
      height: 480,
      createdAt: 1,
      updatedAt: 2,
      updatedBy: 'Owner',
      demo: true,
    }
    const second = { ...frame, id: randomUUID(), createdAt: 3, html: '<p>Second</p>', demo: false }
    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    const local = new PGlite(path.join(dataDir, 'data/pg'))
    try {
      const database = drizzlePglite(local, { schema })
      await database.insert(schema.frames).values([frame, second])
      await database.insert(schema.memoryReferences).values({
        id: randomUUID(),
        canvasId: canvas.id,
        frameId: frame.id,
        title: 'Keep this reference',
        html: frame.html,
        width: frame.width,
        height: frame.height,
        pinnedBy: 'Owner',
        pinnedAt: 3,
      })
    } finally {
      await local.close()
    }
    // Simulate death between payload initialization and committing membership.
    const actor = frameActor(frame.id)
    await actor.initialize(frame)
    const imported = await actor.write(
      { type: 'update', patch: { html: '<main>Already imported and edited</main>' } },
      { name: 'Owner', kind: 'user', color: '#123456' },
    )
    expect((await canvasIndex(canvas.id).snapshot()).initialized).toBe(false)
    server = await startServer(await port(), {}, dataDir)
    const restored = new Client(server)
    restored.cookies = new Map(client.cookies)
    // Direct legacy frame access and a canvas open can race the first import.
    const [grant, loaded] = await Promise.all([
      json<{ websocketUrl: string }>(restored.get(`/api/frames/${frame.id}/actor`)),
      json<Canvas>(restored.get(`/api/canvases/${canvas.id}`)),
    ])
    expect(loaded.frames).toEqual([imported!.frame, second])
    expect(loaded.references).toEqual([
      expect.objectContaining({
        frameId: frame.id,
        title: 'Keep this reference',
      }),
    ])
    const joined = await joinActor(grant.websocketUrl, sockets)
    await joined.request({ type: 'write', write: { type: 'update', patch: { name: 'Edited after migration' } } })
    await json(restored.delete(`/api/frames/${frame.id}`))
    await json(restored.delete(`/api/frames/${second.id}`))
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer(await port(), {}, dataDir)
    const restarted = new Client(server)
    restarted.cookies = new Map(client.cookies)
    expect((await json<Canvas>(restarted.get(`/api/canvases/${canvas.id}`))).frames).toEqual([])
    expect((await restarted.get(`/api/frames/${frame.id}/actor`)).status).toBe(404)
  } finally {
    for (const socket of sockets) socket.terminate()
    server.stop()
    await server.stopped
  }
}, 120_000)

it('reserves distinct positions for simultaneous creates and unfinished payloads', async () => {
  const server = await startServer(await port())
  try {
    const owner = await new Client(server).signUp('placement@frame-actors.test', 'Owner')
    const canvas = await json<Canvas>(owner.post('/api/canvases', { name: 'Concurrent placement' }))
    const frames = await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        json<Frame>(owner.post(`/api/canvases/${canvas.id}/frames`, { name: `Frame ${n}` })),
      ),
    )
    const sorted = frames.sort((a, b) => a.x - b.x)
    expect(sorted[0]?.x).toBe(120)
    for (let n = 1; n < sorted.length; n++) expect(sorted[n]!.x).toBe(sorted[n - 1]!.x + sorted[n - 1]!.width + 80)
    const rightmost = sorted.at(-1)!
    const index = canvasIndex(canvas.id)
    const bounds = Object.fromEntries(frames.map(({ id, x, width }) => [id, { x, width }]))
    const candidate = { ...rightmost, id: `${canvas.id}.reserved`, width: 900 }
    const reservation = await index.reserveFrame(candidate, true, bounds)
    expect(reservation).toMatchObject({ x: rightmost.x + rightmost.width + 80, width: 900 })
    const retry = await index.reserveFrame({ ...candidate, width: 200 }, true, bounds)
    expect(retry).toEqual(reservation)
    const next = await json<Frame>(owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'After reservation' }))
    expect(next.x).toBe(rightmost.x + rightmost.width + 80 + 900 + 80)
    // A stale membership read must refresh, rather than place over a newly active frame.
    expect(await index.reserveFrame({ ...candidate, id: `${canvas.id}.stale` }, true, bounds)).toBe('retry')
    const explicit = await json<Frame>(owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Explicit', x: -50 }))
    expect(explicit.x).toBe(-50)
  } finally {
    server.stop()
    await server.stopped
  }
}, 120_000)

it('closes revoked sockets, rejects old tickets, and lets remaining users reconnect', async () => {
  const server = await startServer(await port())
  const sockets: WebSocket[] = []
  const closed = (socket: WebSocket) => new Promise<number>((resolve) => socket.once('close', resolve))
  try {
    const owner = await new Client(server).signUp('revocation-owner@frame-actors.test', 'Owner')
    const visitor = await new Client(server).signUp('revocation-visitor@frame-actors.test', 'Visitor')
    const canvas = await json<Canvas>(owner.post('/api/canvases', { name: 'Revocation' }))
    const frame = await json<Frame>(owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Protected' }))
    await json(owner.patch(`/api/canvases/${canvas.id}`, { linkAccess: 'edit' }))
    const ticket = await json<{ websocketUrl: string }>(visitor.get(`/api/frames/${frame.id}/actor`))
    const joined = await joinActor(ticket.websocketUrl, sockets)
    const indexTicket = await json<{ websocketUrl: string }>(visitor.get(`/api/canvases/${canvas.id}/actor`))
    const indexSocket = new WebSocket(indexTicket.websocketUrl)
    sockets.push(indexSocket)
    indexSocket.on('error', () => {})
    let indexReady = false
    indexSocket.on('message', (data) => {
      if (JSON.parse(String(data)).type === 'index-snapshot') indexReady = true
    })
    await until(() => indexReady)
    const frameClosed = closed(joined.socket),
      indexClosed = closed(indexSocket)
    await json(owner.patch(`/api/canvases/${canvas.id}`, { linkAccess: 'none' }))
    expect(await frameClosed).toBe(4003)
    expect(await indexClosed).toBe(4003)
    expect((await visitor.get(`/api/frames/${frame.id}/actor`)).status).toBe(403)
    expect((await visitor.patch(`/api/frames/${frame.id}`, { name: 'Denied' })).status).toBe(403)
    for (const stale of [ticket, indexTicket]) {
      const replay = new WebSocket(stale.websocketUrl)
      sockets.push(replay)
      replay.on('error', () => {})
      expect(await closed(replay)).toBe(4003)
    }
    expect((await frameActor(frame.id).snapshot()).frame?.name).toBe('Protected')
    const fresh = await json<{ websocketUrl: string }>(owner.get(`/api/frames/${frame.id}/actor`))
    const remaining = await joinActor(fresh.websocketUrl, sockets)
    await remaining.request({ type: 'write', write: { type: 'update', patch: { name: 'Owner edit' } } })
    expect((await frameActor(frame.id).snapshot()).frame?.name).toBe('Owner edit')
    await json(owner.post(`/api/canvases/${canvas.id}/members`, { email: 'revocation-visitor@frame-actors.test' }))
    const memberTicket = await json<{ websocketUrl: string }>(visitor.get(`/api/frames/${frame.id}/actor`))
    const member = await joinActor(memberTicket.websocketUrl, sockets)
    const memberClosed = closed(member.socket)
    const { id } = await json<{ id: string }>(visitor.get('/api/me'))
    await json(owner.delete(`/api/canvases/${canvas.id}/members/${id}`))
    expect(await memberClosed).toBe(4003)
    expect((await visitor.get(`/api/frames/${frame.id}/actor`)).status).toBe(403)
  } finally {
    for (const socket of sockets) socket.terminate()
    server.stop()
    await server.stopped
  }
}, 120_000)

it('returns a service error instead of hanging when actors are unavailable', async () => {
  let server = await startServer(await port())
  try {
    const owner = await new Client(server).signUp('unavailable@frame-actors.test', 'Owner')
    await json(owner.post('/api/canvases', { name: 'Unavailable' }))
    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer(
      await port(),
      { TERSE_ACTOR_URL: 'http://127.0.0.1:1/v1/projects/local/actors', TERSE_API_KEY: 'test-only' },
      dataDir,
    )
    const restored = new Client(server)
    restored.cookies = new Map(owner.cookies)
    const response = await restored.req('/api/canvases', { signal: AbortSignal.timeout(3000) })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'canvas service unavailable' })
    expect((await fetch(`${server.base}/healthz`)).status).toBe(200)
  } finally {
    server.stop()
    await server.stopped
  }
}, 120_000)
