import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * GET /api/me/events end to end: a real server, a real stream, and the
 * membership changes that should make an open Home refetch.
 */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

/** Reads one user's stream and counts the `canvases` pings it has seen. */
async function listen(client: Client) {
  const controller = new AbortController()
  const res = await client.req('/api/me/events', { signal: controller.signal })
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      /* aborted */
    }
  })()
  const pings = () => text.split('\n').filter((l) => l === 'data: {"type":"canvases"}').length
  return {
    pings,
    async waitFor(n: number) {
      const until = Date.now() + 5_000
      while (pings() < n && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
      return pings()
    },
    close: () => controller.abort(),
  }
}

describe('user event stream', () => {
  let owner: Client
  let guest: Client
  let guestId: string

  beforeAll(async () => {
    owner = new Client(server)
    guest = new Client(server)
    await owner.signUp('events-owner@test.dev', 'Owner')
    await guest.signUp('events-guest@test.dev', 'Guest')
    guestId = (await (await guest.get('/api/me')).json()).id
  })

  it('refuses a signed-out request', async () => {
    const res = await new Client(server).get('/api/me/events')
    expect(res.status).toBe(401)
  })

  it('pings the invitee when a canvas is shared and when they are removed', async () => {
    const stream = await listen(guest)
    const canvas = await (await owner.post('/api/canvases', { name: 'Shared live' })).json()
    expect((await owner.post(`/api/canvases/${canvas.id}/members`, { email: 'events-guest@test.dev' })).status).toBe(
      200,
    )
    expect(await stream.waitFor(1)).toBe(1)
    /* inviting again is not news */
    await owner.post(`/api/canvases/${canvas.id}/members`, { email: 'events-guest@test.dev' })
    expect((await owner.delete(`/api/canvases/${canvas.id}/members/${guestId}`)).status).toBe(200)
    expect(await stream.waitFor(2)).toBe(2)
    expect(stream.pings()).toBe(2)
    stream.close()
  })

  it('pings on workspace membership changes and when the workspace is deleted', async () => {
    const stream = await listen(guest)
    const workspace = await (await owner.post('/api/workspaces', { name: 'Events Co' })).json()
    expect(
      (await owner.post(`/api/workspaces/${workspace.id}/members`, { email: 'events-guest@test.dev' })).status,
    ).toBe(200)
    expect(await stream.waitFor(1)).toBe(1)
    expect((await owner.delete(`/api/workspaces/${workspace.id}/members/${guestId}`)).status).toBe(200)
    expect(await stream.waitFor(2)).toBe(2)
    await owner.post(`/api/workspaces/${workspace.id}/members`, { email: 'events-guest@test.dev' })
    expect(await stream.waitFor(3)).toBe(3)
    expect((await owner.delete(`/api/workspaces/${workspace.id}`)).status).toBe(200)
    expect(await stream.waitFor(4)).toBe(4)
    stream.close()
  })
})
