import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { Client, startServer, type Server } from './harness'

/*
 * Earlier revisions of a component stay on the server: the room's `init`, its `component`
 * messages and the REST answers hand a definition out without them, one route lists them,
 * and after a restart they are still what a stale save is merged against.
 */

const doc = (body: string) =>
  `<!doctype html><html><head><style>.tag{color:red}</style></head><body>${body}</body></html>`

interface WireMessage {
  type: string
  canvas?: { components?: Record<string, unknown>[] }
  component?: Record<string, unknown> | null
}

interface Revisions {
  rev: number
  revisions: { rev: number; template: string; savedBy: string }[]
}

/** A browser in the canvas's room: every message it was sent, in order. */
function joinRoom(server: Server, client: Client, canvasId: string) {
  const messages: WireMessage[] = []
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: client.header() } })
  ws.on('open', () =>
    ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 't', kind: 'user' })),
  )
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as WireMessage))
  ws.on('error', () => {})
  return { messages, close: () => ws.close() }
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('component revisions over HTTP and the room', () => {
  let server: Server
  let owner: Client
  let stranger: Client
  let canvasId: string
  let pageFrameId: string
  let componentId: string
  let staleHtml: string

  const canvasOf = async (client: Client, id: string) =>
    (await (await client.get(`/api/canvases/${id}`)).json()) as {
      id: string
      components: Record<string, unknown>[]
      frames: { id: string; html: string }[]
    }
  const frameHtml = async (client: Client, id: string) =>
    (await canvasOf(client, canvasId)).frames.find((frame) => frame.id === id)!.html
  const revisionsOf = async (client: Client, canvas: string) =>
    (await (await client.get(`/api/canvases/${canvas}/components/${componentId}/revisions`)).json()) as Revisions

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@revisions.test', 'Owner')
    stranger = await new Client(server).signUp('stranger@revisions.test', 'Stranger')
    canvasId = ((await (await owner.post('/api/canvases', { name: 'Revisions' })).json()) as { id: string }).id
    const main = (await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Main',
        html: doc('<span class="tag" data-doop-id="tagone">One</span>'),
      })
    ).json()) as { id: string }
    const created = (await (
      await owner.post(`/api/canvases/${canvasId}/components`, { name: 'Tag', frameId: main.id, element: 'tagone' })
    ).json()) as { component: Record<string, unknown> & { id: string } }
    componentId = created.component.id
    expect(created.component).not.toHaveProperty('history')
    const page = (await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Page',
        html: doc('<doop-use component="Tag" text="Two"></doop-use>'),
      })
    ).json()) as { id: string }
    pageFrameId = page.id
    /* what a browser that stops listening now would later save: the instance at revision 1 */
    staleHtml = await frameHtml(owner, pageFrameId)
    expect(staleHtml).toContain(`data-doop-instance="${componentId}" data-doop-rev="1"`)
  }, 60_000)

  afterAll(() => server?.stop())

  it('sends definitions without their revisions, and lists the revisions on request', async () => {
    const room = joinRoom(server, owner, canvasId)
    const init = await until(() => room.messages.find((message) => message.type === 'init'))
    expect(init.canvas!.components).toHaveLength(1)
    expect(init.canvas!.components![0]).not.toHaveProperty('history')

    for (const [find, replace] of [
      ['class="tag"', 'class="tag fresh"'],
      ['class="tag fresh"', 'class="tag fresh newer"'],
    ]) {
      const res = await owner.patch(`/api/canvases/${canvasId}/components/${componentId}`, { find, replace })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { component: Record<string, unknown> }
      expect(body.component.template).toContain(replace)
      expect(body.component).not.toHaveProperty('history')
    }

    const heard = await until(() =>
      room.messages.find((message) => message.type === 'component' && message.component?.rev === 3),
    )
    expect(heard.component).not.toHaveProperty('history')
    for (const message of room.messages)
      if (message.type === 'component' && message.component) expect(message.component).not.toHaveProperty('history')
    room.close()

    const canvas = await canvasOf(owner, canvasId)
    expect(canvas.components[0]).toMatchObject({ id: componentId, rev: 3 })
    expect(canvas.components[0]).not.toHaveProperty('history')

    const listed = await revisionsOf(owner, canvasId)
    expect(listed.rev).toBe(3)
    expect(listed.revisions.map((entry) => entry.rev)).toEqual([1, 2])
    expect(listed.revisions[0]!.template).toContain('class="tag"')
    expect(listed.revisions[1]!.template).toContain('class="tag fresh"')
  })

  it('guards the revisions like the component routes beside them', async () => {
    expect((await stranger.get(`/api/canvases/${canvasId}/components/${componentId}/revisions`)).status).toBe(403)
    expect((await owner.get(`/api/canvases/${canvasId}/components/nope/revisions`)).status).toBe(404)
  })

  it('gives a duplicated canvas its own copy of the revisions', async () => {
    const copy = (await (await owner.post(`/api/canvases/${canvasId}/duplicate`)).json()) as {
      id: string
      components: Record<string, unknown>[]
    }
    expect(copy.components[0]).toMatchObject({ id: componentId, rev: 3 })
    expect(copy.components[0]).not.toHaveProperty('history')
    expect((await revisionsOf(owner, copy.id)).revisions.map((entry) => entry.rev)).toEqual([1, 2])

    /* a revision put back on the copy is the copy's alone */
    const restored = await owner.post(`/api/canvases/${copy.id}/components/${componentId}/restore`, { rev: 1 })
    expect(restored.status).toBe(200)
    expect((await revisionsOf(owner, copy.id)).revisions.map((entry) => entry.rev)).toEqual([1, 2, 3])
    expect((await revisionsOf(owner, canvasId)).revisions.map((entry) => entry.rev)).toEqual([1, 2])

    expect((await owner.delete(`/api/canvases/${copy.id}`)).status).toBe(200)
    expect((await owner.get(`/api/canvases/${copy.id}/components/${componentId}/revisions`)).status).toBe(404)
    expect((await revisionsOf(owner, canvasId)).revisions.map((entry) => entry.rev)).toEqual([1, 2])
  })

  it('still merges a stale save after a restart, from the revisions the database kept', async () => {
    /* the instance has caught up with its main before the server goes down */
    await until(async () => ((await frameHtml(owner, pageFrameId)).includes('data-doop-rev="3"') ? true : undefined))
    const before = await revisionsOf(owner, canvasId)

    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, server.dataDir)
    const again = new Client(server)
    again.cookies = owner.cookies

    expect(await revisionsOf(again, canvasId)).toEqual(before)

    /* a browser that held revision 1 all along saves it with one real edit */
    const saved = await again.patch(`/api/frames/${pageFrameId}`, {
      html: staleHtml.replace('</body>', '<p>added</p></body>'),
    })
    expect(saved.status).toBe(200)
    const html = await frameHtml(again, pageFrameId)
    expect(html).toContain('<p>added</p>')
    expect(html).toContain('class="tag fresh newer"')
    expect(html).toContain(`data-doop-instance="${componentId}" data-doop-rev="3"`)
    expect(html).not.toContain('data-doop-overrides')
  }, 60_000)
})
