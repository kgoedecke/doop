import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The frame `hidden` flag against the REAL server (see ./harness.ts): the eye
 * in the Layers panel PATCHes it, and every client reads it back off the
 * canvas, so what the route stores is what everyone sees.
 */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

describe('frame hidden flag', () => {
  let client: Client
  let canvasId: string
  beforeAll(async () => {
    client = new Client(server)
    await client.signUp('hidden@test.dev', 'Hider')
    canvasId = (await (await client.post('/api/canvases', { name: 'Hidden' })).json()).id
  })

  async function newFrame(name: string): Promise<string> {
    return (await (await client.post(`/api/canvases/${canvasId}/frames`, { name })).json()).id
  }
  async function frameOf(frameId: string): Promise<{ hidden?: boolean; name: string }> {
    const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
    return canvas.frames.find((f: { id: string }) => f.id === frameId)
  }

  it('hides and shows a frame through PATCH', async () => {
    const id = await newFrame('eye')
    expect((await frameOf(id)).hidden).toBeFalsy()
    const hidden = await (await client.patch(`/api/frames/${id}`, { hidden: true })).json()
    expect(hidden.hidden).toBe(true)
    expect((await frameOf(id)).hidden).toBe(true)
    const shown = await (await client.patch(`/api/frames/${id}`, { hidden: false })).json()
    /* frame actors store a cleared flag as absent, not false */
    expect(shown.hidden ?? false).toBe(false)
    expect((await frameOf(id)).hidden ?? false).toBe(false)
  })

  it('takes only a literal true as hidden', async () => {
    const id = await newFrame('strict')
    const frame = await (await client.patch(`/api/frames/${id}`, { hidden: 'yes' })).json()
    expect(frame.hidden ?? false).toBe(false)
  })

  it('creates a frame hidden when asked, so undoing a delete brings it back as it was', async () => {
    const res = await client.post(`/api/canvases/${canvasId}/frames`, { name: 'restored', hidden: true })
    const created = await res.json()
    expect(created.hidden).toBe(true)
    expect((await frameOf(created.id)).hidden).toBe(true)
    const plain = await (await client.post(`/api/canvases/${canvasId}/frames`, { name: 'plain' })).json()
    expect(plain.hidden).toBeFalsy()
  })

  it('leaves the flag alone when a patch does not mention it', async () => {
    const id = await newFrame('untouched')
    await client.patch(`/api/frames/${id}`, { hidden: true })
    const frame = await (await client.patch(`/api/frames/${id}`, { name: 'renamed' })).json()
    expect(frame.name).toBe('renamed')
    expect(frame.hidden).toBe(true)
  })
})
