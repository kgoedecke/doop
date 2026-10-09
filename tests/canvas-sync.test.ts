import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { startLocalActors } from 'durable-actors/dev'
import WebSocket from 'ws'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import type { FrameChange, FrameSnapshot, FrameEdit, IndexSnapshot } from '../src/actor.ts'
import * as schema from '../server/db/schema.ts'

async function port() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return value
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return
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

let server: Server
let owner: Client
let canvas: Canvas
const sockets: WebSocket[] = []

beforeEach(async () => {
  server = await startServer(await port(), { ADMIN_EMAILS: 'admin@frame-actors.test' })
  owner = await new Client(server).signUp('owner@frame-actors.test', 'Owner')
  canvas = await json<Canvas>(owner.post('/api/canvases', { name: 'Canvas' }))
}, 70_000)

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  server?.stop({ keepData: true })
  await server?.stopped
  if (server) await rm(server.dataDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function restartServer(env: Record<string, string> = {}, whileStopped = async () => {}) {
  const { dataDir } = server
  const cookies = owner.cookies
  server.stop({ keepData: true })
  await server.stopped
  await whileStopped()
  server = await startServer(await port(), env, dataDir)
  owner = new Client(server)
  owner.cookies = new Map(cookies)
}

const createFrame = (name = 'Frame') =>
  json<Frame>(owner.post(`/api/canvases/${canvas.id}/frames`, { name, html: '<main>Original</main>' }))
const readCanvas = () => json<Canvas>(owner.get(`/api/canvases/${canvas.id}`))

type SyncEvent = IndexSnapshot | FrameSnapshot | FrameChange | { type: 'error'; requestId: string; message: string }

async function joinActor(route: string, client = owner) {
  const { websocketUrl } = await json<{ websocketUrl: string }>(client.get(route))
  const socket = new WebSocket(websocketUrl)
  sockets.push(socket)
  const events: SyncEvent[] = []
  socket.on('error', () => {})
  socket.on('message', (data) => {
    const event = JSON.parse(String(data)) as SyncEvent | { type: 'state_update'; changes: { committed?: SyncEvent } }
    if (event.type === 'state_update') {
      if (event.changes.committed) events.push(event.changes.committed)
    } else if (['index-snapshot', 'frame-snapshot', 'error'].includes(event.type)) events.push(event)
  })
  await until(() => events.some((event) => event.type === 'frame-snapshot' || event.type === 'index-snapshot'))
  async function write(write: FrameEdit) {
    const requestId = randomUUID()
    socket.send(JSON.stringify({ type: 'write', write, requestId }))
    await until(() => events.some((event) => 'requestId' in event && event.requestId === requestId))
    const event = events.find((event) => 'requestId' in event && event.requestId === requestId)!
    if (event.type === 'error') throw new Error(event.message)
    return event
  }
  return { events, write }
}

it('creates, reads, edits, and deletes a frame through the app', async () => {
  const frame = await createFrame()
  expect((await readCanvas()).frames).toEqual([frame])
  const edited = await json<Frame>(owner.patch(`/api/frames/${frame.id}`, { name: 'Edited', html: '<p>Saved</p>' }))
  expect(edited).toMatchObject({ id: frame.id, name: 'Edited', html: '<p>Saved</p>' })
  expect((await readCanvas()).frames).toEqual([edited])
  await json(owner.delete(`/api/frames/${frame.id}`))
  expect((await readCanvas()).frames).toEqual([])
  expect((await owner.get(`/api/frames/${frame.id}/actor`)).status).toBe(404)
})

it('syncs frame creation, edits, and deletion to two connected clients', async () => {
  const indexes = await Promise.all([
    joinActor(`/api/canvases/${canvas.id}/actor`),
    joinActor(`/api/canvases/${canvas.id}/actor`),
  ])
  const frame = await createFrame()
  await until(() =>
    indexes.every(({ events }) => events.some((e) => e.type === 'index-snapshot' && e.frameIds.includes(frame.id))),
  )
  const clients = await Promise.all([
    joinActor(`/api/frames/${frame.id}/actor`),
    joinActor(`/api/frames/${frame.id}/actor`),
  ])
  await clients[0]!.write({ type: 'update', patch: { html: '<p>From first client</p>' } })
  await clients[1]!.write({ type: 'update', patch: { name: 'From second client' } })
  await until(() =>
    clients.every(({ events }) =>
      events.some(
        (e) =>
          e.type === 'frame-change' &&
          e.frame.html === '<p>From first client</p>' &&
          e.frame.name === 'From second client',
      ),
    ),
  )
  await json(owner.delete(`/api/frames/${frame.id}`))
  await until(() =>
    indexes.every(({ events }) => {
      const latest = events.at(-1)
      return latest?.type === 'index-snapshot' && latest.frameIds.length === 0
    }),
  )
  await until(() => clients.every(({ events }) => events.some((e) => e.type === 'frame-snapshot' && e.deleted)))
})

it('preserves both simultaneous edits to the same frame', async () => {
  const frame = await createFrame()
  const first = await joinActor(`/api/frames/${frame.id}/actor`)
  const second = await joinActor(`/api/frames/${frame.id}/actor`)
  await Promise.all([
    first.write({ type: 'replace', find: 'Original', replacement: 'Updated' }),
    second.write({ type: 'replace', find: '<main>', replacement: '<main class="edited">' }),
  ])
  expect((await readCanvas()).frames[0]?.html).toBe('<main class="edited">Updated</main>')
})

it('keeps saved edits and deletions after the actor runtime restarts', async () => {
  // This runtime has its own directory so restarting it cannot affect other test files.
  for (const key of Object.keys(process.env)) {
    if (
      (key.startsWith('DURABLE_ACTORS_') && !['DURABLE_ACTORS_BINARY', 'DURABLE_ACTORS_CACHE_DIR'].includes(key)) ||
      /^TERSE_(ACTOR_URL|API_KEY)$/.test(key)
    )
      vi.stubEnv(key, undefined)
  }
  const dataDir = await mkdtemp(path.join(tmpdir(), 'doop-actor-persistence-'))
  const options = {
    project: process.cwd(),
    entrypoint: 'src/actor.ts',
    projectId: 'local',
    apiKey: randomUUID(),
    dataDir,
    port: await port(),
    quiet: true,
  }
  let runtime: Awaited<ReturnType<typeof startLocalActors>> | undefined
  try {
    runtime = await startLocalActors(options)
    const env = {
      TERSE_ACTOR_URL: `${runtime.connection.controlPlaneUrl}/v1/projects/local/actors`,
      TERSE_API_KEY: options.apiKey,
    }
    await restartServer(env)
    const frame = await createFrame('Saved')
    const removed = await createFrame('Deleted')
    const edited = await json<Frame>(owner.patch(`/api/frames/${frame.id}`, { html: '<p>Persisted</p>', x: 450 }))
    await json(owner.delete(`/api/frames/${removed.id}`))
    const previousPid = runtime.connection.pid
    await restartServer(env, async () => {
      await runtime!.stop()
      runtime = await startLocalActors(options)
    })
    expect(runtime.connection.pid).not.toBe(previousPid)
    expect((await readCanvas()).frames).toEqual([edited])
    expect((await owner.get(`/api/frames/${removed.id}/actor`)).status).toBe(404)
  } finally {
    await runtime?.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 120_000)

it('allows owner edits and rejects unauthorized and read-only writes', async () => {
  const frame = await createFrame()
  const stranger = await new Client(server).signUp('stranger@frame-actors.test', 'Stranger')
  for (const route of [`/api/canvases/${canvas.id}/actor`, `/api/frames/${frame.id}/actor`]) {
    expect((await new Client(server).get(route)).status).toBe(401)
    expect((await stranger.get(route)).status).toBe(403)
  }
  expect((await stranger.patch(`/api/frames/${frame.id}`, { name: 'Denied' })).status).toBe(403)
  const allowed = await joinActor(`/api/frames/${frame.id}/actor`)
  await allowed.write({ type: 'update', patch: { name: 'Owner edit' } })
  const admin = await new Client(server).signUp('admin@frame-actors.test', 'Admin')
  const { id: userId } = await json<{ id: string }>(owner.get('/api/me'))
  await json(admin.post('/api/auth/admin/impersonate-user', { userId }))
  const readOnly = await joinActor(`/api/frames/${frame.id}/actor`, admin)
  expect(readOnly.events[0]).toMatchObject({ type: 'frame-snapshot', frame: { name: 'Owner edit' } })
  await expect(readOnly.write({ type: 'update', patch: { name: 'Denied' } })).rejects.toThrow(
    'This connection is read only',
  )
  expect((await admin.patch(`/api/frames/${frame.id}`, { name: 'Denied' })).status).toBe(403)
  expect((await readCanvas()).frames[0]?.name).toBe('Owner edit')
})

it('imports legacy SQL frames and references once without restoring deleted frames', async () => {
  const frame: Frame = {
    id: randomUUID(),
    canvasId: canvas.id,
    name: 'Legacy frame',
    html: '<p>SQL content</p>',
    x: 10,
    y: 20,
    width: 640,
    height: 480,
    createdAt: 1,
    updatedAt: 2,
    updatedBy: 'Owner',
    demo: true,
  }
  await restartServer({}, async () => {
    const local = new PGlite(path.join(server.dataDir, 'data/pg'))
    try {
      const database = drizzlePglite(local, { schema })
      await database.insert(schema.frames).values(frame)
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
  })
  const loaded = await readCanvas()
  expect(loaded.frames).toEqual([frame])
  expect(loaded.references).toEqual([expect.objectContaining({ frameId: frame.id, title: 'Keep this reference' })])
  await json(owner.patch(`/api/frames/${frame.id}`, { html: '<p>Edited after migration</p>' }))
  expect((await readCanvas()).frames[0]?.html).toBe('<p>Edited after migration</p>')
  await json(owner.delete(`/api/frames/${frame.id}`))
  await restartServer()
  expect((await readCanvas()).frames).toEqual([])
  expect((await owner.get(`/api/frames/${frame.id}/actor`)).status).toBe(404)
}, 120_000)
