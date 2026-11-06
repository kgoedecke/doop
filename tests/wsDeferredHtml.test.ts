// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ClientMessage, Frame, ServerMessage } from '../shared/types'
import { connect, disconnect, requestFrameHtml } from '../src/lib/ws'
import { useStore } from '../src/lib/store'

class FakeSocket {
  static OPEN = 1
  static sockets: FakeSocket[] = []
  readyState = 1
  sent: ClientMessage[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  constructor() {
    FakeSocket.sockets.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {}
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

const frame = (id: string, pageId: string, html: string | null): Frame => ({
  id,
  canvasId: 'c1',
  pageId,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: html ?? '',
  ...(html === null ? { htmlDeferred: true } : {}),
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'test',
})

const canvas = (frames: Frame[]): Canvas => ({
  id: 'c1',
  name: 'Canvas',
  createdAt: 1,
  updatedAt: 1,
  pages: [
    { id: 'one', name: 'One' },
    { id: 'two', name: 'Two' },
  ],
  frames,
})

const init = (pageId: string | undefined, frames: Frame[]): ServerMessage => ({
  type: 'init',
  ...(pageId ? { pageId } : {}),
  canvas: canvas(frames),
  presences: [],
  activity: [],
  tasks: [],
  feedback: [],
  comments: [],
  decisions: [],
  proposals: [],
  selfColor: '#000',
  serverBuild: 'dev',
})

/** what the page asked the room, the join aside */
const requests = (socket: FakeSocket) => socket.sent.filter((m) => m.type === 'frames:load')
const open = () => {
  const socket = FakeSocket.sockets.at(-1)!
  socket.onopen?.()
  return socket
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  FakeSocket.sockets = []
  useStore.getState().setCanvas(null)
})

afterEach(() => {
  disconnect()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  history.pushState(null, '', '/')
})

describe('joining with deferred HTML', () => {
  it('asks for deferral and says which page or frame a link points at', () => {
    history.pushState(null, '', '/c/c1?page=two&frame=b')
    connect('c1')
    expect(open().sent).toEqual([
      expect.objectContaining({ type: 'join', canvasId: 'c1', deferHtml: true, pageId: 'two', frameId: 'b' }),
    ])
  })

  it('names nothing when the link names nothing', () => {
    connect('c1')
    const [join] = open().sent
    expect(join).toMatchObject({ type: 'join', deferHtml: true })
    expect(join).not.toHaveProperty('pageId')
    expect(join).not.toHaveProperty('frameId')
  })

  it('opens the canvas on the page the room opened it on', () => {
    connect('c1')
    open().receive(init('two', [frame('a', 'one', null), frame('b', 'two', '<p>b</p>')]))
    expect(useStore.getState().activePageId).toBe('two')
  })
})

describe('loading the HTML of a page', () => {
  it('asks for the deferred frames of a page when it is opened, once, and fills them in', () => {
    connect('c1')
    const socket = open()
    socket.receive(init('two', [frame('a', 'one', null), frame('a2', 'one', null), frame('b', 'two', '<p>b</p>')]))
    expect(requests(socket)).toEqual([])

    useStore.getState().setActivePage('one')
    expect(requests(socket)).toEqual([{ type: 'frames:load', frameIds: ['a', 'a2'] }])
    useStore.getState().patchFrameLocal('a', { x: 5 })
    expect(requests(socket)).toHaveLength(1)

    socket.receive({ type: 'frames:html', frames: [{ id: 'a', html: '<p>a</p>' }] })
    const [a, a2] = useStore.getState().canvas!.frames
    expect(a).toMatchObject({ id: 'a', html: '<p>a</p>', x: 5 })
    expect(a).not.toHaveProperty('htmlDeferred')
    expect(a2).toMatchObject({ id: 'a2', html: '', htmlDeferred: true })
  })

  it('does not ask for a page that arrived with its HTML', () => {
    connect('c1')
    const socket = open()
    socket.receive(init('one', [frame('a', 'one', '<p>a</p>'), frame('b', 'two', null)]))
    useStore.getState().setActivePage('one')
    expect(requests(socket)).toEqual([])
  })

  it('does not ask for anything from a room that does not defer', () => {
    connect('c1')
    const socket = open()
    socket.receive(init(undefined, [frame('a', 'one', '<p>a</p>'), frame('b', 'two', '<p>b</p>')]))
    useStore.getState().setActivePage('two')
    expect(requests(socket)).toEqual([])
  })

  it('leaves a frame that already has its HTML alone when the reply is late', () => {
    connect('c1')
    const socket = open()
    socket.receive(init('two', [frame('a', 'one', null), frame('b', 'two', '<p>b</p>')]))
    useStore.getState().setActivePage('one')
    socket.receive({ type: 'frame:updated', frame: frame('a', 'one', '<p>newer</p>'), actor: {} })
    socket.receive({ type: 'frames:html', frames: [{ id: 'a', html: '<p>older</p>' }] })
    expect(useStore.getState().canvas!.frames[0]).toMatchObject({ id: 'a', html: '<p>newer</p>' })
  })

  it('asks for the frames something else needs, once each', () => {
    connect('c1')
    const socket = open()
    socket.receive(init('two', [frame('a', 'one', null), frame('b', 'two', '<p>b</p>')]))
    requestFrameHtml(['a'])
    requestFrameHtml(['a'])
    expect(requests(socket)).toEqual([{ type: 'frames:load', frameIds: ['a'] }])
  })

  it('asks again after a reconnect, which brings a fresh canvas, and rejoins on the open page', () => {
    vi.useFakeTimers()
    history.pushState(null, '', '/c/c1?page=two')
    connect('c1')
    const first = open()
    first.receive(init('two', [frame('a', 'one', null), frame('b', 'two', '<p>b</p>')]))
    useStore.getState().setActivePage('one')
    first.receive({ type: 'frames:html', frames: [{ id: 'a', html: '<p>a</p>' }] })
    requestFrameHtml(['b'])
    expect(requests(first)).toHaveLength(2)

    first.onclose?.({ code: 1006 })
    vi.advanceTimersByTime(1200)
    const second = open()
    expect(second.sent[0]).toMatchObject({ type: 'join', pageId: 'one' })
    second.receive(init('one', [frame('a', 'one', '<p>a</p>'), frame('b', 'two', null)]))
    requestFrameHtml(['b'])
    expect(requests(second)).toEqual([{ type: 'frames:load', frameIds: ['b'] }])
  })
})
