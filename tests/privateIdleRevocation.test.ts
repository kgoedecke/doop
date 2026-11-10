import WebSocket from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

let server: Server
let owner: Client
let removed: Client
let removedId: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('idle-owner@test.dev', 'Owner')
  removed = await new Client(server).signUp('idle-removed@test.dev', 'Member')
  removedId = (await (await removed.get('/api/me')).json()).id
}, 70_000)

afterAll(() => server?.stop())

async function peer(client: Client, canvasId: string) {
  const socket = new WebSocket(`ws://localhost:${server.port}/ws`, {
    headers: { Cookie: client.header() },
    maxPayload: 65536,
  })
  const state = { socket, joined: false, closed: null as number | null, error: false, messages: [] as string[] }
  socket.on('error', () => {
    state.error = true
  })
  socket.on('close', (code) => {
    state.closed = code
  })
  socket.on('open', () =>
    socket.send(
      JSON.stringify({
        type: 'join',
        canvasId,
        clientId: `idle-${Math.random()}`,
        name: 'Idle peer',
        kind: 'user',
      }),
    ),
  )
  socket.on('message', (data) => {
    if (state.messages.length === 32) {
      state.error = true
      socket.terminate()
      return
    }
    const text = String(data)
    state.messages.push(text)
    if (JSON.parse(text).type === 'init') state.joined = true
  })
  try {
    await expect.poll(() => state.joined || state.error || state.closed !== null, { timeout: 5000 }).toBe(true)
    expect(state.error).toBe(false)
    expect(state.joined).toBe(true)
    return state
  } catch (error) {
    socket.terminate()
    throw error
  }
}

it('closes an idle removed workspace member before any edit while authorized rooms remain usable', async () => {
  const workspace = await (await owner.post('/api/workspaces', { name: 'Idle private workspace' })).json()
  expect((await owner.post(`/api/workspaces/${workspace.id}/members`, { email: 'idle-removed@test.dev' })).status).toBe(
    200,
  )
  const canvas = await (
    await owner.post('/api/canvases', { name: 'Idle private canvas', workspaceId: workspace.id })
  ).json()
  const ownCanvas = await (await removed.post('/api/canvases', { name: 'Still authorized personal work' })).json()
  const frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, {
      name: 'Draft',
      html: '<h1>Before removal</h1>',
      width: 320,
      height: 200,
    })
  ).json()
  const peers = []
  try {
    for (const [client, id] of [
      [owner, canvas.id],
      [removed, canvas.id],
      [removed, ownCanvas.id],
    ] as const)
      peers.push(await peer(client, id))
    const [authorized, revoked, unrelated] = peers
    if (!authorized || !revoked || !unrelated) throw new Error('Three actually joined native peers are required')
    expect((await owner.delete(`/api/workspaces/${workspace.id}/members/${removedId}`)).status).toBe(200)
    // No edit, reload or sentinel may cause this closure: the revocation itself must do it.
    await expect.poll(() => revoked.closed, { timeout: 5000 }).toBe(4403)
    expect(authorized.socket.readyState).toBe(WebSocket.OPEN)
    expect(unrelated.socket.readyState).toBe(WebSocket.OPEN)
    expect((await removed.get(`/api/canvases/${ownCanvas.id}`)).status).toBe(200)
    expect((await removed.get(`/api/canvases/${canvas.id}`)).status).toBe(403)
    expect(await removed.joinWs(canvas.id)).toEqual({ kind: 'closed', code: 4403 })
    expect((await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>idle-authorized-sentinel</h1>' })).status).toBe(
      200,
    )
    await expect.poll(() => authorized.messages.some((text) => text.includes('idle-authorized-sentinel'))).toBe(true)
    expect(revoked.messages.some((text) => text.includes('idle-authorized-sentinel'))).toBe(false)
    expect(peers.every((state) => !state.error)).toBe(true)
  } finally {
    for (const state of peers) state.socket.terminate()
  }
})

it('closes an idle direct collaborator when the owner removes that collaborator', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Direct private invitation' })).json()
  expect((await owner.post(`/api/canvases/${canvas.id}/members`, { email: 'idle-removed@test.dev' })).status).toBe(200)
  const joined = await peer(removed, canvas.id)
  try {
    expect((await owner.delete(`/api/canvases/${canvas.id}/members/${removedId}`)).status).toBe(200)
    await expect.poll(() => joined.closed, { timeout: 5000 }).toBe(4403)
    expect((await owner.get(`/api/canvases/${canvas.id}`)).status).toBe(200)
    expect((await removed.get(`/api/canvases/${canvas.id}`)).status).toBe(403)
  } finally {
    joined.socket.terminate()
  }
})

it('closes idle workspace members on workspace deletion while retaining the owners detached document', async () => {
  const workspace = await (await owner.post('/api/workspaces', { name: 'Deletion retains documents' })).json()
  expect((await owner.post(`/api/workspaces/${workspace.id}/members`, { email: 'idle-removed@test.dev' })).status).toBe(
    200,
  )
  const canvas = await (await owner.post('/api/canvases', { name: 'Owned document', workspaceId: workspace.id })).json()
  const joined = await peer(removed, canvas.id)
  try {
    expect((await owner.delete(`/api/workspaces/${workspace.id}`)).status).toBe(200)
    await expect.poll(() => joined.closed, { timeout: 5000 }).toBe(4403)
    expect((await owner.get(`/api/canvases/${canvas.id}`)).status).toBe(200)
    expect((await removed.get(`/api/canvases/${canvas.id}`)).status).toBe(403)
  } finally {
    joined.socket.terminate()
  }
})
