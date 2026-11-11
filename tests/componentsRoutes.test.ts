import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/* The real server and database: the migration, the REST routes and access
   rules, and components surviving a restart with their instances still live. */

const doc = (body: string) =>
  `<!doctype html><html><head><style>.tag{color:red}</style></head><body>${body}</body></html>`

describe('component routes', () => {
  let server: Server
  let owner: Client
  let stranger: Client
  let canvasId: string
  let frameId: string
  let componentId: string

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@components.test', 'Owner')
    stranger = await new Client(server).signUp('stranger@components.test', 'Stranger')
    canvasId = ((await (await owner.post('/api/canvases', { name: 'Routes' })).json()) as { id: string }).id
    const frame = (await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Tags',
        html: doc('<span class="tag" data-doop-id="tagone">One</span><span class="tag">Two</span>'),
      })
    ).json()) as { id: string }
    frameId = frame.id
  }, 60_000)

  afterAll(() => server?.stop())

  it('creates from an element and links what matches', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/components`, {
      name: 'Tag',
      frameId,
      element: 'tagone',
      replaceMatching: true,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { component: { id: string; rev: number }; converted: { instances: number }[] }
    componentId = body.component.id
    expect(body.component.rev).toBe(1)
    expect(body.converted[0]!.instances).toBe(1)
    const frame = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as {
      components: { id: string }[]
      frames: { id: string; html: string }[]
    }
    expect(frame.components.map((def) => def.id)).toEqual([componentId])
    expect(frame.frames.find((f) => f.id === frameId)!.html).toContain(`data-doop-instance="${componentId}"`)
  })

  it('reports errors as messages, not crashes', async () => {
    const taken = await owner.post(`/api/canvases/${canvasId}/components`, { name: 'tag', frameId, element: 'nosuch' })
    expect(taken.status).toBe(400)
    expect(((await taken.json()) as { error: string }).error).toContain('already has a component')
    const missing = await owner.patch(`/api/canvases/${canvasId}/components/nope`, { name: 'X' })
    expect(missing.status).toBe(400)
  })

  it('refuses a malformed body instead of crashing, and drops fields the route does not take', async () => {
    const wrongType = await owner.patch(`/api/canvases/${canvasId}/components/${componentId}`, { description: 5 })
    expect(wrongType.status).toBe(400)
    expect(((await wrongType.json()) as { error: string }).error).toContain('description')
    const before = (await (await owner.get(`/api/canvases/${canvasId}/components`)).json()) as { rev: number }[]
    /* head is a library pull's field: sent here it is ignored, not applied */
    const head = await owner.patch(`/api/canvases/${canvasId}/components/${componentId}`, { head: '<script>' })
    expect(head.status).toBe(200)
    const after = (await (await owner.get(`/api/canvases/${canvasId}/components`)).json()) as { rev: number }[]
    expect(after[0]!.rev).toBe(before[0]!.rev)
  })

  it('renders a preview sheet', async () => {
    const res = await owner.get(`/api/canvases/${canvasId}/components/${componentId}/preview`)
    const sheet = (await res.json()) as { html: string; variants: number }
    expect(sheet.variants).toBe(1)
    expect(sheet.html).toContain('One')
  })

  it('keeps people without access out', async () => {
    expect((await stranger.get(`/api/canvases/${canvasId}/components`)).status).toBe(403)
    expect(
      (await stranger.post(`/api/canvases/${canvasId}/components`, { name: 'Mine', frameId, element: 'tagone' }))
        .status,
    ).toBe(403)
    expect((await stranger.patch(`/api/frames/${frameId}/instances`, { changes: [] })).status).toBe(403)
    const source = await stranger.post('/api/canvases', { name: 'Theirs' })
    const theirs = ((await source.json()) as { id: string }).id
    const imported = await stranger.post(`/api/canvases/${theirs}/components/import`, {
      sourceCanvasId: canvasId,
      component: 'Tag',
    })
    expect(imported.status).toBe(403)
  })

  it('survives a restart, instances still following their main', async () => {
    server.stop({ keepData: true })
    await server.stopped
    const dir = server.dataDir
    server = await startServer({}, dir)
    const again = new Client(server)
    again.cookies = owner.cookies
    const list = (await (await again.get(`/api/canvases/${canvasId}/components`)).json()) as {
      id: string
      rev: number
      instances: number
    }[]
    expect(list[0]).toMatchObject({ id: componentId, rev: 1, instances: 1 })
    const res = await again.patch(`/api/canvases/${canvasId}/components/${componentId}`, {
      find: 'class="tag"',
      replace: 'class="tag after-restart"',
    })
    expect(res.status).toBe(200)
    const canvas = (await (await again.get(`/api/canvases/${canvasId}`)).json()) as {
      frames: { id: string; html: string }[]
    }
    const html = canvas.frames.find((f) => f.id === frameId)!.html
    expect(html.match(/after-restart/g)!.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('Two')
  }, 60_000)
})
