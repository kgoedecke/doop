import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { FrameCommand, IndexCommand } from '../src/actor'

vi.mock('../src/lib/identity', () => ({ getIdentity: () => ({ clientId: 'me', name: 'Me' }) }))
class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  sent: (FrameCommand | IndexCommand)[] = []
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(readonly url: string) {
    Socket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as FrameCommand | IndexCommand)
  }
  receive(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
  close() {
    if (this.readyState !== 1) return
    this.readyState = 3
    this.onclose?.()
  }
}
vi.stubGlobal('WebSocket', Socket)
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 })
const { useStore } = await import('../src/lib/store')
const sync = await import('../src/lib/canvas-actor')
const by = { name: 'Me', kind: 'user', color: '#123456', clientId: 'me' }
const frame = (id: string): Frame => ({
  id,
  canvasId: 'c',
  name: id,
  html: '<p>original</p>',
  x: 120,
  y: 120,
  width: 640,
  height: 480,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Me',
})
const flush = async () => {
  for (let n = 0; n < 15; n++) await Promise.resolve()
}
const socket = (path: string) => Socket.instances.find((candidate) => candidate.url.includes(path))!
const snapshot = (entry: Frame) => ({
  type: 'frame-snapshot',
  revision: 0,
  frame: entry,
  deleted: false,
  activity: [],
})
const indexSnapshot = (entries: Frame[], revision = 0) => ({
  type: 'index-snapshot',
  revision,
  frameIds: entries.map((entry) => entry.id),
  initialized: true,
  deleted: false,
  activity: [],
})

beforeEach(() => {
  Socket.instances = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({ ok: true, json: async () => ({ websocketUrl: `ws://test${url}` }) })),
  )
  useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [], createdAt: 1, updatedAt: 1 } as Canvas)
})
afterEach(() => {
  sync.disconnectFrames()
  vi.useRealTimers()
})

async function connect(entries: Frame[]) {
  const ready = sync.connectFrames('c')
  await flush()
  socket('/canvases/c/').receive(indexSnapshot(entries))
  await ready
  await flush()
  for (const entry of entries) socket(`/frames/${entry.id}/`).receive(snapshot(entry))
  await flush()
}

it('routes whole-frame edits to one owner and isolates a disconnected frame', async () => {
  const a = frame('a'),
    b = frame('b')
  await connect([a, b])
  const contentA = socket('/frames/a/'),
    contentB = socket('/frames/b/'),
    index = socket('/canvases/c/')
  const writeA = sync.writeFrame({ type: 'update', id: 'a', patch: { html: '<p>A</p>' } })
  const writeB = sync.writeFrame({ type: 'update', id: 'b', patch: { html: '<p>B</p>' } })
  const rejected = expect(writeA).rejects.toThrow('Connection lost')
  await flush()
  const commandB = contentB.sent[0]!
  expect(commandB.type).toBe('write')
  contentA.close()
  await rejected
  contentB.receive({
    type: 'state_update',
    changes: {
      committed: {
        type: 'frame-change',
        revision: 1,
        operation: 'update',
        frame: { ...b, html: '<p>B</p>', updatedAt: 2 },
        actor: by,
        requestId: 'requestId' in commandB ? commandB.requestId : '',
      },
    },
  })
  expect((await writeB).html).toBe('<p>B</p>')
  const move = sync.writeFrame({ type: 'update', id: 'b', patch: { x: 900 } })
  await flush()
  const command = contentB.sent.at(-1)!
  expect(command).toMatchObject({ type: 'write', write: { type: 'update', patch: { x: 900 } } })
  expect(contentB.sent).toHaveLength(2)
  expect(index.sent).toEqual([])
  contentB.receive({
    type: 'state_update',
    changes: {
      committed: {
        type: 'frame-change',
        revision: 2,
        operation: 'update',
        frame: { ...b, html: '<p>B</p>', x: 900, updatedAt: 3 },
        actor: by,
        requestId: 'requestId' in command ? command.requestId : '',
      },
    },
  })
  expect(await move).toMatchObject({ x: 900, html: '<p>B</p>' })
})

