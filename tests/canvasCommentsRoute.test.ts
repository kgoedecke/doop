import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'

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
