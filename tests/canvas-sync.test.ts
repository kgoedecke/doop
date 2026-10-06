import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import type { FrameChange, FrameSnapshot, FrameEdit, FrameDrag, IndexSnapshot } from '../src/actor.ts'
import * as schema from '../server/db/schema.ts'
import { canvasIndex, frameActor, prepareCanvasSocket, prepareFrameSocket } from '../server/frame-sync.ts'

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

type SyncEvent =
  IndexSnapshot | FrameSnapshot | FrameChange | FrameDrag | { type: 'error'; requestId: string; message: string }

async function joinActor(websocketUrl: string, sockets: WebSocket[]) {
  const socket = new WebSocket(websocketUrl)
  sockets.push(socket)
  const events: SyncEvent[] = []
  socket.on('error', () => {})
  socket.on('message', (data) => {
    const event = JSON.parse(String(data)) as SyncEvent | { type: 'state_update'; changes: { committed?: SyncEvent } }
    if (event.type === 'state_update') {
      if (event.changes.committed) events.push(event.changes.committed)
    } else if (['index-snapshot', 'frame-snapshot', 'drag', 'error'].includes(event.type)) events.push(event)
  })
  await until(() => events.some((event) => event.type === 'index-snapshot' || event.type === 'frame-snapshot'))
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

it.skipIf(!process.env.DOOP_TEST_POSTGRES_URL)(
  'synchronizes authorized edits across app servers, socket transports, and restarts',
  async () => {
    const admin = new pg.Client({ connectionString: process.env.DOOP_TEST_POSTGRES_URL })
    const database = `doop_sync_${randomUUID().replaceAll('-', '')}`
    const servers: Server[] = [],
      sockets: WebSocket[] = []
    let created = false
    let sql: pg.Client | undefined
    try {
      await admin.connect()
      await admin.query(`CREATE DATABASE "${database}"`)
      created = true
      const url = new URL(process.env.DOOP_TEST_POSTGRES_URL!)
      url.pathname = `/${database}`
      const portA = await port(),
        portB = await port()
      const env = {
        DATABASE_URL: url.toString(),
        BETTER_AUTH_SECRET: 'canvas-sync-qa-shared-session-secret',
        BETTER_AUTH_URL: `http://localhost:${portA}`,
        TRUSTED_ORIGINS: `http://localhost:${portA},http://localhost:${portB}`,
      }
      let a = await startServer(portA, env)
      servers.push(a)
      const owner = await new Client(a).signUp('owner@canvas-sync.test', 'Owner')
      const localActors = process.env.DOOP_TEST_ACTORS !== 'external'
      const b = await startServer(portB, {
        ...env,
        ...(localActors ? { DOOP_LOCAL_ACTOR_URL: process.env.DURABLE_ACTORS_CONTROL_PLANE_URL! } : {}),
      })
      servers.push(b)
      const peer = new Client(b)
      peer.cookies = new Map(owner.cookies)
      const canvas = await json<Canvas>(owner.post('/api/canvases', { name: 'Frame actors' }))
      const stranger = await new Client(a).signUp('stranger@canvas-sync.test', 'Stranger')
      expect((await new Client(a).get(`/api/canvases/${canvas.id}/actor`)).status).toBe(401)
      expect((await stranger.get(`/api/canvases/${canvas.id}/actor`)).status).toBe(403)
      const join = async (client: Client, path: string) => {
        const grant = await json<{ websocketUrl: string }>(client.get(path))
        if (localActors && client === peer) expect(new URL(grant.websocketUrl).port).toBe(String(portB))
        return joinActor(grant.websocketUrl, sockets)
      }
      const [_left, right] = await Promise.all([
        join(owner, `/api/canvases/${canvas.id}/actor`),
        join(peer, `/api/canvases/${canvas.id}/actor`),
      ])
      if (localActors) {
        const rejected = new WebSocket(`ws://localhost:${portB}/api/actors/socket?key=invalid`)
        sockets.push(rejected)
        const status = await new Promise<number | undefined>((resolve, reject) => {
          rejected.once('unexpected-response', (_request, response) => {
            response.resume()
            resolve(response.statusCode)
          })
          rejected.once('open', () => reject(new Error('Invalid ticket was accepted')))
          rejected.once('error', reject)
        })
        expect(status).toBeGreaterThanOrEqual(400)
        expect(status).toBeLessThan(500)
        expect(await peer.joinWs(canvas.id)).toEqual({ kind: 'init' })
      }
      const frame = await json<Frame>(
        owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Shared', html: '<main>Initial</main>' }),
      )
      const other = await json<Frame>(
        owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Independent', html: '<p>Other</p>' }),
      )
      // Retrying the same creation ID cannot duplicate or overwrite content.
      const replay = await json<Frame>(
        owner.post(`/api/canvases/${canvas.id}/frames`, { id: frame.id, name: 'Ignored retry', html: 'stale' }),
      )
      expect(replay).toEqual(frame)
      expect((await stranger.get(`/api/frames/${frame.id}/actor`)).status).toBe(403)
      const [frameLeft, frameRight, frameOther] = await Promise.all([
        join(owner, `/api/frames/${frame.id}/actor`),
        join(peer, `/api/frames/${frame.id}/actor`),
        join(owner, `/api/frames/${other.id}/actor`),
      ])
      const index = await canvasIndex(canvas.id).snapshot()
      expect(index.frameIds).toEqual([frame.id, other.id])
      expect(JSON.stringify(index)).not.toContain('html')
      expect(JSON.stringify(index)).not.toContain('Initial')
      const drag: FrameDrag = {
        type: 'drag',
        frameId: frame.id,
        x: 300,
        y: 250,
        width: 750,
        height: 500,
        updatedAt: frame.updatedAt,
      }
      frameLeft.socket.send(JSON.stringify(drag))
      await until(() => frameRight.events.some((event) => event.type === 'drag' && event.x === 300))
      expect(frameLeft.events.some((event) => event.type === 'drag')).toBe(false)
      const metadata = { actor: { name: 'Viewer', kind: 'user' as const, color: '#123456' }, readOnly: true }
      const [indexGrant, frameGrant] = await Promise.all([
        prepareCanvasSocket({ actorId: canvas.id, metadata }),
        prepareFrameSocket({ actorId: frame.id, metadata }),
      ])
      const viewer = await joinActor(indexGrant.websocketUrl, sockets)
      const frameViewer = await joinActor(frameGrant.websocketUrl, sockets)
      expect(viewer.events).toContainEqual(
        expect.objectContaining({ type: 'index-snapshot', frameIds: index.frameIds }),
      )
      await expect(
        frameViewer.request({ type: 'write', write: { type: 'update', patch: { html: 'forbidden' } } }),
      ).rejects.toThrow('read only')
      const forged = { x: 450, width: 777, id: 'forged', canvasId: 'another-canvas' }
      await Promise.all([
        frameLeft.request({ type: 'write', write: { type: 'append', chunk: '<main>', start: true } }),
        frameRight.request({ type: 'write', write: { type: 'update', patch: forged } }),
        frameOther.request({ type: 'write', write: { type: 'update', patch: { html: '<p>Independent edit</p>' } } }),
      ])
      await Promise.all([
        json(owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '<p>First</p>' })),
        json(peer.post(`/api/frames/${frame.id}/append`, { html_chunk: '<p>Second</p>' })),
      ])
      await json(owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '</main>', done: true }))
      let saved = (await json<Canvas>(owner.get(`/api/canvases/${canvas.id}`))).frames.find((f) => f.id === frame.id)!
      expect(saved).toMatchObject({ id: frame.id, canvasId: canvas.id, x: 450, width: 777 })
      expect(saved.html).toContain('<p>First</p>')
      expect(saved.html).toContain('<p>Second</p>')
      await until(() =>
        frameRight.events.some((event) => event.type === 'frame-change' && event.frame.html === saved.html),
      )
      expect(
        frameOther.events
          .filter((event) => event.type === 'frame-change')
          .every((event) => event.type === 'frame-change' && event.frame.id === other.id),
      ).toBe(true)
      expect((await canvasIndex(canvas.id).snapshot()).revision).toBe(index.revision)
      expect((await frameActor(other.id).snapshot()).revision).toBe(1)
      frameLeft.socket.send(JSON.stringify(drag)) // stale layout preview
      await frameRight.request({ type: 'write', write: { type: 'update', patch: { y: 260 } } })
      expect(frameRight.events.filter((event) => event.type === 'drag')).toEqual([drag])
      // No full canvas payload travels over the collaboration socket.
      const room = new WebSocket(`ws://localhost:${portA}/ws`, { headers: { Cookie: owner.header() } })
      sockets.push(room)
      const initial = new Promise<Canvas>((resolve) =>
        room.on('message', (data) => {
          const event = JSON.parse(String(data)) as { type: string; canvas: Canvas }
          if (event.type === 'init') resolve(event.canvas)
        }),
      )
      await new Promise<void>((resolve) => room.once('open', resolve))
      room.send(JSON.stringify({ type: 'join', canvasId: canvas.id, clientId: 'test', name: 'Owner', kind: 'user' }))
      expect((await initial).frames).toEqual([])
      sql = new pg.Client({ connectionString: url.toString() })
      await sql.connect()
      expect((await sql.query('SELECT id FROM frames WHERE id=$1', [frame.id])).rowCount).toBe(0)
      await drizzle(sql)
        .insert(schema.frames)
        .values({ ...saved, html: '<p>Stale SQL</p>' })
      const dataDir = a.dataDir
      a.stop({ keepData: true, signal: 'SIGKILL' })
      await a.stopped
      await frameLeft.request({ type: 'write', write: { type: 'update', patch: { name: 'Edited with app down' } } })
      await frameLeft.request({ type: 'write', write: { type: 'update', patch: { x: 900 } } })
      saved = (await json<Canvas>(peer.get(`/api/canvases/${canvas.id}`))).frames.find((f) => f.id === frame.id)!
      expect(saved).toMatchObject({ name: 'Edited with app down', x: 900, y: 260 })
      a = await startServer(portA, env, dataDir)
      servers.push(a)
      const restored = new Client(a)
      restored.cookies = new Map(owner.cookies)
      expect(
        (await json<Canvas>(restored.get(`/api/canvases/${canvas.id}`))).frames.find((f) => f.id === frame.id),
      ).toEqual(saved)
      const rejoined = await join(restored, `/api/frames/${frame.id}/actor`)
      expect(rejoined.events[0]).toEqual(await frameActor(frame.id).snapshot())
      await json(restored.delete(`/api/frames/${frame.id}`))
      await until(() =>
        right.events.some(
          (event) => event.type === 'index-snapshot' && event.frameIds.length === 1 && event.frameIds[0] === other.id,
        ),
      )
      await until(() => frameRight.events.some((event) => event.type === 'frame-snapshot' && event.deleted))
      expect((await restored.get(`/api/frames/${frame.id}/actor`)).status).toBe(404)
      await frameActor(frame.id).initialize(frame)
      expect((await frameActor(frame.id).snapshot()).deleted).toBe(true)
      await json(restored.delete(`/api/canvases/${canvas.id}`))
      await until(() => right.events.some((event) => event.type === 'index-snapshot' && event.deleted))
      expect((await frameActor(other.id).snapshot()).deleted).toBe(true)
      expect((await peer.get(`/api/canvases/${canvas.id}`)).status).toBe(404)
      expect((await peer.get(`/api/canvases/${canvas.id}/actor`)).status).toBe(404)
    } finally {
      for (const socket of sockets) socket.terminate()
      for (const server of servers) server.stop()
      await Promise.all(servers.map((server) => server.stopped))
      await sql?.end()
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      await admin.end()
    }
  },
  180_000,
)

