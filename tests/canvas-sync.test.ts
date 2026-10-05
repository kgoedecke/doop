import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
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
  'cuts over existing SQL frames with interruption recovery, mismatch protection, and production startup',
  async () => {
    const admin = new pg.Client({ connectionString: process.env.DOOP_TEST_POSTGRES_URL })
    const database = `doop_cutover_${randomUUID().replaceAll('-', '')}`
    let created = false
    let sql: pg.Client | undefined
    let server: Server | undefined
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
      const frames: Frame[] = Array.from({ length: 5 }, (_, index) => ({
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
      await db.insert(schema.canvases).values(
        [...frames.map((frame) => frame.canvasId), `${prefix}-empty`].map((id) => ({
          id,
          name: 'Existing canvas',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_010_000,
        })),
      )
      await db.insert(schema.frames).values(frames)
      const apiPort = await port()
      const env = {
        DATABASE_URL: url.toString(),
        NODE_ENV: 'production',
        PORT: String(apiPort),
        BETTER_AUTH_SECRET: 'canvas-cutover-qa-shared-session-secret',
        BETTER_AUTH_URL: `http://localhost:${apiPort}`,
      }
      const args = [
        '--import',
        path.resolve('node_modules/tsx/dist/loader.mjs'),
        path.resolve('scripts/migrate-actors.ts'),
      ]
      const options = { env: { ...process.env, ...env }, timeout: 60_000 }
      const cutover = (...flags: string[]) => promisify(execFile)(process.execPath, [...args, ...flags], options)

      // Production must not silently import frames, or mutate an empty actor.
      await expect(
        promisify(execFile)(process.execPath, [...args.slice(0, 2), path.resolve('server/index.ts')], options),
      ).rejects.toThrow('migrate:actors')
      expect((await frameActor(frames[0]!.canvasId).snapshot()).initialized).toBe(false)
      await expect(cutover('--verify')).rejects.toThrow('uninitialized')
      await db.insert(schema.tasks).values({
        id: `${prefix}-task`,
        canvasId: frames[0]!.canvasId,
        agentName: 'Doop',
        color: '#123456',
        status: 'Existing task',
        startedAt: 1_700_000_000_000,
      })
      // An active SQL writer prevents the migration from taking its stable snapshot.
      await sql.query('BEGIN')
      await sql.query('LOCK TABLE frames IN ROW EXCLUSIVE MODE')
      await expect(cutover()).rejects.toThrow('could not obtain lock')
      await sql.query('ROLLBACK')
      const source = async () => ({
        frames: (await sql!.query('SELECT * FROM frames ORDER BY id')).rows,
        canvases: (await sql!.query('SELECT * FROM canvases ORDER BY id')).rows,
        tasks: (await sql!.query('SELECT * FROM tasks ORDER BY id')).rows,
      })
      const before = await source()
      // Kill the real command after its first completed canvas, then resume.
      const interrupted = spawn(process.execPath, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      interrupted.stdout.on('data', (data) => {
        output += String(data)
        if (output.includes('[cutover] Verified canvas')) interrupted.kill('SIGKILL')
      })
      interrupted.stderr.resume()
      const timer = setTimeout(() => interrupted.kill('SIGKILL'), 60_000)
      try {
        const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
          interrupted.once('error', reject)
          interrupted.once('exit', (_code, signal) => resolve(signal))
        })
        expect(signal).toBe('SIGKILL')
      } finally {
        clearTimeout(timer)
      }
      expect(output).toContain('[cutover] Verified canvas')
      expect((await frameActor(`${prefix}-empty`).snapshot()).initialized).toBe(false)
      expect((await cutover()).stdout).toContain('Verified 6 canvases and 5 frames')
      expect((await cutover('--verify')).stdout).toContain('Verified 6 canvases and 5 frames')
      expect(await source()).toEqual(before)
      for (const frame of frames) expect((await frameActor(frame.canvasId).snapshot()).frames).toEqual([frame])

      // A resumed import cannot replace a previously imported actor with different SQL.
      await sql.query('UPDATE frames SET html=$1 WHERE id=$2', ['changed after import', frames[0]!.id])
      await expect(cutover()).rejects.toThrow('SQL and actor frames differ')
      expect((await frameActor(frames[0]!.canvasId).snapshot()).frames).toEqual([frames[0]])
      await sql.query('UPDATE frames SET html=$1 WHERE id=$2', [frames[0]!.html, frames[0]!.id])
      expect((await cutover()).stdout).toContain('Verified 6 canvases and 5 frames')

      server = await startServer(apiPort, env)
      const owner = new Client(server)
      await json(
        owner.req('/api/auth/sign-up/email', {
          method: 'POST',
          headers: { Origin: server.base },
          body: JSON.stringify({ email: 'cutover@example.test', name: 'Owner', password: 'password12345' }),
        }),
      )
      const canvas = await json<Canvas>(owner.get(`/api/canvases/${frames[0]!.canvasId}`))
      expect(canvas.frames).toEqual([frames[0]])
      await json(owner.patch(`/api/frames/${frames[0]!.id}`, { x: 900 }))
      expect((await frameActor(frames[0]!.canvasId).snapshot()).frames[0]).toMatchObject({
        x: 900,
        html: frames[0]!.html,
      })
      server.stop()
      await server.stopped
      await expect(cutover()).rejects.toThrow('already accepting edits')
    } finally {
      server?.stop()
      await server?.stopped
      await sql?.end()
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      await admin.end()
    }
  },
  180_000,
)
