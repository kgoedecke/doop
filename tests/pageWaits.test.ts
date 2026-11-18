// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClientMessage, Frame, ServerMessage, WireCanvas } from '../shared/types'

/* What the editor asks the room for, and what it waits on, as pages come and
   go: a waiter follows a frame to the page it moves to, the pages shown
   outside the editor's page stay wanted (and in the room's memory) while they
   are up, and a server from before page loading sends every page whole. */

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

/** the room's socket, played by the test */
const room = vi.hoisted(() => ({
  sent: [] as unknown[],
  socket: null as null | { onmessage?: (e: { data: string }) => void },
}))
vi.stubGlobal(
  'WebSocket',
  class {
    static OPEN = 1
    readyState = 0
    onopen?: () => void
    constructor() {
      room.socket = this as never
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.()
      })
    }
    send(data: string) {
      room.sent.push(JSON.parse(data))
    }
    close() {
      this.readyState = 3
    }
  },
)

const { useStore } = await import('../src/lib/store')
const { connect, disconnect, loadFramePages, showFrames } = await import('../src/lib/ws')

const frame = (id: string, pageId: string, html = `<p>${id}</p>`): Frame => ({
  id,
  canvasId: 'c',
  pageId,
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Ada',
})
const pages = ['first', 'second', 'third'].map((id) => ({ id, name: id }))
const home = frame('home', 'first')
const card = frame('card', 'second')

function wire(frames: Frame[], loaded: readonly string[]): WireCanvas {
  return {
    id: 'c',
    name: 'Canvas',
    pages,
    frames: frames.map(({ html, ...meta }) => (loaded.includes(meta.pageId!) ? { ...meta, html } : meta)),
    createdAt: 1,
    updatedAt: 1,
  }
}

function deliver(message: ServerMessage) {
  room.socket?.onmessage?.({ data: JSON.stringify(message) })
}

function init(canvas: WireCanvas, loadedPageIds?: string[]) {
  deliver({
    type: 'init',
    canvas,
    ...(loadedPageIds ? { loadedPageIds } : {}),
    presences: [],
    activity: [],
    tasks: [],
    feedback: [],
    comments: [],
    decisions: [],
    proposals: [],
    selfColor: '#000',
    serverBuild: 'dev',
  } as ServerMessage)
}

const sent = <T extends ClientMessage['type']>(type: T) =>
  (room.sent as ClientMessage[]).filter(
    (message): message is Extract<ClientMessage, { type: T }> => message.type === type,
  )

async function join(frames: Frame[], loaded: string[]) {
  connect('c')
  await vi.waitFor(() => expect(sent('join').length).toBeGreaterThan(0))
  init(wire(frames, loaded), loaded)
}

beforeEach(() => {
  room.sent.length = 0
  useStore.getState().setCanvas(null)
})
afterEach(() => {
  disconnect()
  vi.useRealTimers()
})

it('takes a full init from a server from before page loading as every page loaded', async () => {
  /* this tab had the second page stale when the room went away */
  useStore.getState().setCanvas(wire([home, card], ['first']), ['first'])
  expect(useStore.getState().stalePages).toEqual({ second: true, third: true })
  connect('c')
  await vi.waitFor(() => expect(sent('join').length).toBe(1))
  /* the older server sends every frame whole and no loadedPageIds */
  init(wire([home, card], ['first', 'second', 'third']))
  expect(useStore.getState().stalePages).toEqual({})
  expect(useStore.getState().canvas!.frames.find((f) => f.id === 'card')!.html).toBe('<p>card</p>')
})

it('waits for the page a frame moves to while it is waited on, and gives up when it is deleted', async () => {
  await join([home, card], ['first'])
  let done = false
  const waiting = loadFramePages(['card']).then(() => (done = true))
  expect(sent('page:load').map((m) => m.pageId)).toEqual(['second'])

  /* another editor moves the frame to the third page, which this browser has not read either */
  const { html: _html, ...moved } = { ...card, pageId: 'third', updatedAt: 2 }
  deliver({ type: 'frame:updated', frame: moved, actor: { name: 'Bob', kind: 'user', color: '#00f' } })
  await vi.waitFor(() => expect(sent('page:load').map((m) => m.pageId)).toContain('third'))
  await Promise.resolve()
  expect(done).toBe(false)

  deliver({ type: 'page:frames', pageId: 'third', frames: [{ ...card, pageId: 'third', updatedAt: 2 }] })
  await waiting
  expect(useStore.getState().canvas!.frames.find((f) => f.id === 'card')!.html).toBe('<p>card</p>')

  /* a frame deleted while waited on ends the wait */
  useStore.getState().setPageStale('third')
  const gone = loadFramePages(['card'])
  deliver({
    type: 'frame:deleted',
    frameId: 'card',
    actor: { name: 'Bob', kind: 'user', color: '#00f' },
  } as ServerMessage)
  await expect(gone).rejects.toThrow(/deleted/)
})

it('keeps a page shown outside the editor wanted and in the room while it is up, through failed reads', async () => {
  vi.useFakeTimers()
  await join([home, card], ['first'])
  const hide = showFrames(['card'])
  expect(sent('pages:shown').at(-1)?.pageIds).toEqual(['first', 'second'])
  expect(sent('page:load').map((m) => m.pageId)).toEqual(['second'])

  /* the page's storage is away for longer than a one-off wait would last */
  await vi.advanceTimersByTimeAsync(60_000)
  deliver({ type: 'page:failed', pageId: 'second' })
  await vi.advanceTimersByTimeAsync(2_000)
  expect(sent('page:load').map((m) => m.pageId)).toEqual(['second', 'second'])

  hide()
  expect(sent('pages:shown').at(-1)?.pageIds).toEqual(['first'])
})

it('pins every shown page and never reads back a page dropped while nothing shows it', async () => {
  await join([home, card], ['first'])
  /* a prototype moves from the editor's page to a screen on the second page */
  const hide = showFrames(['card'])
  deliver({ type: 'page:frames', pageId: 'second', frames: [card] })
  expect(sent('pages:shown').at(-1)?.pageIds).toEqual(['first', 'second'])
  const loads = sent('page:load').length
  const announcements = sent('pages:shown').length

  /* the screen leaves; the room lets the second page go: it stays unread here */
  hide()
  expect(sent('pages:shown').at(-1)?.pageIds).toEqual(['first'])
  deliver({ type: 'page:dropped', pageId: 'second' })
  await Promise.resolve()
  expect(useStore.getState().stalePages.second).toBeTruthy()
  expect(sent('page:load')).toHaveLength(loads)
  expect(sent('pages:shown')).toHaveLength(announcements + 1)
})
