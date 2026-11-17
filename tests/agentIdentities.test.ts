import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Agent identities: the icon an owner picks for a named agent, against the
 * real server — the REST surface that stores the choice, and the live room
 * and MCP path that read it. An owner's pick beats the brand read off the
 * agent's client, then the name the agent gave itself; no pick means that
 * detection runs as before.
 */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

type RoomMessage = { type: string; [key: string]: unknown }
type Presence = { name?: string; brand?: string }
type Task = { id?: string; agentName?: string; status?: string; brand?: string; endedAt?: number }

/** A room connection that stays open: everything the server sends, in order. */
class Room {
  readonly messages: RoomMessage[] = []
  closedWith: number | null = null

  private constructor(private ws: WebSocket) {
    ws.on('message', (raw) => this.messages.push(JSON.parse(String(raw)) as RoomMessage))
    ws.on('close', (code) => (this.closedWith = code))
    ws.on('error', () => {}) // the close code carries the verdict
  }

  static join(client: Client, canvasId: string): Promise<Room> {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: client.header() } })
    const room = new Room(ws)
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 't', kind: 'user' })),
    )
    return room.waitFor((m) => m.type === 'init').then(() => room)
  }

  /** everything from index `from` on: pass messages.length to await only what
   *  the request that follows causes, never an earlier announcement */
  async waitFor(match: (m: RoomMessage) => boolean, ms = 4000, from = 0): Promise<RoomMessage> {
    const deadline = Date.now() + ms
    for (;;) {
      const found = this.messages.slice(from).find(match)
      if (found) return found
      if (this.closedWith !== null) throw new Error(`room closed with ${this.closedWith}`)
      if (Date.now() > deadline) throw new Error('timed out waiting for a room message')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  close() {
    this.ws.close()
  }
}

/** The presence a message carries, when it is a presence:join. */
function presenceOf(message: RoomMessage): Presence | undefined {
  if (message.type !== 'presence:join') return undefined
  /* WebSocket JSON from our own server, in the shape shared/types.ts defines */
  const presence = message.presence as Presence | undefined
  return presence && typeof presence === 'object' ? presence : undefined
}

/** The task a message carries, when it is a task broadcast. */
function taskOf(message: RoomMessage): Task | undefined {
  if (message.type !== 'task') return undefined
  /* WebSocket JSON from our own server, in the shape shared/types.ts defines */
  const task = message.task as Task | undefined
  return task && typeof task === 'object' ? task : undefined
}

function joinedPresence(message: RoomMessage): Presence {
  const presence = presenceOf(message)
  if (!presence) throw new Error(`expected a presence:join, got ${message.type}`)
  return presence
}

/** A presence:join for one agent carrying exactly `brand` (undefined = automatic). */
function joined(agentName: string, brand?: string) {
  return (m: RoomMessage) => {
    const presence = presenceOf(m)
    return presence?.name === agentName && presence.brand === brand
  }
}

/** initialize, which is the only message carrying the client's name; the
 *  server remembers it per credential for the tool calls that follow. */
function mcpInitialize(secret: string, clientName: string) {
  return fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: clientName, version: '1.0.0' },
      },
    }),
  })
}

/** One stateless MCP tools/call, authenticated with an agent key. */
async function mcpCall(secret: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    result: { isError?: boolean; content: { type: string; text?: string }[] }
  }
  return {
    isError: !!body.result.isError,
    text: body.result.content.map((block) => block.text ?? '').join('\n'),
  }
}

