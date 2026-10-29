import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'
import type { ElementComment } from '../shared/types.ts'

/**
 * POST /api/canvases/:id/comments against the REAL server (see ./harness.ts):
 * a comment pinned to a point on the canvas is validated, metered when it
 * @mentions a resident role, and reaches the room over the WebSocket.
 */

let server: Server
let owner: Client
let stranger: Client
let canvasId: string
let pageId: string

beforeAll(async () => {
  /* no free resident tasks: an @mention must be refused by the meter */
  server = await startServer({ RESIDENT_TASK_LIMIT: '0' })
  owner = await new Client(server).signUp('owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('stranger@test.dev', 'Stranger')
  const canvas = await (await owner.post('/api/canvases', { name: 'Pins' })).json()
  canvasId = canvas.id
  pageId = canvas.pages[0].id
}, 70_000)

afterAll(() => server?.stop())

/** Join the canvas room and collect everything the server sends after `init`. */
function listen(client: Client): Promise<{ messages: Record<string, unknown>[]; close(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: client.header() } })
    const messages: Record<string, unknown>[] = []
    const timer = setTimeout(() => reject(new Error('ws join timed out')), 8000)
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'listener', name: 'Owner', kind: 'user' })),
    )
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d))
      if (msg.type === 'init') {
        clearTimeout(timer)
        resolve({ messages, close: () => ws.close() })
      } else messages.push(msg)
    })
    ws.on('error', reject)
  })
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 40 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
}

describe('POST /api/canvases/:id/comments', () => {
  it('pins a comment to the page point and broadcasts it to the room', async () => {
    const room = await listen(owner)
    const res = await owner.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 120.5, y: -40, text: 'Here' })
    const comment = await res.json()
    expect(res.status, JSON.stringify(comment)).toBe(200)
    expect(comment).toMatchObject({ canvasId, pageId, x: 120.5, y: -40, text: 'Here', from: 'Owner', selector: '' })
    expect(comment.frameId).toBeUndefined()
    await until(() => room.messages.some((m) => m.type === 'comment'))
    room.close()
    expect(room.messages.find((m) => m.type === 'comment')).toMatchObject({ comment: { id: comment.id, pageId } })
  })

  it('rejects a page the canvas does not have, a bad point and blank text', async () => {
    const bad = async (body: unknown) => (await owner.post(`/api/canvases/${canvasId}/comments`, body)).status
    expect(await bad({ pageId: 'nope', x: 0, y: 0, text: 'Here' })).toBe(400)
    expect(await bad({ x: 0, y: 0, text: 'Here' })).toBe(400)
    expect(await bad({ pageId, x: 'left', y: 0, text: 'Here' })).toBe(400)
    expect(await bad({ pageId, x: 0, text: 'Here' })).toBe(400)
    expect(await bad({ pageId, x: 0, y: 0, text: '   ' })).toBe(400)
    expect(await bad({ pageId, x: 0, y: 0 })).toBe(400)
  })

  it('meters an @mention like an element comment', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 0, y: 0, text: '@doop add a hero' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'resident_limit' })
  })

  it('needs access to the canvas', async () => {
    const res = await stranger.post(`/api/canvases/${canvasId}/comments`, { pageId, x: 0, y: 0, text: 'Hi' })
    expect(res.status).toBe(403)
    expect((await owner.post('/api/canvases/missing/comments', { pageId, x: 0, y: 0, text: 'Hi' })).status).toBe(404)
  })

  it('survives a restart and comes back in the room state', async () => {
    const { dataDir } = server
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({ RESIDENT_TASK_LIMIT: '0', PORT: String(server.port) }, dataDir)
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
    const init = await new Promise<{ comments: Record<string, unknown>[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws join timed out')), 8000)
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'again', name: 'Owner', kind: 'user' })),
      )
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d))
        if (msg.type !== 'init') return
        clearTimeout(timer)
        resolve(msg)
      })
      ws.on('error', reject)
    })
    ws.close()
    expect(init.comments).toMatchObject([{ pageId, x: 120.5, y: -40, text: 'Here' }])
    expect(init.comments[0]?.frameId).toBeUndefined()
  }, 70_000)
})

describe('POST /api/frames/:id/comments on the frame as a whole', () => {
  it('keeps the point it was left at, and replies inherit it', async () => {
    const frame = await (
      await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Card', width: 400, height: 300, html: '<p>Hi</p>' })
    ).json()
    const res = await owner.post(`/api/frames/${frame.id}/comments`, {
      selector: 'body',
      snippet: '',
      text: 'Here',
      x: 320,
      y: 210,
    })
    const comment = await res.json()
    expect(res.status, JSON.stringify(comment)).toBe(200)
    expect(comment).toMatchObject({ frameId: frame.id, selector: 'body', x: 320, y: 210 })
    expect(comment.pageId).toBeUndefined()
    const reply = await (await owner.post(`/api/comments/${comment.id}/replies`, { text: 'Agreed' })).json()
    expect(reply).toMatchObject({ frameId: frame.id, selector: 'body', x: 320, y: 210, parentId: comment.id })
  })

  it('drops a point sent with an element comment', async () => {
    const frame = await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Other',
        width: 400,
        height: 300,
        html: '<p>Hi</p>',
      })
    ).json()
    const comment = await (
      await owner.post(`/api/frames/${frame.id}/comments`, {
        selector: 'p',
        snippet: '<p>Hi</p>',
        text: 'Here',
        x: 5,
        y: 5,
      })
    ).json()
    expect(comment.x).toBeUndefined()
    expect(comment.y).toBeUndefined()
  })
})

