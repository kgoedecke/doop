import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { startLocalActors } from 'terse-sdk/dev'
import WebSocket from 'ws'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { Canvas, CanvasPageInfo, Frame, FrameVersionInfo } from '../shared/types.ts'
import type { CanvasEvent, FrameDrag, FrameEdit } from '../src/actor.ts'
import type { ServerMessage } from '../shared/types.ts'
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
  server = await startServer({ ADMIN_EMAILS: 'admin@frame-actors.test' })
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
  /* a reboot on the same data dir keeps its port, so cookies and origins stay valid */
  server = await startServer(env, dataDir)
  owner = new Client(server)
  owner.cookies = new Map(cookies)
}

const createFrame = (name = 'Frame') =>
  json<Frame>(owner.post(`/api/canvases/${canvas.id}/frames`, { name, html: '<main>Original</main>' }))
const readCanvas = () => json<Canvas>(owner.get(`/api/canvases/${canvas.id}`))
const actorRoute = () => `/api/canvases/${canvas.id}/actor`

type SyncEvent = CanvasEvent | FrameDrag | { type: 'error'; requestId: string; message: string }

async function joinActor(client = owner) {
  const { websocketUrl } = await json<{ websocketUrl: string }>(client.get(actorRoute()))
  const socket = new WebSocket(websocketUrl)
  sockets.push(socket)
  const events: SyncEvent[] = []
  socket.on('error', () => {})
  socket.on('message', (data) => {
    const event = JSON.parse(String(data)) as SyncEvent | { type: 'state_update'; changes: { committed?: SyncEvent } }
    if (event.type === 'state_update') {
      if (event.changes.committed) events.push(event.changes.committed)
    } else if (['canvas-snapshot', 'drag', 'error'].includes(event.type)) events.push(event)
  })
  await until(() => events.some((event) => event.type === 'canvas-snapshot'))
  async function write(frameId: string, write: FrameEdit) {
    const requestId = randomUUID()
    socket.send(JSON.stringify({ type: 'write', frameId, write, requestId }))
    await until(() => events.some((event) => 'requestId' in event && event.requestId === requestId))
    const event = events.find((event) => 'requestId' in event && event.requestId === requestId)!
    if (event.type === 'error') throw new Error(event.message)
    return event
  }
  return { events, write, send: (command: FrameDrag) => socket.send(JSON.stringify(command)) }
}

/** A /ws room client. Without `frames: 'actor'` it joins the way clients built
 *  before canvas actors do (installed iOS apps), reading frames from the room. */
async function joinRoom(frames?: 'actor') {
  const socket = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  sockets.push(socket)
  const messages: ServerMessage[] = []
  socket.on('error', () => {})
  socket.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage))
  await new Promise<void>((resolve) => socket.once('open', () => resolve()))
  socket.send(
    JSON.stringify({ type: 'join', canvasId: canvas.id, clientId: randomUUID(), name: 'Room', kind: 'user', frames }),
  )
  await until(() => messages.some((message) => message.type === 'init'))
  return { messages, send: (message: unknown) => socket.send(JSON.stringify(message)) }
}

/** The frames the canvas actor holds right now, read over a fresh socket. */
async function actorFrames(client = owner) {
  const { events } = await joinActor(client)
  const snapshot = events.find((event) => event.type === 'canvas-snapshot')!
  return snapshot.frames
}

it('creates, reads, edits, and deletes a frame through the app', async () => {
  const frame = await createFrame()
  expect((await readCanvas()).frames).toEqual([frame])
  const edited = await json<Frame>(owner.patch(`/api/frames/${frame.id}`, { name: 'Edited', html: '<p>Saved</p>' }))
  expect(edited).toMatchObject({ id: frame.id, name: 'Edited', html: '<p>Saved</p>' })
  expect((await readCanvas()).frames).toEqual([edited])
  await json(owner.delete(`/api/frames/${frame.id}`))
  expect((await readCanvas()).frames).toEqual([])
  expect(await actorFrames()).toEqual([])
})

it('syncs frame creation, edits, and deletion to two connected clients', async () => {
  const clients = await Promise.all([joinActor(), joinActor()])
  const frame = await createFrame()
  await until(() =>
    clients.every(({ events }) => events.some((e) => e.type === 'frame-change' && e.operation === 'insert')),
  )
  await clients[0]!.write(frame.id, { type: 'update', patch: { html: '<p>From first client</p>' } })
  await clients[1]!.write(frame.id, { type: 'update', patch: { name: 'From second client' } })
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
    clients.every(({ events }) => events.some((e) => e.type === 'frame-removal' && e.frameId === frame.id)),
  )
})

