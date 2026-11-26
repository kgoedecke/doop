import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { clientMessageSchema } from '../shared/roomSchemas.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Input checked at the boundary, against the REAL server (see ./harness.ts): the frame routes
 * answer a body of the wrong type 400 and write nothing (server/frameSchemas.ts), and the room
 * drops a message that does not match its schema instead of relaying it to every peer
 * (shared/roomSchemas.ts).
 */

let server: Server
let owner: Client
let canvasId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('boundary@test.dev', 'Boundary Owner')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Boundary' })).json()).id
}, 70_000)

afterAll(() => server?.stop())

type StoredFrame = { id: string; name: string; x: number; width: number; html: string; updatedAt: number }

async function framesOnCanvas(): Promise<StoredFrame[]> {
  return (await (await owner.get(`/api/canvases/${canvasId}`)).json()).frames
}

describe('POST /api/canvases/:id/frames', () => {
  it.each([
    [{ width: 'abc' }, 'width: must be a finite number'],
    [{ html: 123 }, 'html: Expected string, received number'],
    [{ x: 'left' }, 'x: must be a finite number'],
    [{ name: { first: 'a' } }, 'name: Expected string, received object'],
    [{ pageId: 7 }, 'pageId: Expected string, received number'],
    [{ z: '3' }, 'z: must be a finite number'],
    [{ rotation: 'left' }, 'rotation: must be a finite number'],
  ])('answers %j with a 400 naming the field, and makes no frame', async (body, error) => {
    const before = (await framesOnCanvas()).length
    const res = await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'bad', ...body })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
    expect(await framesOnCanvas()).toHaveLength(before)
  })

  it('makes a frame from the body the iOS app sends, as before', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/frames`, {
      name: 'Untitled frame',
      x: 80,
      y: 0,
      width: 390,
      height: 844,
      html: '<p>What will you make?</p>',
    })
    expect(res.status).toBe(200)
    const frame = await res.json()
    expect(frame).toMatchObject({ name: 'Untitled frame', x: 80, y: 0, width: 390, height: 844 })
    expect(frame.html).toContain('What will you make?')
  })

  it('takes null as the default, as before (a NaN is sent as null)', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/frames`, {
      name: null,
      width: null,
      height: null,
      html: null,
      z: null,
      rotation: null,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: 'Frame', width: 640, height: 480, html: '' })
  })

  it('takes an empty body and the browser’s extra fields, as before', async () => {
    const plain = await owner.post(`/api/canvases/${canvasId}/frames`, {})
    expect(plain.status).toBe(200)
    expect((await plain.json()).name).toBe('Frame')
    /* the editor's createFrame spreads a whole frame and adds `actor`: the rest is ignored */
    const copy = await owner.post(`/api/canvases/${canvasId}/frames`, {
      id: 'ignored',
      name: 'Copy',
      createdAt: 1,
      actor: { name: 'Tab', kind: 'user', color: '#000' },
      hidden: true,
      locked: true,
      z: 4,
      rotation: 30,
    })
    expect(copy.status).toBe(200)
    expect(await copy.json()).toMatchObject({ name: 'Copy', hidden: true, locked: true, z: 4, rotation: 30 })
  })
})

describe('a visitor without access', () => {
  it('is refused before the body is read, on both routes', async () => {
    const stranger = await new Client(server).signUp('boundary-stranger@test.dev', 'Stranger')
    const frame = (await framesOnCanvas())[0]!
    const created = await stranger.post(`/api/canvases/${canvasId}/frames`, { width: 'abc' })
    const edited = await stranger.patch(`/api/frames/${frame.id}`, { width: 'abc' })
    expect(created.status).not.toBe(400)
    expect(created.status).toBeGreaterThanOrEqual(403)
    expect(edited.status).not.toBe(400)
    expect(edited.status).toBeGreaterThanOrEqual(403)
  })
})