it('rejects an invalid edit atomically and completes an interrupted deletion without resurrection', async () => {
  const server = await startServer(await port())
  try {
    const client = await new Client(server).signUp('frames@frame-actors.test', 'Owner')
    const canvas = await json<Canvas>(client.post('/api/canvases', { name: 'Whole frames' }))
    const by = { name: 'Owner', kind: 'user' as const, color: '#123456' }
    const frame = await json<Frame>(
      client.post(`/api/canvases/${canvas.id}/frames`, { name: 'Frame', html: '<main>Original</main>' }),
    )
    const index = canvasIndex(canvas.id)
    const actor = frameActor(frame.id)
    await expect(actor.write({ type: 'update', patch: { html: 'invalid mixed edit', width: -1 } }, by)).rejects.toThrow(
      'Invalid frame width',
    )
    expect((await actor.snapshot()).frame).toEqual(frame)
    // Simulate death between durable membership removal and frame cleanup.
    await index.remove(frame.id)
    expect((await actor.snapshot()).deleted).toBe(false)
    expect((await json<Canvas>(client.get(`/api/canvases/${canvas.id}`))).frames).toEqual([])
    await until(async () => (await actor.snapshot()).deleted)
    await until(async () => (await index.pendingDeletes()).length === 0)
    expect(await index.add(frame.id)).toBe(false)
    expect(await actor.initialize(frame)).toBe(false)
    expect((await actor.snapshot()).frame).toBeNull()
  } finally {
    server.stop()
    await server.stopped
  }
}, 120_000)