it('preserves both simultaneous edits to the same frame', async () => {
  const frame = await createFrame()
  const first = await joinActor()
  const second = await joinActor()
  await Promise.all([
    first.write(frame.id, { type: 'replace', find: 'Original', replacement: 'Updated' }),
    second.write(frame.id, { type: 'replace', find: '<main>', replacement: '<main class="edited">' }),
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
    expect((await actorFrames()).map((entry) => entry.id)).toEqual([frame.id])
  } finally {
    await runtime?.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 120_000)

it('allows owner edits and rejects unauthorized and read-only writes', async () => {
  const frame = await createFrame()
  const stranger = await new Client(server).signUp('stranger@frame-actors.test', 'Stranger')
  expect((await new Client(server).get(actorRoute())).status).toBe(401)
  expect((await stranger.get(actorRoute())).status).toBe(403)
  expect((await stranger.patch(`/api/frames/${frame.id}`, { name: 'Denied' })).status).toBe(403)
  const allowed = await joinActor()
  await allowed.write(frame.id, { type: 'update', patch: { name: 'Owner edit' } })
  const admin = await new Client(server).signUp('admin@frame-actors.test', 'Admin')
  const { id: userId } = await json<{ id: string }>(owner.get('/api/me'))
  await json(admin.post('/api/auth/admin/impersonate-user', { userId }))
  const readOnly = await joinActor(admin)
  expect(readOnly.events[0]).toMatchObject({ type: 'canvas-snapshot', frames: [{ name: 'Owner edit' }] })
  await expect(readOnly.write(frame.id, { type: 'update', patch: { name: 'Denied' } })).rejects.toThrow(
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
  expect(loaded.frames).toEqual([{ ...frame, pageId: canvas.pages![0]!.id }])
  expect(loaded.references).toEqual([expect.objectContaining({ frameId: frame.id, title: 'Keep this reference' })])
  await json(owner.patch(`/api/frames/${frame.id}`, { html: '<p>Edited after migration</p>' }))
  expect((await readCanvas()).frames[0]?.html).toBe('<p>Edited after migration</p>')
  await json(owner.delete(`/api/frames/${frame.id}`))
  await restartServer()
  expect((await readCanvas()).frames).toEqual([])
  expect(await actorFrames()).toEqual([])
}, 120_000)

it('moves a frame to another page in one write, keeping its history', async () => {
  const frame = await createFrame()
  /* a rewrite opens a new burst, which files the original design */
  await json(owner.patch(`/api/frames/${frame.id}`, { html: '<section>A different design entirely</section>' }))
  const history = await json<FrameVersionInfo[]>(owner.get(`/api/frames/${frame.id}/versions`))
  expect(history).toHaveLength(1)
  const first = canvas.pages![0]!
  const second: CanvasPageInfo = { id: 'second-page', name: 'Second' }
  await json(owner.put(`/api/canvases/${canvas.id}/pages`, { pages: [first, second], expectedPages: [first] }))
  const watcher = await joinActor()

  const moved = await json<Frame>(owner.patch(`/api/frames/${frame.id}`, { pageId: second.id, x: 300 }))
  expect(moved).toMatchObject({ pageId: second.id, x: 300, html: '<section>A different design entirely</section>' })
  expect((await readCanvas()).frames).toEqual([moved])
  expect(await json<FrameVersionInfo[]>(owner.get(`/api/frames/${frame.id}/versions`))).toEqual(history)
  await until(() =>
    watcher.events.some((e) => e.type === 'frame-change' && e.frame.id === frame.id && e.frame.pageId === second.id),
  )

  await watcher.write(frame.id, { type: 'update', patch: { name: 'Edited on its new page' } })
  expect((await readCanvas()).frames[0]).toMatchObject({ name: 'Edited on its new page', pageId: second.id })
  /* the first page is empty now, so it can go; the second still holds the frame */
  await json(owner.put(`/api/canvases/${canvas.id}/pages`, { pages: [second], expectedPages: [first, second] }))
  expect(
    (await owner.put(`/api/canvases/${canvas.id}/pages`, { pages: [first], expectedPages: [second] })).status,
  ).toBe(400)
})

it('keeps clients built before canvas actors in sync over the room', async () => {
  const frame = await createFrame('Shared')
  const older = await joinRoom()
  const newer = await joinRoom('actor')
  const init = (room: { messages: ServerMessage[] }) =>
    room.messages.find((message): message is Extract<ServerMessage, { type: 'init' }> => message.type === 'init')!
  expect(init(older).canvas.frames).toEqual([frame])
  expect(init(newer).canvas.frames).toEqual([])
  const editor = await joinActor()

  /* an edit written straight to the actor reaches the older client */
  await editor.write(frame.id, { type: 'update', patch: { html: '<p>Written to the actor</p>' } })
  await until(() =>
    older.messages.some((m) => m.type === 'frame:updated' && m.frame.html === '<p>Written to the actor</p>'),
  )
  const created = await createFrame('Added later')
  await until(() => older.messages.some((m) => m.type === 'frame:created' && m.frame.id === created.id))

  /* drags cross in both directions */
  const saved = (await readCanvas()).frames.find((entry) => entry.id === frame.id)!
  editor.send({ type: 'drag', frameId: frame.id, x: 400, y: 10, width: 640, height: 480, updatedAt: saved.updatedAt })
  await until(() => older.messages.some((m) => m.type === 'frame:drag' && m.x === 400))
  older.send({ type: 'frame:drag', frameId: frame.id, x: 500, y: 10, width: 640, height: 480 })
  await until(() => editor.events.some((e) => e.type === 'drag' && e.x === 500))

  await json(owner.delete(`/api/frames/${created.id}`))
  await until(() => older.messages.some((m) => m.type === 'frame:deleted' && m.frameId === created.id))
  /* the newer room client gets none of the room frame messages */
  expect(newer.messages.filter((m) => m.type.startsWith('frame:') && m.type !== 'frame:streaming')).toEqual([])
})
