import WebSocket from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Canvas, CanvasPageInfo, Frame, ServerMessage, WireFrame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/* A canvas opens one page at a time: the room's init carries every frame's
   metadata but only the opening page's HTML, `page:load` reads another page,
   and the room sends a frame's HTML only to browsers that loaded its page.
   The server reads and drops frame HTML per page. Started after a restart so
   nothing is in memory, with a short CANVAS_IDLE_MS so the sweep runs often. */

let server: Server
let owner: Client
let canvas: Canvas
let home: CanvasPageInfo
let other: CanvasPageInfo
let onHome: Frame
let onOther: Frame

beforeAll(async () => {
  const env = { CANVAS_IDLE_MS: '1500' }
  const first = await startServer(env)
  owner = await new Client(first).signUp('pages-lazy@test.dev', 'Page Owner')
  canvas = await (await owner.post('/api/canvases', { name: 'Paged' })).json()
  home = canvas.pages![0]!
  other = { id: 'other', name: 'Other' }
  const saved = await owner.put(`/api/canvases/${canvas.id}/pages`, {
    pages: [home, other],
    expectedPages: canvas.pages,
  })
  expect(saved.status).toBe(200)
  onHome = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Home card', html: '<p>home</p>' })
  ).json()
  onOther = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, {
      name: 'Other card',
      pageId: other.id,
      html: '<p>other</p>',
    })
  ).json()
  first.stop({ keepData: true })
  await first.stopped
  server = await startServer(env, first.dataDir)
  owner = new Client(server)
  const signIn = await owner.post('/api/auth/sign-in/email', {
    email: 'pages-lazy@test.dev',
    password: 'password12345',
  })
  expect(signIn.status).toBe(200)
}, 120_000)

afterAll(() => server?.stop())

/** One browser in the canvas's room: what the server sent it, in order. */
class Room {
  messages: ServerMessage[] = []
  private socket: WebSocket
  private waiters: (() => void)[] = []

  constructor(join: { pageId?: string; frameId?: string }, onDemand = true) {
    this.socket = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
    this.socket.on('open', () =>
      this.send({
        type: 'join',
        canvasId: canvas.id,
        clientId: `c-${Math.random()}`,
        name: 'Owner',
        kind: 'user',
        ...(onDemand ? { pagesOnDemand: true } : {}),
        ...join,
      }),
    )
    this.socket.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as ServerMessage)
      for (const wake of this.waiters.splice(0)) wake()
    })
  }

  send(message: unknown) {
    this.socket.send(JSON.stringify(message))
  }

  /** the first message (from the start) of this type that `matches` */
  async next<T extends ServerMessage['type']>(
    type: T,
    matches: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + 8000
    for (;;) {
      const found = this.messages.find(
        (message): message is Extract<ServerMessage, { type: T }> =>
          message.type === type && matches(message as Extract<ServerMessage, { type: T }>),
      )
      if (found) return found
      if (Date.now() > deadline) throw new Error(`no ${type} message`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 200)
      })
    }
  }

  close() {
    this.socket.close()
  }
}

const framesOf = (frames: readonly WireFrame[]) => Object.fromEntries(frames.map((frame) => [frame.name, frame.html]))

/** pages with frame HTML in memory, as /healthz/store reports it */
async function pagesInMemory(): Promise<number> {
  return ((await (await fetch(`${server.base}/healthz/store`)).json()) as { pages: number }).pages
}

it('sends the HTML of the opening page only, then reads another page on page:load', async () => {
  const room = new Room({ pageId: other.id })
  try {
    const init = await room.next('init')
    expect(init.loadedPageIds).toEqual([other.id])
    expect(framesOf(init.canvas.frames)).toEqual({ 'Home card': undefined, 'Other card': '<p>other</p>' })
    /* every frame's metadata comes along, the unloaded page's too */
    expect(init.canvas.frames.find((frame) => frame.id === onHome.id)).toMatchObject({ pageId: home.id, x: onHome.x })
    expect(init.canvas.frames.find((frame) => frame.id === onOther.id)?.pageId).toBe(other.id)
    expect(await pagesInMemory()).toBe(1)

    room.send({ type: 'page:load', pageId: home.id })
    const page = await room.next('page:frames')
    expect(page.pageId).toBe(home.id)
    expect(framesOf(page.frames)).toEqual({ 'Home card': '<p>home</p>' })
    expect(await pagesInMemory()).toBe(2)
  } finally {
    room.close()
  }
})

it('opens on the page of the frame a link names', async () => {
  const room = new Room({ frameId: onHome.id, pageId: other.id })
  try {
    const init = await room.next('init')
    expect(init.loadedPageIds).toEqual([home.id])
    expect(framesOf(init.canvas.frames)).toEqual({ 'Home card': '<p>home</p>', 'Other card': undefined })
  } finally {
    room.close()
  }
})