describe('agent identity routes', () => {
  let owner: Client
  let stranger: Client

  beforeAll(async () => {
    owner = await new Client(server).signUp('identity-rest-owner@test.dev', 'Rest Owner')
    stranger = await new Client(server).signUp('identity-rest-stranger@test.dev', 'Rest Stranger')
  })

  const list = async (client: Client) => (await (await client.get('/api/agent-identities')).json()) as unknown[]

  it('starts with every agent automatic', async () => {
    const res = await owner.get('/api/agent-identities')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('stores a brand and lists it back', async () => {
    const put = await owner.put('/api/agent-identities/Bau', { brand: 'kimi' })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ agentName: 'Bau', brand: 'kimi' })
    expect(await list(owner)).toEqual([{ agentName: 'Bau', brand: 'kimi' }])

    /* one row per agent: a second pick replaces the first */
    expect((await owner.put('/api/agent-identities/Bau', { brand: 'deepseek' })).status).toBe(200)
    expect(await list(owner)).toEqual([{ agentName: 'Bau', brand: 'deepseek' }])
  })

  it('clears the pick with null, back to automatic', async () => {
    const cleared = await owner.put('/api/agent-identities/Bau', { brand: null })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ agentName: 'Bau', brand: null })
    expect(await list(owner)).toEqual([])
  })

  it('refuses a brand it does not know', async () => {
    expect((await owner.put('/api/agent-identities/Bau', { brand: 'nope' })).status).toBe(400)
    expect(await list(owner)).toEqual([])
  })

  it('refuses blank and over-long names, and takes the 60-character boundary', async () => {
    expect((await owner.put(`/api/agent-identities/${encodeURIComponent('   ')}`, { brand: 'kimi' })).status).toBe(400)
    expect((await owner.put(`/api/agent-identities/${'a'.repeat(61)}`, { brand: 'kimi' })).status).toBe(400)
    expect((await owner.put(`/api/agent-identities/${'a'.repeat(60)}`, { brand: 'kimi' })).status).toBe(200)
    await owner.put(`/api/agent-identities/${'a'.repeat(60)}`, { brand: null })
  })

  it("keeps one owner's picks out of another's", async () => {
    /* the same agent name, chosen independently by two accounts */
    expect((await owner.put('/api/agent-identities/Bau', { brand: 'kimi' })).status).toBe(200)
    expect((await stranger.put('/api/agent-identities/Bau', { brand: 'gemini' })).status).toBe(200)
    expect(await list(owner)).toEqual([{ agentName: 'Bau', brand: 'kimi' }])
    expect(await list(stranger)).toEqual([{ agentName: 'Bau', brand: 'gemini' }])

    await owner.put('/api/agent-identities/Bau', { brand: null })
    expect(await list(owner)).toEqual([])
    expect(await list(stranger)).toEqual([{ agentName: 'Bau', brand: 'gemini' }])
  })
})

