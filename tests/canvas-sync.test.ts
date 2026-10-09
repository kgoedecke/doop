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
