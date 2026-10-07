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

it('keeps another frame editable after a disconnect and ignores late updates after deletion', async () => {
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
  index.receive({
    type: 'state_update',
    changes: { committed: indexSnapshot([b], 1) },
  })
  contentA.receive(snapshot(a))
  expect(useStore.getState().canvas?.frames).toEqual([{ ...b, html: '<p>B</p>', updatedAt: 2 }])
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

it('allows an immediate edit when creation finishes before its index notification', async () => {
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
  const createRequest = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')![1]!
  expect(JSON.parse(createRequest.body as string).id).toMatch(/^c\.new\.[a-f0-9-]{36}$/)
  const index = socket('/canvases/c/')
  index.receive({
    type: 'state_update',
    changes: {
      committed: indexSnapshot([entry], 1),
    },
  })
  expect(await created).toEqual(entry)
  const edited = sync.updateFrame(entry.id, { name: 'Edited immediately' })
  await flush()
  const content = socket('/frames/new/')
  content.receive(snapshot(entry))
  await flush()
  const command = content.sent.find((command) => command.type === 'write')
  if (!command || command.type !== 'write') throw new Error('The follow-up edit was not sent')
  const saved = { ...entry, name: 'Edited immediately', updatedAt: 2 }
  content.receive({
    type: 'state_update',
    changes: {
      committed: {
        type: 'frame-change',
        revision: 1,
        operation: 'update',
        frame: saved,
        actor: by,
        requestId: command.requestId,
      },
    },
  })
  expect(await edited).toEqual(saved)
  expect(useStore.getState().canvas?.frames).toEqual([saved])
})