describe('live agent presence and the owner’s pick', () => {
  const VIEWER_EMAIL = 'identity-live-viewer@test.dev'
  let owner: Client
  let viewer: Client
  let cursorKey: string
  let plainKey: string
  let mainCanvas: string
  let optOutCanvas: string
  let namedCanvas: string
  let taskCanvas: string
  let main: Room
  let optOut: Room
  let named: Room

  beforeAll(async () => {
    owner = await new Client(server).signUp('identity-live-owner@test.dev', 'Live Owner')
    viewer = await new Client(server).signUp(VIEWER_EMAIL, 'Live Viewer')
    const canvas = async (name: string) => (await (await owner.post('/api/canvases', { name })).json()).id as string
    mainCanvas = await canvas('Icons')
    optOutCanvas = await canvas('Icons opt-out')
    namedCanvas = await canvas('Icons by name')
    taskCanvas = await canvas('Icons on tasks')
    for (const id of [mainCanvas, optOutCanvas, namedCanvas, taskCanvas]) {
      expect((await owner.post(`/api/canvases/${id}/members`, { email: VIEWER_EMAIL })).status).toBe(200)
    }
    /* a Cursor connection and one whose client name places no product */
    cursorKey = (await (await owner.post('/api/agent-keys', { name: 'cursor-agent' })).json()).secret
    plainKey = (await (await owner.post('/api/agent-keys', { name: 'plain-agent' })).json()).secret
    expect((await mcpInitialize(cursorKey, 'Cursor')).status).toBe(200)
    expect((await mcpInitialize(plainKey, 'rmcp')).status).toBe(200)

    main = await Room.join(viewer, mainCanvas)
    optOut = await Room.join(viewer, optOutCanvas)
    named = await Room.join(viewer, namedCanvas)
  }, 30_000)

  afterAll(() => {
    main?.close()
    optOut?.close()
    named?.close()
  })

  async function setStatus(secret: string, canvasId: string, agentName: string, status: string) {
    const result = await mcpCall(secret, 'set_status', { canvas_id: canvasId, status, agent_name: agentName })
    expect(result.isError, result.text).toBe(false)
  }

  it('reads the client’s brand, then re-announces the owner’s pick live', async () => {
    await setStatus(cursorKey, mainCanvas, 'Bau', 'Designing the home page')
    expect(joinedPresence(await main.waitFor(joined('Bau', 'cursor')))).toMatchObject({
      name: 'Bau',
      kind: 'agent',
      brand: 'cursor',
    })

    const mark = main.messages.length
    expect((await owner.put('/api/agent-identities/Bau', { brand: 'kimi' })).status).toBe(200)
    expect(joinedPresence(await main.waitFor(joined('Bau', 'kimi'), 4000, mark))).toMatchObject({
      name: 'Bau',
      brand: 'kimi',
    })
  })

  it('restores the mark the client implied when the owner returns the agent to automatic', async () => {
    const mark = main.messages.length
    expect((await owner.put('/api/agent-identities/Bau', { brand: null })).status).toBe(200)
    /* automatic puts a Cursor agent back on the Cursor mark at once, rather
       than dropping the icon until its next tool call re-reads the client */
    expect(joinedPresence(await main.waitFor(joined('Bau', 'cursor'), 4000, mark))).toMatchObject({
      name: 'Bau',
      brand: 'cursor',
    })

    /* the next tool call finds the mark already there and leaves it alone */
    const redetect = main.messages.length
    await setStatus(cursorKey, mainCanvas, 'Bau', 'Reviewing the hero')
    await main.waitFor((m) => m.type === 'status', 4000, redetect)
    expect(main.messages.slice(redetect).filter(presenceOf)).toEqual([])
  })

  it('lets the owner opt out of the brand the client would give it', async () => {
    expect((await owner.put('/api/agent-identities/Bau', { brand: 'doop' })).status).toBe(200)
    /* a canvas with no presence to update: the tool call itself must read the pick */
    const mark = optOut.messages.length
    await setStatus(cursorKey, optOutCanvas, 'Bau', 'Drafting the pricing table')
    expect(joinedPresence(await optOut.waitFor(joined('Bau', 'doop'), 4000, mark))).toMatchObject({
      name: 'Bau',
      kind: 'agent',
      brand: 'doop',
    })
  })

  it('puts the owner’s pick ahead of the name the agent gives itself', async () => {
    /* with no pick, an unplaced client leaves the agent's own name to decide */
    const baseline = named.messages.length
    await setStatus(plainKey, namedCanvas, 'Claude', 'Reading the brief')
    expect(joinedPresence(await named.waitFor(joined('Claude', 'claude'), 4000, baseline))).toMatchObject({
      name: 'Claude',
      brand: 'claude',
    })

    const mark = named.messages.length
    expect((await owner.put('/api/agent-identities/Claude', { brand: 'gemini' })).status).toBe(200)
    expect(joinedPresence(await named.waitFor(joined('Claude', 'gemini'), 4000, mark))).toMatchObject({
      brand: 'gemini',
    })

    /* on a canvas where Claude has not appeared yet, the next tool call must
       read the stored pick rather than fall back to the name */
    const fresh = (await (await owner.post('/api/canvases', { name: 'Icons fresh' })).json()).id
    expect((await owner.post(`/api/canvases/${fresh}/members`, { email: VIEWER_EMAIL })).status).toBe(200)
    const freshRoom = await Room.join(viewer, fresh)
    try {
      const freshMark = freshRoom.messages.length
      await setStatus(plainKey, fresh, 'Claude', 'Sketching the pricing table')
      expect(joinedPresence(await freshRoom.waitFor(joined('Claude', 'gemini'), 4000, freshMark))).toMatchObject({
        name: 'Claude',
        brand: 'gemini',
      })
    } finally {
      freshRoom.close()
    }
  })

  it('stamps a new task with the owner’s pick, not the mark the client implies', async () => {
    expect((await owner.put('/api/agent-identities/Bau', { brand: 'kimi' })).status).toBe(200)
    const mark = main.messages.length
    await setStatus(cursorKey, mainCanvas, 'Bau', 'Redrawing the hero')
    const started = taskOf(await main.waitFor((m) => taskOf(m)?.status === 'Redrawing the hero', 4000, mark))
    expect(started).toMatchObject({ agentName: 'Bau', status: 'Redrawing the hero', brand: 'kimi' })
  })

  it('re-brands the task it already started when the owner picks a new mark', async () => {
    expect((await owner.put('/api/agent-identities/Bau', { brand: 'kimi' })).status).toBe(200)
    const room = await Room.join(viewer, taskCanvas)
    try {
      const start = room.messages.length
      await setStatus(cursorKey, taskCanvas, 'Bau', 'Sketching the signup form')
      const started = taskOf(await room.waitFor((m) => taskOf(m)?.status === 'Sketching the signup form', 4000, start))
      expect(started).toMatchObject({ agentName: 'Bau', brand: 'kimi' })

      /* the same task comes back wearing the new mark, in place */
      const mark = room.messages.length
      expect((await owner.put('/api/agent-identities/Bau', { brand: 'gemini' })).status).toBe(200)
      const retagged = taskOf(await room.waitFor((m) => taskOf(m)?.id === started?.id, 4000, mark))
      expect(retagged).toMatchObject({ id: started?.id, status: 'Sketching the signup form', brand: 'gemini' })
    } finally {
      room.close()
    }
  })

  it('puts the detected mark back on the task when the owner returns it to automatic', async () => {
    expect((await owner.put('/api/agent-identities/Bau', { brand: 'kimi' })).status).toBe(200)
    const room = await Room.join(viewer, taskCanvas)
    try {
      const start = room.messages.length
      await setStatus(cursorKey, taskCanvas, 'Bau', 'Reviewing the checkout copy')
      const started = taskOf(
        await room.waitFor((m) => taskOf(m)?.status === 'Reviewing the checkout copy', 4000, start),
      )
      expect(started).toMatchObject({ brand: 'kimi' })

      const mark = room.messages.length
      expect((await owner.put('/api/agent-identities/Bau', { brand: null })).status).toBe(200)
      /* automatic falls back to the Cursor mark the client implied — on the
         card as well, rather than dropping the icon until the next tool call */
      const restored = taskOf(await room.waitFor((m) => taskOf(m)?.id === started?.id, 4000, mark))
      expect(restored).toMatchObject({ id: started?.id, status: 'Reviewing the checkout copy', brand: 'cursor' })
    } finally {
      room.close()
    }
  })

  it('hands a late viewer the mark a finished task kept', async () => {
    expect((await owner.put('/api/agent-identities/Bau', { brand: 'kimi' })).status).toBe(200)
    const live = await Room.join(viewer, taskCanvas)
    let finished: Task | undefined
    try {
      const start = live.messages.length
      await setStatus(cursorKey, taskCanvas, 'Bau', 'Finishing the footer')
      finished = taskOf(await live.waitFor((m) => taskOf(m)?.status === 'Finishing the footer', 4000, start))
      expect(finished).toMatchObject({ agentName: 'Bau', brand: 'kimi' })
      /* the next status ends it, and the agent goes quiet: no later tool call
         will re-announce the mark this task wore */
      await setStatus(cursorKey, taskCanvas, 'Bau', 'Wrapping up')
      await live.waitFor((m) => taskOf(m)?.status === 'Wrapping up', 4000, start)
    } finally {
      live.close()
    }

    /* someone who opens the canvas now gets the ended task from init, with the
       brand it stored, long after the presence that carried it is gone */
    const late = await Room.join(viewer, taskCanvas)
    try {
      const init = late.messages.find((m) => m.type === 'init')
      const tasks = (init?.tasks ?? []) as Task[]
      const kept = tasks.find((task) => task.id === finished?.id)
      expect(kept).toMatchObject({ status: 'Finishing the footer', brand: 'kimi' })
      expect(kept?.endedAt).toEqual(expect.any(Number))
    } finally {
      late.close()
    }
  })
})
