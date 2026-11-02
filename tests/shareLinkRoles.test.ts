import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'

/**
 * View-only and comment-only share links, against the real server: what a
 * link visitor may read, comment and change over REST, the WebSocket room
 * and MCP (authenticated with the visitor's own agent key). Spec:
 * .context/specs/share-link-roles.md
 */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

type RoomMessage = { type: string; [key: string]: unknown }

/** A room connection that stays open: everything the server sends, and how it closed. */
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

  send(message: RoomMessage) {
    this.ws.send(JSON.stringify(message))
  }

  /** the role the server put on the joining `init` */
  get joinedRole(): unknown {
    const init = this.messages.find((m) => m.type === 'init')
    return (init?.canvas as { role?: unknown } | undefined)?.role
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

describe('share link roles', () => {
  let owner: Client
  let visitor: Client
  let canvasId: string
  let pageId: string
  let frameId: string
  let visitorKey: string

  beforeAll(async () => {
    owner = new Client(server)
    visitor = new Client(server)
    await owner.signUp('roles-owner@test.dev', 'Owner')
    await visitor.signUp('roles-visitor@test.dev', 'Visitor')
    const canvas = await (await owner.post('/api/canvases', { name: 'Roles' })).json()
    canvasId = canvas.id
    pageId = canvas.pages?.[0]?.id ?? `${canvasId}:page1`
    frameId = (await (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Hero' })).json()).id
    visitorKey = (await (await visitor.post('/api/agent-keys', { name: 'visitor-agent' })).json()).secret
  })

  const setLink = (linkAccess: string) => owner.patch(`/api/canvases/${canvasId}`, { linkAccess })

  /** Every write a link visitor must not make below edit, with its route. */
  const editWrites = () =>
    [
      ['create a frame', visitor.post(`/api/canvases/${canvasId}/frames`, { name: 'x' })],
      ['edit a frame', visitor.patch(`/api/frames/${frameId}`, { name: 'hacked' })],
      ['stream into a frame', visitor.post(`/api/frames/${frameId}/append`, { html_chunk: '<p>x</p>', start: true })],
      ['delete a frame', visitor.delete(`/api/frames/${frameId}`)],
      ['rename the canvas', visitor.patch(`/api/canvases/${canvasId}`, { name: 'renamed' })],
      [
        'replace the pages',
        visitor.req(`/api/canvases/${canvasId}/pages`, {
          method: 'PUT',
          body: JSON.stringify({ pages: [{ id: 'p', name: 'P' }], expectedPages: [] }),
        }),
      ],
      [
        'write a design rule',
        visitor.req(`/api/canvases/${canvasId}/guidelines/brand`, {
          method: 'PUT',
          body: JSON.stringify({ markdown: 'Use red.' }),
        }),
      ],
      ['pin a reference', visitor.post(`/api/canvases/${canvasId}/references`, { frameId })],
      ['queue an agent card', visitor.post(`/api/canvases/${canvasId}/cards`, { title: 'Redesign it' })],
      ['import a page', visitor.post(`/api/canvases/${canvasId}/import`, { url: 'https://example.com' })],
      [
        'upload an asset',
        visitor.req(`/api/canvases/${canvasId}/assets`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: Buffer.from('not really a png'),
        }),
      ],
    ] as const

  async function expectEditWritesRefused() {
    for (const [what, pending] of editWrites()) {
      const res = await pending
      expect(res.status, what).toBe(403)
    }
  }

  it('validates the level and keeps it owner-only', async () => {
    expect((await setLink('bogus')).status).toBe(400)
    expect((await visitor.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(403)
  })

  describe('a view link', () => {
    beforeAll(async () => {
      expect((await setLink('view')).status).toBe(200)
    })

    it('opens the canvas and reports the role', async () => {
      const res = await visitor.get(`/api/canvases/${canvasId}`)
      expect(res.status).toBe(200)
      expect((await res.json()).role).toBe('view')
      expect((await (await owner.get(`/api/canvases/${canvasId}`)).json()).role).toBe('edit')
      expect((await visitor.get(`/api/frames/${frameId}/versions`)).status).toBe(200)
    })

    it('refuses every edit with 403', expectEditWritesRefused)

    it('refuses comments too', async () => {
      const res = await visitor.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 10, y: 10, text: 'hi' })
      expect(res.status).toBe(403)
      const onFrame = await visitor.post(`/api/frames/${frameId}/comments`, {
        selector: 'body',
        snippet: '',
        text: 'x',
      })
      expect(onFrame.status).toBe(403)
    })

    it('joins the room read-only: cursors go out, frame drags do not', async () => {
      const watcher = await Room.join(owner, canvasId)
      const viewer = await Room.join(visitor, canvasId)
      try {
        expect(viewer.joinedRole).toBe('view')
        viewer.send({ type: 'frame:drag', frameId, x: 999, y: 999, width: 10, height: 10 })
        viewer.send({ type: 'editing', frameId })
        viewer.send({ type: 'cursor', x: 5, y: 6 })
        /* the cursor is sent last; by the time it arrives the drag and the
           editing claim would have too, had the server relayed them */
        await watcher.waitFor((m) => m.type === 'cursor' && m.x === 5)
        expect(watcher.messages.some((m) => m.type === 'frame:drag')).toBe(false)
        expect(watcher.messages.some((m) => m.type === 'editing')).toBe(false)
        expect(viewer.closedWith).toBeNull()
      } finally {
        watcher.close()
        viewer.close()
      }
    })

    it('lets the visitor’s agent read but not write over MCP', async () => {
      const read = await mcpCall(visitorKey, 'get_canvas', { canvas_id: canvasId, agent_name: 'Visitor agent' })
      expect(read.isError, read.text).toBe(false)
      for (const [tool, args] of [
        ['create_frame', { canvas_id: canvasId, name: 'x', html: '<p>x</p>', agent_name: 'A' }],
        ['set_frame_html', { frame_id: frameId, html: '<p>x</p>', agent_name: 'A' }],
        ['update_frame', { frame_id: frameId, name: 'x', agent_name: 'A' }],
        ['delete_frame', { frame_id: frameId, agent_name: 'A' }],
        ['set_guidelines', { canvas_id: canvasId, name: 'brand', markdown: 'x', agent_name: 'A' }],
        ['set_status', { canvas_id: canvasId, status: 'working', agent_name: 'A' }],
      ] as const) {
        const result = await mcpCall(visitorKey, tool, args)
        expect(result.isError, tool).toBe(true)
        expect(result.text, tool).toContain('can only view')
      }
      const frame = await (await owner.get(`/api/canvases/${canvasId}`)).json()
      expect(frame.frames.find((f: { id: string }) => f.id === frameId)?.name).toBe('Hero')
    })
  })

  describe('a comment link', () => {
    beforeAll(async () => {
      expect((await setLink('comment')).status).toBe(200)
    })

    it('reports the role', async () => {
      expect((await (await visitor.get(`/api/canvases/${canvasId}`)).json()).role).toBe('comment')
    })

    it('refuses every edit with 403', expectEditWritesRefused)

    it('comments, replies and resolves', async () => {
      const posted = await visitor.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 10, y: 10, text: 'Nice' })
      expect(posted.status).toBe(200)
      const root = await posted.json()
      const onFrame = await visitor.post(`/api/frames/${frameId}/comments`, {
        selector: 'body',
        snippet: '<body>',
        text: 'Tighter spacing?',
      })
      expect(onFrame.status).toBe(200)
      expect((await visitor.post(`/api/comments/${root.id}/replies`, { text: 'Agreed' })).status).toBe(200)
      expect((await visitor.post(`/api/comments/${root.id}/resolve`)).status).toBe(200)
    })

    it('cannot hand an agent an edit through an @mention', async () => {
      const res = await visitor.post(`/api/canvases/${canvasId}/comments`, {
        pageId,
        x: 1,
        y: 1,
        text: '@Doop make it red',
      })
      expect(res.status).toBe(403)
    })

    it('lets the visitor’s agent reply over MCP but not edit', async () => {
      const root = await (
        await visitor.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 2, y: 2, text: 'Question' })
      ).json()
      const reply = await mcpCall(visitorKey, 'reply_to_comment', {
        canvas_id: canvasId,
        comment_id: root.id,
        text: 'Looking',
        agent_name: 'A',
      })
      expect(reply.isError, reply.text).toBe(false)
      const write = await mcpCall(visitorKey, 'create_frame', {
        canvas_id: canvasId,
        name: 'x',
        html: '<p>x</p>',
        agent_name: 'A',
      })
      expect(write.isError).toBe(true)
      expect(write.text).toContain('can only comment')
    })
  })

  describe('changing the link under an open room', () => {
    it('tells the visitor their new role, and disconnects them when the link closes', async () => {
      expect((await setLink('edit')).status).toBe(200)
      const room = await Room.join(visitor, canvasId)
      try {
        expect(room.joinedRole).toBe('edit')
        expect((await visitor.patch(`/api/frames/${frameId}`, { name: 'Edited by link' })).status).toBe(200)
        expect((await setLink('view')).status).toBe(200)
        expect(await room.waitFor((m) => m.type === 'role')).toMatchObject({ role: 'view' })
        expect((await setLink('none')).status).toBe(200)
        expect(await room.waitForClose()).toBe(4403)
      } finally {
        room.close()
      }
      expect((await visitor.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    })

    it('clears the editing badge of a visitor whose edit access is taken away', async () => {
      expect((await setLink('edit')).status).toBe(200)
      const watcher = await Room.join(owner, canvasId)
      const editor = await Room.join(visitor, canvasId)
      try {
        editor.send({ type: 'editing', frameId })
        const claim = await watcher.waitFor((m) => m.type === 'editing' && m.frameId === frameId)
        expect((await setLink('view')).status).toBe(200)
        await watcher.waitFor((m) => m.type === 'editing' && m.clientId === claim.clientId && m.frameId === null)
      } finally {
        watcher.close()
        editor.close()
      }
    })
  })
})
