import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'

/**
 * A signed-out visitor on a share link watches the canvas as a guest:
 * view only, silent in the room and without the team's conversation. A
 * private or missing canvas refuses the join alike (4401), and REST stays
 * behind sign-in.
 */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

type RoomMessage = { type: string; [key: string]: unknown }

/** A room connection without a session cookie, or with one when `client` is given. */
class Room {
  readonly messages: RoomMessage[] = []
  closedWith: number | null = null
  readonly clientId = `t-${Math.random()}`
  private constructor(private ws: WebSocket) {
    ws.on('message', (raw) => this.messages.push(JSON.parse(String(raw)) as RoomMessage))
    ws.on('close', (code) => (this.closedWith = code))
    ws.on('error', () => {}) // the close code carries the verdict
  }

  static open(canvasId: string, client?: Client): Room {
    const headers = client ? { Cookie: client.header() } : {}
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers })
    const room = new Room(ws)
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId, clientId: room.clientId, name: 'guest', kind: 'user' })),
    )
    return room
  }

  static async join(canvasId: string, client?: Client): Promise<Room> {
    const room = Room.open(canvasId, client)
    await room.waitFor((m) => m.type === 'init')
    return room
  }

  get init(): RoomMessage {
    const init = this.messages.find((m) => m.type === 'init')
    if (!init) throw new Error('no init yet')
    return init
  }

  send(message: RoomMessage) {
    this.ws.send(JSON.stringify(message))
  }

  async waitFor(match: (m: RoomMessage) => boolean, ms = 4000): Promise<RoomMessage> {
    const deadline = Date.now() + ms
    for (;;) {
      const found = this.messages.find(match)
      if (found) return found
      if (this.closedWith !== null) throw new Error(`room closed with ${this.closedWith}`)
      if (Date.now() > deadline) throw new Error('timed out waiting for a room message')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  async waitForClose(ms = 4000): Promise<number> {
    const deadline = Date.now() + ms
    while (this.closedWith === null) {
      if (Date.now() > deadline) throw new Error('room did not close')
      await new Promise((r) => setTimeout(r, 20))
    }
    return this.closedWith
  }

  close() {
    this.ws.close()
  }
}

describe('signed-out guests on a share link', () => {
  let owner: Client
  let canvasId: string
  let pageId: string
  let frameId: string

  beforeAll(async () => {
    owner = new Client(server)
    await owner.signUp('guest-owner@test.dev', 'Owner')
    const canvas = await (await owner.post('/api/canvases', { name: 'Guests' })).json()
    canvasId = canvas.id
    pageId = canvas.pages?.[0]?.id ?? `${canvasId}:page1`
    frameId = (await (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Hero' })).json()).id
    await owner.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 10, y: 10, text: 'Internal note' })
  })

  const setLink = (linkAccess: string) => owner.patch(`/api/canvases/${canvasId}`, { linkAccess })

  it('refuses a private canvas and a missing one alike', async () => {
    expect((await setLink('none')).status).toBe(200)
    expect(await Room.open(canvasId).waitForClose()).toBe(4401)
    expect(await Room.open('no-such-canvas').waitForClose()).toBe(4401)
  })

  it('shows a view link to a guest without the team conversation', async () => {
    expect((await setLink('view')).status).toBe(200)
    const guest = await Room.join(canvasId)
    const canvas = guest.init.canvas as { role: string; frames: { id: string }[]; memberIds?: unknown }
    expect(canvas.role).toBe('view')
    expect(canvas.frames.map((f) => f.id)).toContain(frameId)
    expect(canvas.memberIds).toBeUndefined()
    expect(guest.init.comments).toEqual([])
    expect(guest.init.tasks).toEqual([])
    expect(guest.init.activity).toEqual([])
    guest.close()
  })

  it('caps a guest at view on comment and edit links', async () => {
    for (const level of ['comment', 'edit']) {
      expect((await setLink(level)).status).toBe(200)
      const guest = await Room.join(canvasId)
      expect((guest.init.canvas as { role: string }).role).toBe('view')
      guest.close()
    }
  })

  it('sends a guest frame changes but not comments, and relays nothing it sends', async () => {
    expect((await setLink('edit')).status).toBe(200)
    const watcher = await Room.join(canvasId, owner)
    const guest = await Room.join(canvasId)

    expect((await owner.patch(`/api/frames/${frameId}`, { name: 'Hero v2' })).status).toBe(200)
    await guest.waitFor((m) => m.type === 'frame:updated')
    expect(
      (await owner.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 5, y: 5, text: 'Secret' })).status,
    ).toBe(200)
    await watcher.waitFor((m) => m.type === 'comment')
    guest.send({ type: 'cursor', x: 1, y: 2 })
    /* the frame update the watcher also gets is the barrier: by then the cursor would have arrived */
    expect((await owner.patch(`/api/frames/${frameId}`, { name: 'Hero v3' })).status).toBe(200)
    await watcher.waitFor((m) => m.type === 'frame:updated' && (m.frame as { name: string }).name === 'Hero v3')
    await guest.waitFor((m) => m.type === 'frame:updated' && (m.frame as { name: string }).name === 'Hero v3')

    expect(guest.messages.some((m) => m.type === 'comment')).toBe(false)
    expect(watcher.messages.some((m) => m.type === 'cursor' && m.clientId === guest.clientId)).toBe(false)
    expect(
      watcher.messages.some(
        (m) => m.type === 'presence:join' && (m.presence as { clientId: string }).clientId === guest.clientId,
      ),
    ).toBe(false)
    guest.close()
    watcher.close()
  })

  it("keeps an agent's status line, its task summary, from a guest", async () => {
    expect((await setLink('view')).status).toBe(200)
    const key = (await (await owner.post('/api/agent-keys', { name: 'guest-test-agent' })).json()).secret as string
    const setStatus = (status: string) =>
      fetch(`${server.base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'set_status', arguments: { canvas_id: canvasId, status, agent_name: 'Scout' } },
        }),
      })
    const watcher = await Room.join(canvasId, owner)
    const live = await Room.join(canvasId)
    expect((await setStatus('Redesigning the secret pricing page')).status).toBe(200)
    await watcher.waitFor(
      (m) => m.type === 'status' || (m.type === 'presence:join' && !!(m.presence as { status?: string }).status),
    )
    /* a frame update both rooms get is the barrier for anything sent before it */
    expect((await owner.patch(`/api/frames/${frameId}`, { name: 'Hero status barrier' })).status).toBe(200)
    await live.waitFor(
      (m) => m.type === 'frame:updated' && (m.frame as { name: string }).name === 'Hero status barrier',
    )
    const late = await Room.join(canvasId)

    for (const guest of [live, late]) {
      expect(JSON.stringify(guest.messages)).not.toContain('secret pricing')
      guest.close()
    }
    watcher.close()
  })

  it('closes a guest when the owner turns the link off', async () => {
    expect((await setLink('view')).status).toBe(200)
    const guest = await Room.join(canvasId)
    expect((await setLink('none')).status).toBe(200)
    expect(await guest.waitForClose()).toBe(4403)
  })

  it('keeps REST behind sign-in', async () => {
    expect((await setLink('view')).status).toBe(200)
    expect((await fetch(`${server.base}/api/canvases/${canvasId}`)).status).toBe(401)
  })
})
