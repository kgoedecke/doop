import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/* The real server with a 1 MB parse budget: a frame write that would cost more is refused
   as a 422 that names the request and the canvas, and nothing of it is stored. */

const doc = (body: string) =>
  `<!doctype html><html><head><style>.tag{color:red}</style></head><body>${body}</body></html>`

describe('the work budget over HTTP', () => {
  let server: Server
  let owner: Client
  let canvasId: string
  let frameId: string

  beforeAll(async () => {
    server = await startServer({ DOOP_WORK_BUDGET_PARSE_MB: '1' })
    owner = await new Client(server).signUp('owner@budget.test', 'Owner')
    canvasId = ((await (await owner.post('/api/canvases', { name: 'Budget' })).json()) as { id: string }).id
    const frame = (await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Tags',
        html: doc('<span class="tag" data-doop-id="tagone">One</span>'),
      })
    ).json()) as { id: string }
    frameId = frame.id
    const made = await owner.post(`/api/canvases/${canvasId}/components`, { name: 'Tag', frameId, element: 'tagone' })
    expect(made.status).toBe(200)
  }, 60_000)

  afterAll(() => server?.stop())

  const stored = async () => {
    const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as {
      frames: { id: string; html: string }[]
      components: { rev: number }[]
    }
    return { html: canvas.frames.find((frame) => frame.id === frameId)!.html, rev: canvas.components[0]!.rev }
  }

  it('answers 422 with the request and canvas named, and stores nothing', async () => {
    const before = await stored()
    const heavy = before.html
      .replace('>One<', '>Changed<')
      .replace('</body>', `<p>${'lorem ipsum '.repeat(40_000)}</p></body>`)
    const refused = await owner.patch(`/api/frames/${frameId}`, { html: heavy })
    expect(refused.status).toBe(422)
    const body = (await refused.json()) as { error: string; code: string }
    expect(body.code).toBe('work_budget_exceeded')
    expect(body.error).toContain(`PATCH /api/frames/${frameId}`)
    expect(body.error).toContain(canvasId)
    expect(await stored()).toEqual(before)
  })

  it('takes an ordinary edit as before', async () => {
    const before = await stored()
    const edited = await owner.patch(`/api/frames/${frameId}`, { html: before.html.replace('>One<', '>Two<') })
    expect(edited.status).toBe(200)
    const after = await stored()
    expect(after.html).toContain('>Two<')
    expect(after.rev).toBe(before.rev + 1)
  })
})
