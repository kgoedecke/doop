import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/* The real server and database: the soft-delete migration, the REST routes, and a deleted
   component still deleted (and still restorable) after a restart. */

const doc = (body: string) =>
  `<!doctype html><html><head><style>.tag{color:red}</style></head><body>${body}</body></html>`

interface CanvasBody {
  frames: { id: string; html: string }[]
  components: { id: string; name: string; status?: string; deletedBy?: string }[]
}

describe('soft-deleting a component over REST', () => {
  let server: Server
  let owner: Client
  let stranger: Client
  let canvasId: string
  let mainFrameId: string
  let pageId: string
  let componentId: string

  const canvas = async (client = owner) => (await (await client.get(`/api/canvases/${canvasId}`)).json()) as CanvasBody
  const pageHtml = async () => (await canvas()).frames.find((frame) => frame.id === pageId)!.html
  const listed = async () =>
    (await (await owner.get(`/api/canvases/${canvasId}/components`)).json()) as { id: string; instances: number }[]

  /** Wait for the background queue: the page no longer holds an instance marker. */
  async function untilDetached() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const html = await pageHtml()
      if (!html.includes(' data-doop-instance="')) return html
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('the instances were never detached')
  }

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@softdelete.test', 'Owner')
    stranger = await new Client(server).signUp('stranger@softdelete.test', 'Stranger')
    canvasId = ((await (await owner.post('/api/canvases', { name: 'Soft delete' })).json()) as { id: string }).id
    const main = (await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Main',
        html: doc('<span class="tag" data-doop-id="tagone">One</span>'),
      })
    ).json()) as { id: string }
    mainFrameId = main.id
    const made = await owner.post(`/api/canvases/${canvasId}/components`, {
      name: 'Tag',
      frameId: mainFrameId,
      element: 'tagone',
    })
    componentId = ((await made.json()) as { component: { id: string } }).component.id
    const page = (await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Page',
        html: doc('<doop-use component="Tag"></doop-use><doop-use component="Tag"></doop-use>'),
      })
    ).json()) as { id: string }
    pageId = page.id
  }, 60_000)

  /* background writes can still be landing when the tests end: the data directory goes
     only once the server has exited, or the removal races its shutdown flush */
  afterAll(async () => {
    if (!server) return
    server.stop({ keepData: true })
    await server.stopped
    rmSync(server.dataDir, { recursive: true, force: true })
  })

  it('deletes without writing a frame, and keeps the definition', async () => {
    const before = await pageHtml()
    expect(await listed()).toMatchObject([{ id: componentId, instances: 2 }])
    expect((await stranger.delete(`/api/canvases/${canvasId}/components/${componentId}`)).status).toBe(403)

    const res = await owner.delete(`/api/canvases/${canvasId}/components/${componentId}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deleted: 'Tag', instances_kept: 2, frames: 1 })
    expect(await pageHtml()).toBe(before)
    expect(await listed()).toEqual([])
    expect((await canvas()).components).toMatchObject([{ id: componentId, status: 'deleted', deletedBy: 'Owner' }])

    const again = await owner.delete(`/api/canvases/${canvasId}/components/${componentId}`)
    expect(again.status).toBe(400)
    expect(((await again.json()) as { error: string }).error).toContain('already deleted')
    /* a new use is refused: the frame is saved without it */
    const use = await owner.post(`/api/frames/${pageId}/instances`, { component: 'Tag' })
    expect(use.status).toBe(400)
    expect(((await use.json()) as { error: string }).error).toContain('was deleted')
  })

  it('is still deleted after a restart, and comes back on its main', async () => {
    const before = await pageHtml()
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer({}, server.dataDir)
    const cookies = owner.cookies
    owner = new Client(server)
    owner.cookies = cookies

    expect((await canvas()).components).toMatchObject([{ id: componentId, status: 'deleted' }])
    expect(await listed()).toEqual([])
    expect(await pageHtml()).toBe(before)

    const missing = await owner.post(`/api/canvases/${canvasId}/components/nope/undelete`, {})
    expect(missing.status).toBe(400)
    const restored = await owner.post(`/api/canvases/${canvasId}/components/${componentId}/undelete`, {})
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ main: 'kept', component: { id: componentId, mainFrameId } })
    expect(await listed()).toMatchObject([{ id: componentId, instances: 2 }])
    expect((await canvas()).components[0]!.status).toBeUndefined()
    expect(await pageHtml()).toBe(before)
  }, 60_000)

  it('detaches every instance in the background when asked', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/components/${componentId}/detach-instances`, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ queued: true, instances: 2, frames: 1 })
    const html = await untilDetached()
    expect(html).toContain('data-doop-detached-from')
    expect(html.match(/>One</g)).toHaveLength(2)
    expect(await listed()).toMatchObject([{ id: componentId, instances: 0 }])
  })
})
