import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import type { FrameChange, FrameDrag, FrameSnapshot, FrameWrite } from '../src/actor.ts'
import * as schema from '../server/db/schema.ts'
import { frameActor, prepareFrameSocket } from '../server/frame-sync.ts'

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

it.skipIf(!process.env.DOOP_TEST_POSTGRES_URL)(
  'edits over authorized browser sockets, reads by backend RPC, and recovers after an app restart',
  async () => {
    const admin = new pg.Client({ connectionString: process.env.DOOP_TEST_POSTGRES_URL })
    const database = `doop_sync_${randomUUID().replaceAll('-', '')}`
    const servers: Server[] = []
    const sockets: WebSocket[] = []
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
      // Create after both replicas boot: discovery must use the existing SQL metadata.
      const canvas = await json<Canvas>(owner.post('/api/canvases', { name: 'Actor proof' }))
      expect((await new Client(a).get(`/api/canvases/${canvas.id}/actor`)).status).toBe(401)
      const stranger = await new Client(a).signUp('stranger@canvas-sync.test', 'Stranger')
      expect((await stranger.get(`/api/canvases/${canvas.id}/actor`)).status).toBe(403)
      async function join(client: Client) {
        const grant = await json<{ websocketUrl: string }>(client.get(`/api/canvases/${canvas.id}/actor`))
        const socket = new WebSocket(grant.websocketUrl)
        sockets.push(socket)
        const events: (FrameSnapshot | FrameChange | FrameDrag)[] = []
        socket.on('error', () => {})
        socket.on('message', (data) => {
          const event = JSON.parse(String(data))
          if (event.type === 'snapshot' || event.type === 'drag') events.push(event)
          if (event.type === 'state_update' && event.changes.committed) events.push(event.changes.committed)
        })
        await until(() => events.some((event) => event.type === 'snapshot'))
        return {
          events,
          preview(drag: FrameDrag) {
            socket.send(JSON.stringify(drag))
          },
          async write(write: FrameWrite) {
            const requestId = randomUUID()
            socket.send(JSON.stringify({ type: 'write', requestId, write }))
            await until(() => events.some((event) => event.type === 'change' && event.requestId === requestId))
            return (events.find((event) => event.type === 'change' && event.requestId === requestId) as FrameChange)
              .frame
          },
        }
      }
      const [left, right] = await Promise.all([join(owner), join(peer)])
      const frame = await left.write({ type: 'create', input: { name: 'Shared', html: '' } })
      expect(frame.updatedBy).toBe('Owner')
      await until(() => right.events.some((event) => event.type === 'change' && event.frame.id === frame.id))
      const drag: FrameDrag = {
        type: 'drag',
        frameId: frame.id,
        x: 300,
        y: 250,
        width: 750,
        height: 500,
        updatedAt: frame.updatedAt,
      }
      left.preview(drag)
      await until(() => right.events.some((event) => event.type === 'drag' && event.x === 300))
      expect(left.events.some((event) => event.type === 'drag')).toBe(false)
      expect(await frameActor(canvas.id).snapshot()).toMatchObject({ revision: 1, frames: [frame] })
      left.preview({ ...drag, width: -1 })
      left.preview({ ...drag, frameId: 'another-canvas.frame' })
      const readOnly = await prepareFrameSocket({
        actorId: canvas.id,
        metadata: { actor: { name: 'Viewer', kind: 'user', color: '#123456' }, readOnly: true },
      })
      const viewer = new WebSocket(readOnly.websocketUrl)
      sockets.push(viewer)
      let denied = false
      viewer.on('message', (data) => {
        if (JSON.parse(String(data)).type === 'error') denied = true
      })
      await new Promise<void>((resolve) => viewer.once('open', resolve))
      viewer.send(JSON.stringify({ ...drag, x: 999 }))
      viewer.send(JSON.stringify({ type: 'write', requestId: randomUUID(), write: { type: 'delete', id: frame.id } }))
      await until(() => denied)
      expect((await frameActor(canvas.id).snapshot()).frames).toEqual([frame])
      await json(owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '<main>', start: true }))
      // Untyped browser payloads must not replace frame identity or ownership.
      const patch = { x: 450, width: 777, id: 'forged', canvasId: 'another-canvas' }
      await Promise.all([
        json(owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '<h1>Live</h1>' })),
        right.write({ type: 'update', id: frame.id, patch }),
      ])
      await Promise.all([
        json(owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '<p>First</p>' })),
        json(peer.post(`/api/frames/${frame.id}/append`, { html_chunk: '<p>Second</p>' })),
      ])
      await json(owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '</main>', done: true }))
      let saved = (await json<Canvas>(owner.get(`/api/canvases/${canvas.id}`))).frames[0]!
      expect(saved).toMatchObject({ x: 450, width: 777 })
      for (const text of ['<h1>Live</h1>', '<p>First</p>', '<p>Second</p>']) expect(saved.html).toContain(text)
      for (const { events } of [left, right])
        await until(() =>
          events.some((event) => event.type === 'change' && event.frame.html === saved.html && event.frame.x === 450),
        )
      expect((await json<Canvas>(peer.get(`/api/canvases/${canvas.id}`))).frames).toEqual([saved])
      // A delayed preview from before the durable edit must not move the frame back.
      left.preview(drag)
      saved = await left.write({ type: 'update', id: frame.id, patch: { y: 260 } })
      await until(() => right.events.some((event) => event.type === 'change' && event.frame.y === 260))
      expect(right.events.filter((event) => event.type === 'drag')).toEqual([drag])
      sql = new pg.Client({ connectionString: url.toString() })
      await sql.connect()
      expect((await sql.query('SELECT id FROM frames WHERE id=$1', [frame.id])).rowCount).toBe(0)
      // SQL is only the cutover source; a stale row cannot become current state.
      await drizzle(sql)
        .insert(schema.frames)
        .values({ ...saved, html: '<p>Stale SQL copy</p>', x: 0 })
      const dataDir = a.dataDir
      a.stop({ keepData: true, signal: 'SIGKILL' })
      await a.stopped
      // The browser's actor connection survives the Doop server that issued it.
      saved = await left.write({ type: 'update', id: frame.id, patch: { x: 900 } })
      expect((await json<Canvas>(peer.get(`/api/canvases/${canvas.id}`))).frames).toEqual([saved])
      a = await startServer(portA, env, dataDir)
      servers.push(a)
      const restored = new Client(a)
      restored.cookies = new Map(owner.cookies)
      expect((await json<Canvas>(restored.get(`/api/canvases/${canvas.id}`))).frames).toEqual([saved])
      const rejoined = await join(restored)
      expect(rejoined.events[0]).toMatchObject({ type: 'snapshot', frames: [saved] })
      await rejoined.write({ type: 'delete', id: frame.id })
      await until(() => right.events.some((event) => event.type === 'change' && event.operation === 'delete'))
      expect((await json<Canvas>(peer.get(`/api/canvases/${canvas.id}`))).frames).toEqual([])
      await json(restored.delete(`/api/canvases/${canvas.id}`))
      await until(() => right.events.some((event) => event.type === 'snapshot' && event.deleted))
      expect((await peer.get(`/api/canvases/${canvas.id}`)).status).toBe(404)
    } finally {
      for (const socket of sockets) socket.terminate()
      for (const server of servers) server.stop()
      await Promise.all(servers.map((server) => server.stopped))
      await sql?.end()
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      await admin.end()
    }
  },
  120_000,
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
      for (const frame of frames) expect((await frameActor(frame.canvasId).snapshot()).initialized).toBe(false)
      expect((await frameActor(emptyId).snapshot()).initialized).toBe(false)
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
      const actor = frameActor(first.canvasId)
      const opened = await Promise.all([
        json<Canvas>(owner.get(`/api/canvases/${first.canvasId}`)),
        json<Canvas>(peer.get(`/api/canvases/${first.canvasId}`)),
      ])
      for (const canvas of opened) expect(canvas.frames).toEqual([first])
      expect((await sql.query('SELECT * FROM frames ORDER BY id')).rows).toEqual(source)
      expect(await actor.snapshot()).toMatchObject({ initialized: true, revision: 0, frames: [first] })
      await json(owner.patch(`/api/frames/${first.id}`, { x: 900 }))
      expect((await actor.initialize([first])).frames[0]).toMatchObject({ x: 900, html: first.html })
      await sql.query('UPDATE frames SET html=$1 WHERE id=$2', ['stale SQL', first.id])
      expect((await json<Canvas>(peer.get(`/api/canvases/${first.canvasId}`))).frames[0]?.html).toBe(first.html)

      // A failed source read leaves initialization retryable; existing actors
      // keep working without consulting the legacy frame contents.
      await sql.query('ALTER TABLE frames RENAME TO frames_unavailable')
      try {
        expect((await owner.get(`/api/canvases/${frames[1]!.canvasId}`)).status).toBe(503)
        expect((await frameActor(frames[1]!.canvasId).snapshot()).initialized).toBe(false)
        expect((await json<Canvas>(peer.get(`/api/canvases/${first.canvasId}`))).frames[0]?.x).toBe(900)
      } finally {
        await sql.query('ALTER TABLE frames_unavailable RENAME TO frames')
      }
      // A browser grant also passes through initialization before connecting.
      await json(owner.get(`/api/canvases/${frames[1]!.canvasId}/actor`))
      expect((await frameActor(frames[1]!.canvasId).snapshot()).frames).toEqual([frames[1]])
      await json(owner.get(`/api/canvases/${emptyId}/actor`))
      expect(await frameActor(emptyId).snapshot()).toMatchObject({ initialized: true, frames: [] })
      await db.insert(schema.frames).values({ ...first, id: `${prefix}-late`, canvasId: emptyId })
      expect((await json<Canvas>(peer.get(`/api/canvases/${emptyId}`))).frames).toEqual([])
      await json(owner.delete(`/api/frames/${first.id}`))
      expect((await actor.initialize([first])).frames).toEqual([])
      await frameActor(frames[1]!.canvasId).destroy()
      expect((await frameActor(frames[1]!.canvasId).initialize([frames[1]!])).deleted).toBe(true)
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
      expect((await frameActor(frames[2]!.canvasId).snapshot()).initialized).toBe(false)
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
