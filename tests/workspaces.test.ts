import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Shared workspaces on a self-hosted instance (no Stripe): every workspace
 * is active, membership grants access to every canvas inside, and the
 * per-canvas rules keep working around it. Real server, real database.
 */

const PORT = 5001

let server: Server

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
}, 70_000)

afterAll(() => server?.stop())

describe('workspaces (self-hosted, billing off)', () => {
  let owner: Client
  let teammate: Client
  let stranger: Client
  let teammateId: string
  let strangerId: string
  let workspaceId: string
  let canvasId: string
  let personalId: string

  beforeAll(async () => {
    owner = new Client(server)
    teammate = new Client(server)
    stranger = new Client(server)
    await owner.signUp('ws-owner@test.dev', 'Owner')
    await teammate.signUp('ws-mate@test.dev', 'Mate')
    await stranger.signUp('ws-stranger@test.dev', 'Stranger')
    teammateId = (await (await teammate.get('/api/me')).json()).id
    strangerId = (await (await stranger.get('/api/me')).json()).id
  })

  it('creates a workspace that is active without Stripe', async () => {
    const res = await owner.post('/api/workspaces', { name: 'Acme Design' })
    const ws = await res.json()
    expect(res.status, JSON.stringify(ws)).toBe(200)
    workspaceId = ws.id
    expect(ws.role).toBe('owner')
    expect(ws.active).toBe(true)
    expect(ws.status).toBe('inactive')
    expect(ws.memberCount).toBe(1)

    const list = await (await owner.get('/api/workspaces')).json()
    expect(list.billing.enabled).toBe(false)
    expect(list.workspaces.map((w: { id: string }) => w.id)).toEqual([workspaceId])
    const me = await (await owner.get('/api/me')).json()
    expect(me.plan).toBe('free')
  })

  it('hides the workspace from non-members', async () => {
    expect((await stranger.get(`/api/workspaces/${workspaceId}`)).status).toBe(404)
    expect((await stranger.patch(`/api/workspaces/${workspaceId}`, { name: 'Mine now' })).status).toBe(404)
  })

  it('adds an existing account as a member and invites an unknown email', async () => {
    const add = await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'ws-mate@test.dev' })
    const body = await add.json()
    expect(add.status, JSON.stringify(body)).toBe(200)
    expect(body.member.userId).toBe(teammateId)
    expect(body.member.role).toBe('member')

    const invite = await owner.post(`/api/workspaces/${workspaceId}/members`, {
      email: 'Later@Test.dev',
      role: 'admin',
    })
    const pending = await invite.json()
    expect(invite.status).toBe(200)
    expect(pending.invite.email).toBe('later@test.dev')
    expect(pending.invite.role).toBe('admin')

    const detail = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(detail.memberCount).toBe(2)
    expect(detail.members.map((m: { role: string }) => m.role)).toEqual(['owner', 'member'])
    expect(detail.invites).toHaveLength(1)
    /* members see the people, not the pending invites */
    const asMate = await (await teammate.get(`/api/workspaces/${workspaceId}`)).json()
    expect(asMate.role).toBe('member')
    expect(asMate.invites).toEqual([])
  })

  it('a member cannot invite, an admin can', async () => {
    expect((await teammate.post(`/api/workspaces/${workspaceId}/members`, { email: 'x@test.dev' })).status).toBe(403)
    expect((await owner.patch(`/api/workspaces/${workspaceId}/members/${teammateId}`, { role: 'admin' })).status).toBe(
      200,
    )
    expect((await owner.patch(`/api/workspaces/${workspaceId}/members/${teammateId}`, { role: 'owner' })).status).toBe(
      400,
    )
    const res = await teammate.post(`/api/workspaces/${workspaceId}/members`, { email: 'ws-stranger@test.dev' })
    expect(res.status).toBe(200)
    /* and back to member for the rest of the suite */
    expect((await owner.patch(`/api/workspaces/${workspaceId}/members/${teammateId}`, { role: 'member' })).status).toBe(
      200,
    )
    expect((await owner.delete(`/api/workspaces/${workspaceId}/members/${strangerId}`)).status).toBe(200)
  })

  it('an invited email joins on signup', async () => {
    const later = new Client(server)
    await later.signUp('later@test.dev', 'Later')
    const mine = await (await later.get('/api/workspaces')).json()
    expect(mine.workspaces).toHaveLength(1)
    expect(mine.workspaces[0].role).toBe('admin')
    const detail = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(detail.invites).toEqual([])
    expect(detail.memberCount).toBe(3)
  })

  it('every member opens a workspace canvas — REST and WebSocket', async () => {
    const created = await owner.post('/api/canvases', { name: 'Brand site', workspaceId })
    const canvas = await created.json()
    expect(created.status, JSON.stringify(canvas)).toBe(200)
    canvasId = canvas.id
    expect(canvas.workspaceId).toBe(workspaceId)

    expect((await teammate.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect(await teammate.joinWs(canvasId)).toEqual({ kind: 'init' })
    expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect(await stranger.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4403 })

    /* it lands on the teammate's dashboard, tagged with its workspace */
    const list = await (await teammate.get('/api/canvases')).json()
    const row = list.find((c: { id: string }) => c.id === canvasId)
    expect(row.workspaceId).toBe(workspaceId)
    expect(row.shared).toBe(true)
    const ws = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(ws.canvasCount).toBe(1)
  })

  it('creating in a workspace you are not in is a 404, not a leak', async () => {
    expect((await stranger.post('/api/canvases', { name: 'Sneak', workspaceId })).status).toBe(404)
  })

  it('moves a personal canvas in and out', async () => {
    personalId = (await (await teammate.post('/api/canvases', { name: 'Mine' })).json()).id
    expect((await owner.get(`/api/canvases/${personalId}`)).status).toBe(403)

    expect(
      (
        await teammate.req(`/api/canvases/${personalId}/workspace`, {
          method: 'PUT',
          body: JSON.stringify({ workspaceId }),
        })
      ).status,
    ).toBe(200)
    expect((await owner.get(`/api/canvases/${personalId}`)).status).toBe(200)

    /* a plain member cannot move someone else's canvas out; the owner can */
    const moved = await owner.req(`/api/canvases/${canvasId}/workspace`, {
      method: 'PUT',
      body: JSON.stringify({ workspaceId: null }),
    })
    expect(moved.status).toBe(200)
    expect((await teammate.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect(
      (
        await teammate.req(`/api/canvases/${canvasId}/workspace`, {
          method: 'PUT',
          body: JSON.stringify({ workspaceId }),
        })
      ).status,
    ).toBe(403)
    /* and back in for the rest of the suite */
    expect(
      (await owner.req(`/api/canvases/${canvasId}/workspace`, { method: 'PUT', body: JSON.stringify({ workspaceId }) }))
        .status,
    ).toBe(200)
  })

  it('a workspace admin may delete a member’s canvas in the workspace', async () => {
    const scratch = (await (await teammate.post('/api/canvases', { name: 'Scratch', workspaceId })).json()).id
    expect((await stranger.delete(`/api/canvases/${scratch}`)).status).toBe(403)
    expect((await owner.delete(`/api/canvases/${scratch}`)).status).toBe(200)
  })

  it('removing a member revokes their access; leaving works; the owner cannot leave', async () => {
    expect((await owner.delete(`/api/workspaces/${workspaceId}/members/${teammateId}`)).status).toBe(200)
    expect((await teammate.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    /* they keep their own canvas, which stays filed in the workspace */
    expect((await teammate.get(`/api/canvases/${personalId}`)).status).toBe(200)
    expect((await teammate.get(`/api/workspaces/${workspaceId}`)).status).toBe(404)

    await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'ws-mate@test.dev' })
    expect((await teammate.delete(`/api/workspaces/${workspaceId}/members/${teammateId}`)).status).toBe(200)
    expect((await teammate.get(`/api/workspaces/${workspaceId}`)).status).toBe(404)
    const ownerId = (await (await owner.get('/api/me')).json()).id
    expect((await owner.delete(`/api/workspaces/${workspaceId}/members/${ownerId}`)).status).toBe(400)
  })

  it('survives a restart', async () => {
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` }, server.dataDir)
    const detail = await (await owner.get(`/api/workspaces/${workspaceId}`)).json()
    expect(detail.name).toBe('Acme Design')
    expect(detail.memberCount).toBe(2)
    expect(detail.canvasCount).toBe(2)
  }, 70_000)

  it('deleting the workspace returns its canvases to their owners', async () => {
    expect((await teammate.delete(`/api/workspaces/${workspaceId}`)).status).toBe(404)
    expect((await owner.delete(`/api/workspaces/${workspaceId}`)).status).toBe(200)
    expect((await owner.get(`/api/workspaces/${workspaceId}`)).status).toBe(404)
    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.workspaceId).toBeUndefined()
    /* the teammate's canvas went back to them alone */
    expect((await owner.get(`/api/canvases/${personalId}`)).status).toBe(403)
    expect((await teammate.get(`/api/canvases/${personalId}`)).status).toBe(200)
  })
})
