import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Workspace link sharing, against the real server (billing off, so every
 * workspace may grow): a workspace's admins can keep its canvases to the
 * team. Switched off, no canvas in it is shared by link or listed in the
 * Community gallery; the ones that were go private at once.
 */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

async function json<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()) as T
}

/** Join a canvas's room: the message types it is sent, and the code it closes with. */
function joinRoom(client: Client, canvasId: string) {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: client.header() } })
  const types: string[] = []
  ws.on('message', (raw) => types.push((JSON.parse(String(raw)) as { type: string }).type))
  let closedWith: number | null = null
  ws.on('close', (code) => (closedWith = code))
  ws.on('error', () => {})
  const joined = new Promise<void>((resolve, reject) => {
    ws.on('message', (raw) => {
      if ((JSON.parse(String(raw)) as { type: string }).type === 'init') resolve()
    })
    ws.on('close', (code) => reject(new Error(`closed with ${code} before init`)))
  })
  ws.on('open', () =>
    ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 't', kind: 'user' })),
  )
  return {
    joined,
    types,
    close: () => ws.close(),
    async closed(ms = 4000): Promise<number> {
      const deadline = Date.now() + ms
      while (closedWith === null) {
        if (Date.now() > deadline) throw new Error('room did not close')
        await new Promise((r) => setTimeout(r, 20))
      }
      return closedWith
    },
  }
}

describe('workspace link sharing', () => {
  let owner: Client
  let member: Client
  let visitor: Client
  let workspaceId: string
  let canvasId: string

  beforeAll(async () => {
    owner = new Client(server)
    member = new Client(server)
    visitor = new Client(server)
    await owner.signUp('sharing-owner@test.dev', 'Owner')
    await member.signUp('sharing-member@test.dev', 'Member')
    await visitor.signUp('sharing-visitor@test.dev', 'Visitor')
    workspaceId = (await json<{ id: string }>(await owner.post('/api/workspaces', { name: 'Acme' }))).id
    await json(await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'sharing-member@test.dev' }))
    canvasId = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Roadmap', workspaceId }))).id
    await json(await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Hero' }))
  })

  const communityIds = async () => (await json<{ id: string }[]>(await visitor.get('/api/community'))).map((c) => c.id)

  it('is allowed by default, and owners share as before', async () => {
    const summary = await json<{ linkSharing: string }>(await owner.get(`/api/workspaces/${workspaceId}`))
    expect(summary.linkSharing).toBe('allowed')
    await json(await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' }))
    await json(await owner.put(`/api/canvases/${canvasId}/publish`, { category: 'website' }))
    expect((await visitor.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect(await communityIds()).toContain(canvasId)
  })

  it('only lets owners and admins change it', async () => {
    const res = await member.patch(`/api/workspaces/${workspaceId}`, { linkSharing: 'off' })
    expect(res.status).toBe(403)
    expect((await owner.patch(`/api/workspaces/${workspaceId}`, { linkSharing: 'nope' })).status).toBe(400)
  })

  it('switched off, makes every canvas private and drops link visitors from the room', async () => {
    const room = joinRoom(visitor, canvasId)
    const ownerRoom = joinRoom(owner, canvasId)
    await Promise.all([room.joined, ownerRoom.joined])
    const summary = await json<{ linkSharing: string }>(
      await owner.patch(`/api/workspaces/${workspaceId}`, { linkSharing: 'off' }),
    )
    expect(summary.linkSharing).toBe('off')
    expect(await room.closed()).toBe(4403)
    /* the owner's open tab hears the canvas went private, and stays */
    await expect.poll(() => ownerRoom.types).toContain('canvas:sharing-closed')
    ownerRoom.close()
    expect((await visitor.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect(await communityIds()).not.toContain(canvasId)
    /* the team keeps its access */
    expect((await member.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    const canvas = await json<{ linkAccess?: string; publishedAt?: number }>(
      await owner.get(`/api/canvases/${canvasId}`),
    )
    expect(canvas.linkAccess ?? 'none').toBe('none')
    expect(canvas.publishedAt).toBeUndefined()
  })

  it('refuses a share link or a gallery listing while it is off', async () => {
    const link = await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })
    expect(link.status).toBe(403)
    expect(((await link.json()) as { code?: string }).code).toBe('link_sharing_off')
    const listing = await owner.put(`/api/canvases/${canvasId}/publish`, { category: 'website' })
    expect(listing.status).toBe(403)
    /* making it private is always fine */
    await json(await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' }))
  })

  it('closes link visitors before announcing the destination team on a canvas move', async () => {
    await json(await owner.patch(`/api/workspaces/${workspaceId}`, { linkSharing: 'off' }))
    const personal = (await json<{ id: string }>(await owner.post('/api/canvases', { name: 'Side project' }))).id
    await json(await owner.patch(`/api/canvases/${personal}`, { linkAccess: 'comment' }))
    expect((await visitor.get(`/api/canvases/${personal}`)).status).toBe(200)
    const visitorRoom = joinRoom(visitor, personal)
    const ownerRoom = joinRoom(owner, personal)
    try {
      await Promise.all([visitorRoom.joined, ownerRoom.joined])
      const visitorStart = visitorRoom.types.length
      const ownerStart = ownerRoom.types.length
      await json(await owner.put(`/api/canvases/${personal}/workspace`, { workspaceId }))
      expect(await visitorRoom.closed()).toBe(4403)
      expect(visitorRoom.types.slice(visitorStart)).not.toContain('team')
      await expect.poll(() => ownerRoom.types.slice(ownerStart)).toContain('team')
    } finally {
      visitorRoom.close()
      ownerRoom.close()
    }
    expect((await visitor.get(`/api/canvases/${personal}`)).status).toBe(403)
    const canvas = await json<{ linkAccess?: string }>(await owner.get(`/api/canvases/${personal}`))
    expect(canvas.linkAccess ?? 'none').toBe('none')
  })

  it('switched back on, reopens nothing by itself', async () => {
    await json(await owner.patch(`/api/workspaces/${workspaceId}`, { linkSharing: 'allowed' }))
    expect((await visitor.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    await json(await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' }))
    expect((await visitor.get(`/api/canvases/${canvasId}`)).status).toBe(200)
  })
})
