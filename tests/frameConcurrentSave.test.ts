import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness'

let server: Server
let owner: Client
let canvasId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('paths@test.dev', 'Path editor')
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Paths' })).json()) as Canvas).id
}, 70_000)

afterAll(() => server?.stop())

async function newFrame(): Promise<Frame> {
  return (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Path', html: '<p>Original</p>' })).json()
}

describe('conditional frame saves', () => {
  it('accepts only one of two simultaneous saves based on the same frame version', async () => {
    const frame = await newFrame()
    const responses = await Promise.all(
      ['<p>First user</p>', '<p>Second user</p>'].map((html) =>
        owner.patch(`/api/frames/${frame.id}`, { html, expectedUpdatedAt: frame.updatedAt }),
      ),
    )
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    const winner = (await responses.find((r) => r.status === 200)!.json()) as Frame
    const conflict = await responses.find((r) => r.status === 409)!.json()
    expect(winner.updatedAt).toBeGreaterThan(frame.updatedAt)
    expect(conflict.frame).toEqual(winner)
    const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as Canvas
    expect(canvas.frames.find((f) => f.id === frame.id)).toEqual(winner)
  })

  it('preserves a layer added after the client read its frame', async () => {
    const frame = await newFrame()
    const html = frame.html + '<p>Another user added this layer</p>'
    await owner.patch(`/api/frames/${frame.id}`, { html })
    const stale = await owner.patch(`/api/frames/${frame.id}`, {
      html: '<p>Stale path edit</p>',
      expectedUpdatedAt: frame.updatedAt,
    })
    expect(stale.status).toBe(409)
    expect((await stale.json()).frame.html).toBe(html)
  })

  it.each([null, '1', -1, 1.5])('rejects invalid frame versions: %s', async (expectedUpdatedAt) => {
    const frame = await newFrame()
    const response = await owner.patch(`/api/frames/${frame.id}`, { html: 'Invalid', expectedUpdatedAt })
    expect(response.status).toBe(400)
    const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as Canvas
    expect(canvas.frames.find((f) => f.id === frame.id)?.html).toBe(frame.html)
  })
  it('refuses to delete a frame edited after the client read it', async () => {
    const frame = await newFrame()
    const updated = await (await owner.patch(`/api/frames/${frame.id}`, { html: '<p>New work</p>' })).json()
    const stale = await owner.req(`/api/frames/${frame.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedUpdatedAt: frame.updatedAt }),
    })
    expect(stale.status).toBe(409)
    expect((await stale.json()).frame).toEqual(updated)
    const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as Canvas
    expect(canvas.frames.find((f) => f.id === frame.id)).toEqual(updated)
    const removed = await owner.req(`/api/frames/${frame.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedUpdatedAt: updated.updatedAt }),
    })
    expect(removed.status).toBe(200)
  })

  it.each([null, '1', -1, 1.5])('rejects invalid deletion versions: %s', async (expectedUpdatedAt) => {
    const frame = await newFrame()
    const response = await owner.req(`/api/frames/${frame.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedUpdatedAt }),
    })
    expect(response.status).toBe(400)
    const canvas = (await (await owner.get(`/api/canvases/${canvasId}`)).json()) as Canvas
    expect(canvas.frames.some((f) => f.id === frame.id)).toBe(true)
  })

  it('still allows deletion without a version for existing clients', async () => {
    const frame = await newFrame()
    expect((await owner.req(`/api/frames/${frame.id}`, { method: 'DELETE' })).status).toBe(200)
  })
})
