import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let visitor: Client
let canvasId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('registry-owner@test.dev', 'Owner')
  visitor = await new Client(server).signUp('registry-visitor@test.dev', 'Visitor')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Registry design' })).json()).id
  await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })
}, 70_000)

afterAll(() => server?.stop())

describe('registry import access and validation', () => {
  for (const path of ['/preview', '']) {
    it(`requires edit access for ${path || 'import'}`, async () => {
      const response = await visitor.post(`/api/canvases/${canvasId}/import/registry${path}`, {
        url: 'https://example.com/r/registry.json',
        names: ['button'],
      })
      expect(response.status).toBe(403)
    })

    it(`rejects private URLs without changing the design for ${path || 'import'}`, async () => {
      const response = await owner.post(`/api/canvases/${canvasId}/import/registry${path}`, {
        url: 'http://127.0.0.1/registry.json',
        names: ['button'],
      })
      expect(response.status).toBe(400)
      const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
      expect(canvas.frames).toHaveLength(0)
      expect((await (await owner.get(`/api/canvases/${canvasId}/styleguide.md`)).text()).trim()).toBe(
        '# Registry design — styleguide',
      )
    })
  }

  it('rejects an empty selection before fetching registry source', async () => {
    const response = await owner.post(`/api/canvases/${canvasId}/import/registry`, {
      url: 'https://example.com/r/registry.json',
      names: [],
    })
    expect(response.status).toBe(400)
  })
})