it('sends a frame without its HTML to a browser that has not loaded its page', async () => {
  const onlyOther = new Room({ pageId: other.id })
  const both = new Room({ pageId: other.id })
  try {
    await onlyOther.next('init')
    await both.next('init')
    both.send({ type: 'page:load', pageId: home.id })
    await both.next('page:frames')

    const edited = await owner.patch(`/api/frames/${onHome.id}`, { html: '<p>home, edited</p>' })
    expect(edited.status).toBe(200)
    const toBoth = await both.next('frame:updated', (message) => message.frame.id === onHome.id)
    expect(toBoth.frame.html).toBe('<p>home, edited</p>')
    const toOther = await onlyOther.next('frame:updated', (message) => message.frame.id === onHome.id)
    expect(toOther.frame.html).toBeUndefined()
    expect(toOther.frame.name).toBe('Home card')

    /* loading the page later reads the frame as it is now */
    onlyOther.send({ type: 'page:load', pageId: home.id })
    const page = await onlyOther.next('page:frames')
    expect(framesOf(page.frames)).toEqual({ 'Home card': '<p>home, edited</p>' })
  } finally {
    onlyOther.close()
    both.close()
  }
})

it('sends the frames of a page made after the join with their HTML', async () => {
  const room = new Room({ pageId: other.id })
  try {
    const init = await room.next('init')
    const fresh = { id: 'fresh', name: 'Fresh' }
    const saved = await owner.put(`/api/canvases/${canvas.id}/pages`, {
      pages: [...init.canvas.pages!, fresh],
      expectedPages: init.canvas.pages,
    })
    expect(saved.status).toBe(200)
    const made: Frame = await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, {
        name: 'Fresh card',
        pageId: fresh.id,
        html: '<p>new</p>',
      })
    ).json()
    const created = await room.next('frame:created', (message) => message.frame.id === made.id)
    expect(created.frame.html).toBe('<p>new</p>')
  } finally {
    room.close()
  }
})

it('sends the whole canvas to a join from before page loading (the native apps, an older tab)', async () => {
  const legacy = new Room({}, false)
  const paged = new Room({ pageId: home.id })
  try {
    const init = await legacy.next('init')
    expect(init.loadedPageIds).toEqual(init.canvas.pages!.map((page) => page.id))
    expect(framesOf(init.canvas.frames)).toMatchObject({
      'Home card': '<p>home, edited</p>',
      'Other card': '<p>other</p>',
    })
    expect(init.canvas.frames.every((frame) => typeof frame.html === 'string')).toBe(true)
    await paged.next('init')

    const edited = await owner.patch(`/api/frames/${onOther.id}`, { html: '<p>other, edited</p>' })
    expect(edited.status).toBe(200)
    const toLegacy = await legacy.next('frame:updated', (message) => message.frame.id === onOther.id)
    expect(toLegacy.frame.html).toBe('<p>other, edited</p>')
    const toPaged = await paged.next('frame:updated', (message) => message.frame.id === onOther.id)
    expect(toPaged.frame.html).toBeUndefined()
  } finally {
    legacy.close()
    paged.close()
  }
})

it('drops idle pages but keeps the page a browser is looking at', async () => {
  const room = new Room({ pageId: other.id })
  try {
    await room.next('init')
    room.send({ type: 'page:load', pageId: home.id })
    await room.next('page:frames')
    /* reading a page is not showing it: the home page goes idle, the one shown stays */
    await expect.poll(pagesInMemory, { timeout: 10_000, interval: 250 }).toBe(1)
    await room.next('page:dropped', (message) => message.pageId === home.id)
    expect(room.messages.some((message) => message.type === 'page:dropped' && message.pageId === other.id)).toBe(false)
  } finally {
    room.close()
  }
  await expect.poll(pagesInMemory, { timeout: 10_000, interval: 250 }).toBe(0)
}, 30_000)

it('keeps every page a browser shows, and lets go of one it stops showing', async () => {
  const room = new Room({ pageId: other.id })
  try {
    await room.next('init')
    room.send({ type: 'page:load', pageId: home.id })
    await room.next('page:frames')
    /* a prototype screen on the home page beside the editor's page: both stay */
    room.send({ type: 'pages:shown', pageIds: [other.id, home.id] })
    await new Promise((resolve) => setTimeout(resolve, 4000))
    expect(await pagesInMemory()).toBe(2)
    expect(room.messages.some((message) => message.type === 'page:dropped')).toBe(false)

    room.send({ type: 'pages:shown', pageIds: [other.id] })
    await room.next('page:dropped', (message) => message.pageId === home.id)
    expect(await pagesInMemory()).toBe(1)
  } finally {
    room.close()
  }
  await expect.poll(pagesInMemory, { timeout: 10_000, interval: 250 }).toBe(0)
}, 30_000)
