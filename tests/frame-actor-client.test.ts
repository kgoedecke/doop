import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { FrameCommand } from '../src/actor'

vi.mock('../src/lib/identity', () => ({ getIdentity: () => ({ clientId: 'me', name: 'Me' }) }))
class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  sent: FrameCommand[] = []
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(readonly url: string) {
    Socket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as FrameCommand)
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

it('reconnects and catches up on frames created, edited, and deleted while offline', async () => {
  vi.useFakeTimers()
  const a = frame('a'),
    b = frame('b'),
    kept = frame('kept')
  await connect([a, kept])
  const oldIndex = socket('/canvases/c/')
  oldIndex.close()
  socket('/frames/a/').close()
  socket('/frames/kept/').close()
  const ready = sync.connectFrames('c')
  await vi.advanceTimersByTimeAsync(1000)
  await flush()
  const replacement = Socket.instances.filter((candidate) => candidate.url.includes('/canvases/c/')).at(-1)!
  expect(replacement).not.toBe(oldIndex)
  replacement.receive(indexSnapshot([b, kept], 2))
  await ready
  await flush()
  socket('/frames/b/').receive(snapshot(b))
  const edited = { ...kept, html: '<p>Edited while offline</p>', updatedAt: 2 }
  const reconnectedFrame = Socket.instances.filter((candidate) => candidate.url.includes('/frames/kept/')).at(-1)!
  expect(reconnectedFrame).not.toBe(socket('/frames/kept/'))
  reconnectedFrame.receive({ ...snapshot(edited), revision: 1 })
  oldIndex.receive(indexSnapshot([a], 99)) // late messages from the abandoned connection are ignored
  expect(useStore.getState().canvas?.frames).toEqual(expect.arrayContaining([b, edited]))
  expect(useStore.getState().canvas?.frames).toHaveLength(2)
  expect(socket('/frames/a/').readyState).toBe(3)
})

it('keeps the index page assignment when an older frame snapshot arrives', async () => {
  const entry = { ...frame('a'), pageId: 'old' }
  await connect([entry])
  socket('/canvases/c/').receive({
    ...indexSnapshot([entry], 1),
    pages: [{ id: 'current', name: 'Current' }],
    framePages: { a: 'current' },
  })
  expect(useStore.getState().canvas?.frames[0]?.pageId).toBe('current')
  socket('/frames/a/').receive({ ...snapshot({ ...entry, html: '<p>Edited</p>' }), revision: 1 })
  expect(useStore.getState().canvas?.frames[0]).toMatchObject({ pageId: 'current', html: '<p>Edited</p>' })
})