describe('PATCH /api/frames/:id', () => {
  let frame: StoredFrame
  beforeAll(async () => {
    frame = await (
      await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Target', x: 10, width: 200, html: '<p>a</p>' })
    ).json()
  })

  it.each([
    [{ width: 'abc' }, 'width: must be a finite number'],
    [{ html: 123 }, 'html: Expected string, received number'],
    [{ y: [1] }, 'y: must be a finite number'],
    [{ width: null }, 'width: must be a finite number'],
    [{ name: 5 }, 'name: Expected string, received number'],
    [{ z: 'top' }, 'z: must be a finite number'],
    [{ rotation: '90' }, 'rotation: must be a finite number'],
  ])('answers %j with a 400 naming the field, and changes nothing', async (body, error) => {
    const res = await owner.patch(`/api/frames/${frame.id}`, { name: 'Changed', ...body })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
    const stored = (await framesOnCanvas()).find((f) => f.id === frame.id)
    expect(stored).toMatchObject({ name: 'Target', x: 10, width: 200, updatedAt: frame.updatedAt })
  })

  it('applies a valid edit, with the fields the browser sends around it, as before', async () => {
    const res = await owner.patch(`/api/frames/${frame.id}`, {
      name: 'Moved',
      x: 40.5,
      width: 320,
      html: '<p>b</p>',
      rotation: null,
      expectedUpdatedAt: frame.updatedAt,
      actor: { name: 'Tab', kind: 'user', color: '#000' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: 'Moved', x: 40.5, width: 320 })
    expect((await framesOnCanvas()).find((f) => f.id === frame.id)).toMatchObject({ name: 'Moved', x: 40.5 })
  })
})

type RoomMessage = { type: string; [key: string]: unknown }

/** A joined room connection: everything the server sends it. */
class Room {
  readonly messages: RoomMessage[] = []
  readonly clientId = `t-${Math.random().toString(36).slice(2)}`
  private ws: WebSocket

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (raw) => this.messages.push(JSON.parse(String(raw)) as RoomMessage))
    ws.on('error', () => {})
  }

  static join(client: Client): Promise<Room> {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: client.header() } })
    const room = new Room(ws)
    ws.on('open', () => room.send({ type: 'join', canvasId, clientId: room.clientId, name: 't', kind: 'user' }))
    return room.waitFor((m) => m.type === 'init').then(() => room)
  }

  send(message: unknown) {
    this.ws.send(JSON.stringify(message))
  }

  async waitFor(match: (m: RoomMessage) => boolean, ms = 4000): Promise<RoomMessage> {
    const deadline = Date.now() + ms
    for (;;) {
      const found = this.messages.find(match)
      if (found) return found
      if (Date.now() > deadline) throw new Error('timed out waiting for a room message')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  close() {
    this.ws.close()
  }
}

describe('room messages', () => {
  it('relays a valid cursor and drops one whose x is not a number', async () => {
    const watcher = await Room.join(owner)
    const sender = await Room.join(owner)
    try {
      sender.send({ type: 'cursor', x: 'a', y: 2 })
      sender.send({ type: 'cursor', x: 5, y: 6 })
      /* sent last: by the time it arrives the malformed one would have too, had it been relayed */
      const relayed = await watcher.waitFor((m) => m.type === 'cursor')
      expect(relayed).toEqual({ type: 'cursor', clientId: sender.clientId, x: 5, y: 6 })
      expect(watcher.messages.filter((m) => m.type === 'cursor')).toHaveLength(1)
    } finally {
      watcher.close()
      sender.close()
    }
  })

  it('drops malformed drags, editing claims and viewports, and keeps the socket', async () => {
    const watcher = await Room.join(owner)
    const sender = await Room.join(owner)
    try {
      sender.send({ type: 'frame:drag', frameId: 'f1', x: 1, y: 1, width: 'wide', height: 10 })
      sender.send({ type: 'frame:drag', frameId: { id: 'f1' }, x: 1, y: 1, width: 10, height: 10 })
      sender.send({ type: 'editing', frameId: 42 })
      sender.send({ type: 'editing', frameId: 'x'.repeat(10_000) })
      sender.send({ type: 'viewport', viewport: { x: 0, y: 0, zoom: 0, width: 800, height: 600 } })
      sender.send({ type: 'cursor', x: 1 })
      sender.send('not an object')
      /* then one of each, valid: only these reach the watcher */
      sender.send({ type: 'frame:drag', frameId: 'f1', x: 1, y: 2, width: 30, height: 40, rotation: 15 })
      sender.send({ type: 'editing', frameId: null })
      sender.send({ type: 'viewport', viewport: { x: 0, y: 0, zoom: 1, width: 800, height: 600 } })
      sender.send({ type: 'cursor', x: 9, y: 9 })
      await watcher.waitFor((m) => m.type === 'cursor')
      const relayed = watcher.messages.filter((m) => ['frame:drag', 'editing', 'viewport', 'cursor'].includes(m.type))
      expect(relayed).toEqual([
        {
          type: 'frame:drag',
          clientId: sender.clientId,
          frameId: 'f1',
          x: 1,
          y: 2,
          width: 30,
          height: 40,
          rotation: 15,
        },
        { type: 'editing', clientId: sender.clientId, frameId: null },
        {
          type: 'viewport',
          clientId: sender.clientId,
          viewport: { x: 0, y: 0, zoom: 1, width: 800, height: 600 },
        },
        { type: 'cursor', clientId: sender.clientId, x: 9, y: 9 },
      ])
    } finally {
      watcher.close()
      sender.close()
    }
  })
})

describe('clientMessageSchema', () => {
  it('takes the joins the browser and the iOS app send', () => {
    const browser = {
      type: 'join',
      canvasId: 'c1',
      clientId: 'V1StGXR8_Z5j',
      name: 'Quiet Otter',
      kind: 'user',
      pagesOnDemand: true,
      composesFrames: true,
      actorReads: true,
      pageId: 'p1',
    }
    const ios = { type: 'join', canvasId: 'c1', clientId: `ios-${crypto.randomUUID()}`, name: 'iOS', kind: 'user' }
    expect(clientMessageSchema.safeParse(browser).success).toBe(true)
    expect(clientMessageSchema.safeParse(ios).success).toBe(true)
    /* a page or frame from the URL is looked up, whatever it is */
    expect(clientMessageSchema.safeParse({ ...browser, frameId: 'y'.repeat(500) }).success).toBe(true)
  })

  it('refuses a join whose presence key is not a short string', () => {
    const join = { type: 'join', canvasId: 'c1', name: 't', kind: 'user' }
    expect(clientMessageSchema.safeParse({ ...join, clientId: { id: 1 } }).success).toBe(false)
    expect(clientMessageSchema.safeParse({ ...join, clientId: '' }).success).toBe(false)
    expect(clientMessageSchema.safeParse({ ...join, clientId: 'k'.repeat(201) }).success).toBe(false)
  })

  it('takes the page messages the browser sends and an unknown type is refused', () => {
    expect(clientMessageSchema.safeParse({ type: 'page:load', pageId: 'p1' }).success).toBe(true)
    expect(clientMessageSchema.safeParse({ type: 'pages:shown', pageIds: ['p1', 'p2'] }).success).toBe(true)
    expect(clientMessageSchema.safeParse({ type: 'page:load', pageId: 3 }).success).toBe(false)
    expect(clientMessageSchema.safeParse({ type: 'explode' }).success).toBe(false)
  })
})
