import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { CanvasCommand, CanvasEvent } from '../src/actor'

vi.mock('../src/lib/identity', () => ({ getIdentity: () => ({ clientId: 'me', name: 'Me' }) }))
class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  sent: CanvasCommand[] = []
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(readonly url: string) {
    Socket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as CanvasCommand)
  }
  receive(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
  /** A committed change arrives the way the runtime emits it. */
  commit(change: CanvasEvent) {
    this.receive({ type: 'state_update', changes: { committed: change } })
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
const frame = (id: string, pageId = 'p1'): Frame => ({
  id,
  canvasId: 'c',
  pageId,
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
const someone = { name: 'Someone', kind: 'user' as const, color: '#000' }
const pages = [
  { id: 'p1', name: 'Page 1' },
  { id: 'p2', name: 'Page 2' },
]
const flush = async () => {
  for (let n = 0; n < 15; n++) await Promise.resolve()
}
const socket = () => Socket.instances.at(-1)!
const frames = () => useStore.getState().canvas?.frames ?? []
const snapshot = (entries: Frame[], revision = 0) => ({
  type: 'canvas-snapshot',
  revision,
  initialized: true,
  deleted: false,
  pages,
  frames: entries,
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
  socket().receive(snapshot(entries))
  await ready
  await flush()
}

it('opens one socket for the whole canvas', async () => {
  await connect([frame('a'), frame('b'), frame('d', 'p2')])
  expect(Socket.instances.map((entry) => new URL(entry.url).pathname)).toEqual(['/api/canvases/c/actor'])
  expect(frames().map((entry) => entry.id)).toEqual(['a', 'b', 'd'])
  expect(useStore.getState().frameIndex).toEqual(['a', 'b', 'd'])
})

it('reconnects and catches up on frames created, edited, and deleted while offline', async () => {
  vi.useFakeTimers()
  const a = frame('a'),
    b = frame('b'),
    kept = frame('kept')
  await connect([a, kept])
  const old = socket()
  old.close()
  const ready = sync.connectFrames('c')
  await vi.advanceTimersByTimeAsync(1000)
  await flush()
  expect(socket()).not.toBe(old)
  const edited = { ...kept, html: '<p>Edited while offline</p>', updatedAt: 2 }
  socket().receive(snapshot([b, edited], 3))
  await ready
  // late messages from the abandoned connection are ignored
  old.receive(snapshot([a], 99))
  expect(frames()).toEqual(expect.arrayContaining([b, edited]))
  expect(frames()).toHaveLength(2)
})

it('adds, moves, and removes frames from committed changes', async () => {
  const entry = frame('a')
  await connect([entry])
  socket().commit({ type: 'frame-change', revision: 1, frame: frame('b'), operation: 'insert', actor: someone })
  expect(useStore.getState().frameIndex).toEqual(['a', 'b'])
  socket().commit({
    type: 'frame-change',
    revision: 2,
    frame: { ...entry, pageId: 'p2', updatedAt: 2 },
    operation: 'update',
    actor: someone,
  })
  expect(frames().find((candidate) => candidate.id === 'a')?.pageId).toBe('p2')
  socket().commit({ type: 'frame-removal', revision: 3, frameId: 'a', actor: someone })
  expect(frames().map((candidate) => candidate.id)).toEqual(['b'])
  socket().commit({ type: 'pages-change', revision: 4, pages: [pages[1]!] })
  expect(useStore.getState().canvas?.pages).toEqual([pages[1]])
})

it('asks for a snapshot when it misses a change', async () => {
  await connect([frame('a')])
  socket().commit({ type: 'frame-removal', revision: 5, frameId: 'a', actor: someone })
  expect(frames()).toHaveLength(1)
  expect(socket().sent).toEqual([{ type: 'snapshot' }])
})

it('sends edits over the canvas socket and resolves on the acknowledgement', async () => {
  const entry = frame('a', 'p2')
  await connect([entry])
  const saved = sync.writeFrame({ type: 'update', id: 'a', patch: { name: 'Renamed' } })
  await flush()
  const [command] = socket().sent
  expect(command).toMatchObject({ type: 'write', frameId: 'a', write: { type: 'update', patch: { name: 'Renamed' } } })
  socket().commit({
    type: 'frame-change',
    revision: 1,
    frame: { ...entry, name: 'Renamed' },
    operation: 'update',
    actor: { ...someone, clientId: 'me' },
    requestId: command?.type === 'write' ? command.requestId : '',
  })
  await expect(saved).resolves.toMatchObject({ name: 'Renamed', pageId: 'p2' })
})
