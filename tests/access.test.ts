import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Integration tests for the canvas access model, run against the REAL server
 * (see ./harness.ts): a child process on a fresh PGlite database, exercised
 * over HTTP and WebSocket exactly like the browser and MCP clients. No mocks
 * — this is the same surface a self-hoster exposes to the internet.
 */

const PORT = 4977

let server: Server
let BASE: string

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  BASE = server.base
}, 70_000)

afterAll(() => server?.stop())

describe('canvas access model', () => {
  /* assigned once the server is up — the clients need its base URL and port */
  let owner: Client
  let invited: Client
  let stranger: Client
  beforeAll(() => {
    owner = new Client(server)
    invited = new Client(server)
    stranger = new Client(server)
  })
  let canvasId: string
  let frameId: string
  let invitedId: string

  it('rejects unauthenticated API and MCP calls', async () => {
    expect((await fetch(`${BASE}/api/canvases`)).status).toBe(401)
    const mcp = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' })
    expect(mcp.status).toBe(401)
    expect(mcp.headers.get('www-authenticate')).toContain('oauth-protected-resource')
  })

  it('signs up three accounts and creates a canvas with a frame', async () => {
    await owner.signUp('owner@test.dev', 'Owner')
    await invited.signUp('invited@test.dev', 'Invited')
    await stranger.signUp('stranger@test.dev', 'Stranger')
    invitedId = (await (await invited.get('/api/me')).json()).id

    const canvas = await (await owner.post('/api/canvases', { name: 'ACL' })).json()
    canvasId = canvas.id
    const frame = await (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'F1' })).json()
    frameId = frame.id

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const upload = await owner.req(`/api/canvases/${canvasId}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    })
    const asset = await upload.json()
    expect(upload.status, JSON.stringify(asset)).toBe(200)
    expect(
      (
        await owner.patch(`/api/frames/${frameId}`, {
          html: `<img src="${asset.url}" alt="duplication test">`,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await owner.req(`/api/canvases/${canvasId}/guidelines/brand`, {
          method: 'PUT',
          body: JSON.stringify({ markdown: 'Use the brand blue.', title: 'Brand' }),
        })
      ).status,
    ).toBe(200)
    expect((await owner.post(`/api/canvases/${canvasId}/references`, { frameId })).status).toBe(200)
  })

  it('is private by default: non-owners are blocked everywhere', async () => {
    expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect((await stranger.post(`/api/canvases/${canvasId}/frames`, { name: 'x' })).status).toBe(403)
    expect((await stranger.patch(`/api/frames/${frameId}`, { name: 'hacked' })).status).toBe(403)
    expect((await stranger.delete(`/api/frames/${frameId}`)).status).toBe(403)
    expect((await stranger.patch(`/api/canvases/${canvasId}`, { name: 'renamed' })).status).toBe(403)
    expect(await stranger.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4403 })
  })

  it('invited members get full access; the owner is unaffected', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/members`, { email: 'invited@test.dev' })
    expect(res.status).toBe(200)
    expect((await invited.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect((await invited.post(`/api/canvases/${canvasId}/frames`, { name: 'by invited' })).status).toBe(200)
    expect(await invited.joinWs(canvasId)).toEqual({ kind: 'init' })
    expect((await owner.get(`/api/canvases/${canvasId}`)).status).toBe(200)
  })

  it('membership management is owner-only (members may leave)', async () => {
    expect((await invited.post(`/api/canvases/${canvasId}/members`, { email: 'stranger@test.dev' })).status).toBe(403)
    expect((await owner.post(`/api/canvases/${canvasId}/members`, { email: 'nobody@test.dev' })).status).toBe(404)
    expect((await stranger.delete(`/api/canvases/${canvasId}/members/${invitedId}`)).status).toBe(403)

    const people = await (await owner.get(`/api/canvases/${canvasId}/members`)).json()
    expect(people.map((p: { email: string; owner: boolean }) => [p.email, p.owner])).toEqual([
      ['owner@test.dev', true],
      ['invited@test.dev', false],
    ])
  })

  it('lists invited canvases on the member home screen, marked shared', async () => {
    const list = await (await invited.get('/api/canvases')).json()
    const entry = list.find((c: { id: string }) => c.id === canvasId)
    expect(entry?.shared).toBe(true)
  })

  it('only the owner can flip link access; edit opens the canvas to everyone signed in', async () => {
    expect((await invited.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })).status).toBe(403)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'bogus' })).status).toBe(400)

    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })).status).toBe(200)
    expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect(await stranger.joinWs(canvasId)).toEqual({ kind: 'init' })

    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' })).status).toBe(200)
    expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(403)
  })

  it('lets durable collaborators duplicate design content into a private canvas of their own', async () => {
    expect((await stranger.post(`/api/canvases/${canvasId}/duplicate`)).status).toBe(403)

    const res = await invited.post(`/api/canvases/${canvasId}/duplicate`)
    const copy = await res.json()
    expect(res.status, JSON.stringify(copy)).toBe(200)
    expect(copy.name).toBe('ACL copy')
    expect(copy.ownerId).toBe(invitedId)
    expect(copy.linkAccess).toBeUndefined()
    expect(copy.memberIds).toBeUndefined()
    expect(copy.frames).toHaveLength(2)
    expect(copy.frames.map((frame: { canvasId: string }) => frame.canvasId)).toEqual([copy.id, copy.id])
    expect(copy.frames.map((frame: { id: string }) => frame.id)).not.toContain(frameId)
    expect(copy.guidelines).toMatchObject([{ name: 'brand', markdown: 'Use the brand blue.', title: 'Brand' }])
    expect(copy.references).toHaveLength(1)
    expect(copy.references[0].id).not.toBe(
      (await (await owner.get(`/api/canvases/${canvasId}`)).json()).references[0].id,
    )
    expect(copy.references[0].frameId).toBe(copy.frames.find((frame: { name: string }) => frame.name === 'F1').id)
    const copiedImage = copy.frames.find((frame: { name: string }) => frame.name === 'F1')
    expect(copiedImage.html).toMatch(/<img src="http:\/\/localhost:\d+\/a\/[A-Za-z0-9_-]+\.png"/)
    const copiedAsset = await fetch(copiedImage.html.match(/src="([^"]+)"/)![1])
    expect(copiedAsset.status).toBe(200)
    expect(copiedAsset.headers.get('content-type')).toBe('image/png')
    expect((await stranger.get(`/api/canvases/${copy.id}`)).status).toBe(403)
    expect((await invited.delete(`/api/canvases/${copy.id}`)).status).toBe(200)
  })

  it('a member who leaves loses access', async () => {
    expect((await invited.delete(`/api/canvases/${canvasId}/members/${invitedId}`)).status).toBe(200)
    expect((await invited.get(`/api/canvases/${canvasId}`)).status).toBe(403)
  })

  it('canvas deletion stays owner-only', async () => {
    await owner.post(`/api/canvases/${canvasId}/members`, { email: 'invited@test.dev' })
    expect((await invited.delete(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect((await owner.delete(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect((await owner.get(`/api/canvases/${canvasId}`)).status).toBe(404)
  })
})