describe('PATCH /api/comments/:id/anchor', () => {
  it('moves a thread off an element onto the canvas, onto a frame and back onto an element', async () => {
    const frame = await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Movable',
        width: 400,
        height: 300,
        html: '<p>Hi</p><button>Go</button>',
      })
    ).json()
    const root = await (
      await owner.post(`/api/frames/${frame.id}/comments`, { selector: 'p', snippet: '<p>Hi</p>', text: 'Move me' })
    ).json()
    const reply = await (await owner.post(`/api/comments/${root.id}/replies`, { text: 'Along' })).json()

    const room = await listen(owner)
    /* onto the canvas: the frame is gone from root and reply alike */
    let res = await owner.patch(`/api/comments/${root.id}/anchor`, { pageId, x: 10, y: 20 })
    let moved = await res.json()
    expect(res.status, JSON.stringify(moved)).toBe(200)
    expect(moved).toMatchObject({ id: root.id, pageId, x: 10, y: 20, selector: '', snippet: '' })
    expect(moved.frameId).toBeUndefined()
    await until(() => room.messages.filter((m) => m.type === 'comment').length >= 2)
    room.close()
    const broadcast = room.messages.filter((m) => m.type === 'comment').map((m) => m.comment as ElementComment)
    expect(broadcast).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: root.id, pageId, x: 10, y: 20 }),
        expect.objectContaining({ id: reply.id, parentId: root.id, pageId, x: 10, y: 20 }),
      ]),
    )
    expect(broadcast.every((c) => c.frameId === undefined)).toBe(true)

    /* onto the frame as a whole, named through the reply: the page goes, the point stays */
    res = await owner.patch(`/api/comments/${reply.id}/anchor`, {
      frameId: frame.id,
      selector: 'body',
      snippet: '',
      x: 300,
      y: 200,
    })
    moved = await res.json()
    expect(res.status, JSON.stringify(moved)).toBe(200)
    expect(moved).toMatchObject({ id: root.id, frameId: frame.id, selector: 'body', x: 300, y: 200 })
    expect(moved.pageId).toBeUndefined()

    /* onto an element: no point on an element comment */
    res = await owner.patch(`/api/comments/${root.id}/anchor`, {
      frameId: frame.id,
      selector: 'button',
      snippet: '<button>Go</button>',
      x: 1,
      y: 2,
    })
    moved = await res.json()
    expect(moved).toMatchObject({ frameId: frame.id, selector: 'button', snippet: '<button>Go</button>' })
    expect(moved.x).toBeUndefined()
    expect(moved.y).toBeUndefined()
    expect(moved.pageId).toBeUndefined()
    /* a later reply inherits the new anchor */
    const later = await (await owner.post(`/api/comments/${root.id}/replies`, { text: 'Still here' })).json()
    expect(later).toMatchObject({ frameId: frame.id, selector: 'button', parentId: root.id })
  })

  it('refuses a bad anchor, a frame of another canvas, a missing page and strangers', async () => {
    const frame = await (
      await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Here', width: 100, height: 100, html: '<p>Hi</p>' })
    ).json()
    const root = await (
      await owner.post(`/api/frames/${frame.id}/comments`, { selector: 'p', snippet: '<p>Hi</p>', text: 'Stay' })
    ).json()
    const other = await (await owner.post('/api/canvases', { name: 'Elsewhere' })).json()
    const foreign = await (
      await owner.post(`/api/canvases/${other.id}/frames`, { name: 'Far', width: 100, height: 100, html: '<p>Hi</p>' })
    ).json()
    const status = async (body: unknown) => (await owner.patch(`/api/comments/${root.id}/anchor`, body)).status
    expect(await status({})).toBe(400)
    expect(await status({ frameId: frame.id, selector: '' })).toBe(400)
    expect(await status({ pageId, x: 'left', y: 0 })).toBe(400)
    expect(await status({ pageId: 'nope', x: 0, y: 0 })).toBe(404)
    expect(await status({ frameId: 'missing', selector: 'p', snippet: '' })).toBe(404)
    expect(await status({ frameId: foreign.id, selector: 'p', snippet: '' })).toBe(404)
    expect((await stranger.patch(`/api/comments/${root.id}/anchor`, { pageId, x: 0, y: 0 })).status).toBe(403)
    expect((await owner.patch('/api/comments/missing/anchor', { pageId, x: 0, y: 0 })).status).toBe(404)
    /* none of that moved it: a reply still lands on the element */
    const reply = await (await owner.post(`/api/comments/${root.id}/replies`, { text: 'Still' })).json()
    expect(reply).toMatchObject({ frameId: frame.id, selector: 'p' })
    expect(reply.pageId).toBeUndefined()
  })
})
