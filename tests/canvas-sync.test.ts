import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import type {
  ContentChange,
  ContentSnapshot,
  ContentWrite,
  FrameDrag,
  IndexChange,
  IndexSnapshot,
} from '../src/actor.ts'
import { contentOf, layoutOf, type LayoutPatch } from '../shared/frame-state.ts'
import * as schema from '../server/db/schema.ts'
import {
  canvasIndex,
  frameActor,
  legacyCanvasActor,
  prepareCanvasSocket,
  prepareFrameSocket,
} from '../server/frame-sync.ts'

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
  | IndexSnapshot
  | IndexChange
  | ContentSnapshot
  | ContentChange
  | FrameDrag
  | { type: 'error'; requestId: string; message: string }

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
  async function request(
    command: { type: 'layout'; id: string; patch: LayoutPatch } | { type: 'write'; write: ContentWrite },
  ) {
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
  'isolates frame content, syncs layout separately, and recovers through app restarts and deletion',
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
      const b = await startServer(portB, env)
      servers.push(b)
      const peer = new Client(b)
      peer.cookies = new Map(owner.cookies)
      const canvas = await json<Canvas>(owner.post('/api/canvases', { name: 'Frame actors' }))
      const stranger = await new Client(a).signUp('stranger@canvas-sync.test', 'Stranger')
      expect((await new Client(a).get(`/api/canvases/${canvas.id}/actor`)).status).toBe(401)
      expect((await stranger.get(`/api/canvases/${canvas.id}/actor`)).status).toBe(403)
      const join = async (client: Client, path: string) => {
        const grant = await json<{ websocketUrl: string }>(client.get(path))
        return joinActor(grant.websocketUrl, sockets)
      }
      const [left, right] = await Promise.all([
        join(owner, `/api/canvases/${canvas.id}/actor`),
        join(peer, `/api/canvases/${canvas.id}/actor`),
      ])
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
      const [contentLeft, contentRight, contentOther] = await Promise.all([
        join(owner, `/api/frames/${frame.id}/actor`),
        join(peer, `/api/frames/${frame.id}/actor`),
        join(owner, `/api/frames/${other.id}/actor`),
      ])
      const index = await canvasIndex(canvas.id).snapshot()
      expect(index.frames).toEqual([layoutOf(frame), layoutOf(other)])
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
      left.socket.send(JSON.stringify(drag))
      await until(() => right.events.some((event) => event.type === 'drag' && event.x === 300))
      expect(left.events.some((event) => event.type === 'drag')).toBe(false)
      const metadata = { actor: { name: 'Viewer', kind: 'user' as const, color: '#123456' }, readOnly: true }
      const [indexGrant, contentGrant] = await Promise.all([
        prepareCanvasSocket({ actorId: canvas.id, metadata }),
        prepareFrameSocket({ actorId: frame.id, metadata }),
      ])
      const viewer = await joinActor(indexGrant.websocketUrl, sockets)
      const contentViewer = await joinActor(contentGrant.websocketUrl, sockets)
      await expect(viewer.request({ type: 'layout', id: frame.id, patch: { x: 999 } })).rejects.toThrow('read only')
      await expect(
        contentViewer.request({ type: 'write', write: { type: 'update', patch: { html: 'forbidden' } } }),
      ).rejects.toThrow('read only')
      const forged = { x: 450, width: 777, id: 'forged', canvasId: 'another-canvas', html: 'forbidden' }
      await Promise.all([
        contentLeft.request({ type: 'write', write: { type: 'append', chunk: '<main>', start: true } }),
        right.request({ type: 'layout', id: frame.id, patch: forged }),
        contentOther.request({ type: 'write', write: { type: 'update', patch: { html: '<p>Independent edit</p>' } } }),
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
        contentRight.events.some((event) => event.type === 'frame-change' && event.frame.html === saved.html),
      )
      expect(
        contentOther.events
          .filter((event) => event.type === 'frame-change')
          .every((event) => event.type === 'frame-change' && event.frame.id === other.id),
      ).toBe(true)
      expect((await canvasIndex(canvas.id).snapshot()).revision).toBe(index.revision + 1)
      expect((await frameActor(other.id).snapshot()).revision).toBe(1)
      left.socket.send(JSON.stringify(drag)) // stale layout preview
      await right.request({ type: 'layout', id: frame.id, patch: { y: 260 } })
      expect(right.events.filter((event) => event.type === 'drag')).toEqual([drag])
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
      await contentLeft.request({ type: 'write', write: { type: 'update', patch: { name: 'Edited with app down' } } })
      await left.request({ type: 'layout', id: frame.id, patch: { x: 900 } })
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
      await until(() => right.events.some((event) => event.type === 'index-change' && event.operation === 'delete'))
      await until(() => contentRight.events.some((event) => event.type === 'frame-snapshot' && event.deleted))
      expect((await restored.get(`/api/frames/${frame.id}/actor`)).status).toBe(404)
      await frameActor(frame.id).initialize(contentOf(frame))
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

it.skipIf(!process.env.DOOP_TEST_POSTGRES_URL)(
  'lazily initializes SQL frames once across production servers without reviving empty or deleted actors',
  async () => {
    const admin = new pg.Client({ connectionString: process.env.DOOP_TEST_POSTGRES_URL })
    const database = `doop_lazy_${randomUUID().replaceAll('-', '')}`
    const servers: Server[] = []
    let created = false
    let sql: pg.Client | undefined
    try {
      await admin.connect()
      await admin.query(`CREATE DATABASE "${database}"`)
      created = true
      const url = new URL(process.env.DOOP_TEST_POSTGRES_URL!)
      url.pathname = `/${database}`
      sql = new pg.Client({ connectionString: url.toString() })
      await sql.connect()
      const db = drizzle(sql)
      await migrate(db, { migrationsFolder: 'server/db/migrations' })
      const prefix = randomUUID()
      const frames: Frame[] = Array.from({ length: 3 }, (_, index) => ({
        id: `${prefix}-frame-${index}`,
        canvasId: `${prefix}-${index}`,
        name: `Existing design ${index} — café`,
        x: -120.5 + index,
        y: 80.25,
        width: 640,
        height: 480,
        html: `<main>你好 🌱<img src="/a/existing-asset.png">${index}</main>`,
        createdAt: 1_700_000_000_000 + index,
        updatedAt: 1_700_000_010_000 + index,
        updatedBy: 'Existing author',
        ...(index === 0 ? {} : { demo: index === 1 }),
      }))
      const emptyId = `${prefix}-empty`
      await db.insert(schema.canvases).values(
        [...frames.map((frame) => frame.canvasId), emptyId].map((id) => ({
          id,
          name: 'Existing canvas',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_010_000,
        })),
      )
      await db.insert(schema.frames).values(frames)
      const portA = await port(),
        portB = await port()
      const env = {
        DATABASE_URL: url.toString(),
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET: 'canvas-lazy-qa-shared-session-secret',
        BETTER_AUTH_URL: `http://localhost:${portA}`,
        TRUSTED_ORIGINS: `http://localhost:${portA},http://localhost:${portB}`,
      }
      let a = await startServer(portA, env)
      servers.push(a)
      const b = await startServer(portB, env)
      servers.push(b)
      for (const frame of frames) expect((await canvasIndex(frame.canvasId).snapshot()).initialized).toBe(false)
      expect((await canvasIndex(emptyId).snapshot()).initialized).toBe(false)
      const owner = new Client(a)
      await json(
        owner.req('/api/auth/sign-up/email', {
          method: 'POST',
          headers: { Origin: a.base },
          body: JSON.stringify({ email: 'lazy@example.test', name: 'Owner', password: 'password12345' }),
        }),
      )
      const peer = new Client(b)
      peer.cookies = new Map(owner.cookies)
      // Read the current SQL rows on first access, not a stale boot snapshot.
      const first = { ...frames[0]!, html: '<main>Updated after boot — 你好 🌱</main>' }
      await sql.query('UPDATE frames SET html=$1 WHERE id=$2', [first.html, first.id])
      const source = (await sql.query('SELECT * FROM frames ORDER BY id')).rows
      const actor = canvasIndex(first.canvasId)
      const opened = await Promise.all([
        json<Canvas>(owner.get(`/api/canvases/${first.canvasId}`)),
        json<Canvas>(peer.get(`/api/canvases/${first.canvasId}`)),
      ])
      for (const canvas of opened) expect(canvas.frames).toEqual([first])
      expect((await sql.query('SELECT * FROM frames ORDER BY id')).rows).toEqual(source)
      expect(await actor.snapshot()).toMatchObject({ initialized: true, revision: 0, frames: [layoutOf(first)] })
      await json(owner.patch(`/api/frames/${first.id}`, { x: 900 }))
      expect((await actor.initialize([layoutOf(first)])).frames[0]).toMatchObject({ x: 900 })
      await sql.query('UPDATE frames SET html=$1 WHERE id=$2', ['stale SQL', first.id])
      expect((await json<Canvas>(peer.get(`/api/canvases/${first.canvasId}`))).frames[0]?.html).toBe(first.html)

      // A failed source read leaves initialization retryable; existing actors
      // keep working without consulting the legacy frame contents.
      await sql.query('ALTER TABLE frames RENAME TO frames_unavailable')
      try {
        expect((await owner.get(`/api/canvases/${frames[1]!.canvasId}`)).status).toBe(503)
        expect((await canvasIndex(frames[1]!.canvasId).snapshot()).initialized).toBe(false)
        expect((await json<Canvas>(peer.get(`/api/canvases/${first.canvasId}`))).frames[0]?.x).toBe(900)
      } finally {
        await sql.query('ALTER TABLE frames_unavailable RENAME TO frames')
      }
      // A browser grant also passes through initialization before connecting.
      await json(owner.get(`/api/canvases/${frames[1]!.canvasId}/actor`))
      expect((await canvasIndex(frames[1]!.canvasId).snapshot()).frames).toEqual([layoutOf(frames[1]!)])
      await json(owner.get(`/api/canvases/${emptyId}/actor`))
      expect(await canvasIndex(emptyId).snapshot()).toMatchObject({ initialized: true, frames: [] })
      await db.insert(schema.frames).values({ ...first, id: `${prefix}-late`, canvasId: emptyId })
      expect((await json<Canvas>(peer.get(`/api/canvases/${emptyId}`))).frames).toEqual([])
      await json(owner.delete(`/api/frames/${first.id}`))
      expect((await actor.initialize([layoutOf(first)])).frames).toEqual([])
      await canvasIndex(frames[1]!.canvasId).destroy()
      expect((await canvasIndex(frames[1]!.canvasId).initialize([layoutOf(frames[1]!)])).deleted).toBe(true)
      expect((await peer.get(`/api/canvases/${frames[1]!.canvasId}`)).status).toBe(404)

      const dataDir = a.dataDir
      a.stop({ keepData: true })
      await a.stopped
      a = await startServer(portA, env, dataDir)
      servers.push(a)
      const restored = new Client(a)
      restored.cookies = new Map(owner.cookies)
      expect((await json<Canvas>(restored.get(`/api/canvases/${first.canvasId}`))).frames).toEqual([])
      expect((await json<Canvas>(restored.get(`/api/canvases/${emptyId}`))).frames).toEqual([])
      expect((await restored.get(`/api/canvases/${frames[1]!.canvasId}`)).status).toBe(404)
      expect((await canvasIndex(frames[2]!.canvasId).snapshot()).initialized).toBe(false)
      expect((await json<Canvas>(restored.get(`/api/canvases/${frames[2]!.canvasId}`))).frames).toEqual([frames[2]])
    } finally {
      for (const server of servers) server.stop()
      await Promise.all(servers.map((server) => server.stopped))
      await sql?.end()
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      await admin.end()
    }
  },
  180_000,
)

it('resumes a frozen legacy-actor migration and pending frame cleanup without restoring stale content', async () => {
  const server = await startServer(await port())
  try {
    const client = await new Client(server).signUp('migration@frame-actors.test', 'Owner')
    const canvas = await json<Canvas>(client.post('/api/canvases', { name: 'Legacy actor' }))
    const by = { name: 'Owner', kind: 'user' as const, color: '#123456' }
    const original: Frame[] = Array.from({ length: 2 }, (_, n) => ({
      id: `${canvas.id}.legacy-${n}`,
      canvasId: canvas.id,
      name: `Legacy ${n}`,
      html: `<main>${'x'.repeat(100_000)}${n}</main>`,
      x: 120 + n * 720,
      y: 120,
      width: 640,
      height: 480,
      createdAt: 100 + n,
      updatedAt: 200 + n,
      updatedBy: 'Owner',
    }))
    const legacy = legacyCanvasActor(canvas.id)
    await legacy.initialize(original)
    const exported = await legacy.migrationIndex()
    expect(exported.frames).toEqual(original.map(layoutOf))
    expect(JSON.stringify(exported)).not.toContain('html')
    await expect(
      legacy.write({ type: 'update', id: original[0]!.id, patch: { html: 'late legacy write' } }, by),
    ).rejects.toThrow()
    // Simulate process death after only the first frame was copied. A retry
    // must preserve that actor, even when its current content differs.
    await frameActor(original[0]!.id).initialize(contentOf(original[0]!))
    await frameActor(original[0]!.id).write({ type: 'update', patch: { html: '<main>Already copied</main>' } }, by)
    const restored = await json<Canvas>(client.get(`/api/canvases/${canvas.id}`))
    expect(restored.frames[0]?.html).toBe('<main>Already copied</main>')
    expect(restored.frames[1]).toEqual(original[1])
    expect((await canvasIndex(canvas.id).snapshot()).frames).toEqual(original.map(layoutOf))
    // Simulate death between durable membership removal and content cleanup.
    await canvasIndex(canvas.id).remove(original[0]!.id, by)
    expect((await frameActor(original[0]!.id).snapshot()).deleted).toBe(false)
    const remaining = await json<Canvas>(client.get(`/api/canvases/${canvas.id}`))
    expect(remaining.frames).toEqual([original[1]])
    await until(async () => (await frameActor(original[0]!.id).snapshot()).deleted)
    await until(async () => (await canvasIndex(canvas.id).pendingDeletes()).length === 0)
    expect(await canvasIndex(canvas.id).add(original[0]!.id, { createdAt: 100 }, by)).toBeNull()
    await frameActor(original[0]!.id).initialize(contentOf(original[0]!))
    expect((await frameActor(original[0]!.id).snapshot()).frame).toBeNull()
  } finally {
    server.stop()
    await server.stopped
  }
}, 120_000)