it('resyncs a revision gap on only the affected frame and keeps layout during an HTML reveal', async () => {
  vi.useFakeTimers()
  const a = frame('a'),
    b = frame('b')
  await connect([a, b])
  const contentA = socket('/frames/a/'),
    contentB = socket('/frames/b/'),
    index = socket('/canvases/c/')
  contentA.receive({
    type: 'state_update',
    changes: {
      committed: {
        type: 'frame-change',
        revision: 3,
        operation: 'update',
        frame: { ...a, html: '<main>gap</main>' },
        actor: by,
      },
    },
  })
  expect(contentA.sent).toEqual([{ type: 'snapshot' }])
  expect(contentB.sent).toEqual([])
  expect(index.sent).toEqual([])
  contentA.receive({ ...snapshot(a), revision: 3 })
  contentA.receive({
    type: 'state_update',
    changes: {
      committed: {
        type: 'frame-change',
        revision: 4,
        operation: 'update',
        frame: { ...a, html: '<main>Brand new generated design</main>', updatedAt: 2 },
        actor: { ...by, kind: 'agent', clientId: 'agent' },
      },
    },
  })
  contentA.receive({
    type: 'state_update',
    changes: {
      committed: {
        type: 'frame-change',
        revision: 5,
        operation: 'update',
        frame: { ...a, html: '<main>Brand new generated design</main>', x: 800, updatedAt: 3 },
        actor: by,
      },
    },
  })
  await vi.advanceTimersByTimeAsync(6000)
  expect(useStore.getState().canvas?.frames.find((entry) => entry.id === 'a')).toMatchObject({
    x: 800,
    html: '<main>Brand new generated design</main>',
  })
})

it('bounds initial frame connections and ignores late snapshots after deletion', async () => {
  const entries = Array.from({ length: 9 }, (_, n) => frame(`f${n}`))
  const ready = sync.connectFrames('c')
  await flush()
  const index = socket('/canvases/c/')
  index.receive(indexSnapshot(entries))
  await ready
  await flush()
  // Membership/order arrives before the individual frame snapshots.
  expect(useStore.getState().frameIndex).toEqual(entries.map((entry) => entry.id))
  expect(Socket.instances.filter((entry) => entry.url.includes('/frames/'))).toHaveLength(4)
  const deleted = socket('/frames/f0/')
  index.receive({
    type: 'state_update',
    changes: {
      committed: indexSnapshot(entries.slice(1), 1),
    },
  })
  deleted.receive(snapshot(entries[0]!))
  for (const entry of entries.slice(1, 4).reverse()) socket(`/frames/${entry.id}/`).receive(snapshot(entry))
  await flush()
  expect(useStore.getState().canvas?.frames.some((entry) => entry.id === 'f0')).toBe(false)
  expect(useStore.getState().canvas?.frames.map((entry) => entry.id)).toEqual(['f1', 'f2', 'f3'])
  expect(Socket.instances.filter((entry) => entry.url.includes('/frames/')).length).toBeLessThanOrEqual(8)
})

it('waits for index membership when a create response arrives before its socket notification', async () => {
  await connect([])
  const entry = frame('new')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => (init?.method === 'POST' ? entry : { websocketUrl: 'ws://test/api/frames/new/actor' }),
    })),
  )
  const created = sync.writeFrame({ type: 'create', input: { name: entry.name } })
  let complete = false
  void created.then(() => {
    complete = true
  })
  await flush()
  expect(complete).toBe(false)
  const index = socket('/canvases/c/')
  expect(index.sent.at(-1)).toEqual({ type: 'snapshot' })
  index.receive({
    type: 'state_update',
    changes: {
      committed: indexSnapshot([entry], 1),
    },
  })
  expect(await created).toEqual(entry)
  await flush()
  socket('/frames/new/').receive(snapshot(entry))
  await flush()
  expect(useStore.getState().canvas?.frames).toEqual([entry])
})
