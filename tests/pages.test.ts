import WebSocket from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

const PORT = 4987
let server: Server
let owner: Client
let outsider: Client
beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  owner = new Client(server)
  await owner.signUp('pages-owner@test.dev', 'Page Owner')
  outsider = new Client(server)
  await outsider.signUp('pages-outsider@test.dev', 'Outsider')
}, 60_000)
afterAll(() => server?.stop())

it('creates, reorders and copies pages while preserving frame membership and access control', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Pages test' })).json()
  const first = canvas.pages[0]
  const frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Original', x: 5000 })).json()
  expect(frame.pageId).toBe(first.id)
  const second = { id: 'second', name: 'Exploration' }
  const save = async (pages: unknown, client = owner) => {
    const current = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
    return client.req(`/api/canvases/${canvas.id}/pages`, {
      method: 'PUT',
      body: JSON.stringify({ pages, expectedPages: current.pages }),
    })
  }
  expect((await save([first, second], outsider)).status).toBe(403)
  expect((await save([])).status).toBe(400)
  expect((await save([first, first])).status).toBe(400)
  const socket = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: owner.header() } })
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject)
    socket.on('open', () =>
      socket.send(
        JSON.stringify({
          type: 'join',
          canvasId: canvas.id,
          clientId: 'pages-observer',
          name: 'Observer',
          kind: 'user',
        }),
      ),
    )
    socket.on('message', (data) => {
      if (JSON.parse(String(data)).type === 'init') resolve()
    })
  })
  const broadcast = new Promise<unknown>((resolve) =>
    socket.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.type === 'canvas:pages') resolve(message.pages)
    }),
  )
  try {
    expect((await save([first, second])).status).toBe(200)
    expect(await broadcast).toEqual([first, second])
  } finally {
    socket.close()
  }
  const newFrame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Fresh', pageId: second.id })
  ).json()
  expect(newFrame).toMatchObject({ pageId: second.id, x: 120 })
  expect((await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Bad', pageId: 'unknown' })).status).toBe(400)
  expect((await owner.patch(`/api/frames/${frame.id}`, { pageId: 'unknown' })).status).toBe(400)
  expect((await save([second, { ...first, name: 'Main' }])).status).toBe(200)
  const reloaded = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(reloaded.pages.map((p: { name: string }) => p.name)).toEqual(['Exploration', 'Main'])
  expect(reloaded.frames.find((f: { id: string }) => f.id === frame.id).pageId).toBe(first.id)
  expect((await save([second])).status).toBe(400)
  const copy = await (await owner.post(`/api/canvases/${canvas.id}/duplicate`)).json()
  expect(copy.pages).toEqual(reloaded.pages)
  expect(copy.frames.map((f: { pageId: string }) => f.pageId)).toEqual(
    reloaded.frames.map((f: { pageId: string }) => f.pageId),
  )
  expect((await owner.patch(`/api/frames/${frame.id}`, { pageId: second.id })).status).toBe(200)
  expect((await save([second])).status).toBe(200)

  // Reopen the same database to verify actual durable writes, not just memory.
  await new Promise((resolve) => setTimeout(resolve, 600))
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` }, server.dataDir)
  const persisted = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(persisted.pages).toEqual([second])
  expect(persisted.frames.every((f: { pageId: string }) => f.pageId === second.id)).toBe(true)
}, 60_000)

it('rejects stale page replacements instead of removing another collaborator’s page', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Concurrent pages' })).json()
  const save = (pages: unknown) =>
    owner.req(`/api/canvases/${canvas.id}/pages`, {
      method: 'PUT',
      body: JSON.stringify({ pages, expectedPages: canvas.pages }),
    })
  const results = await Promise.all([
    save([...canvas.pages, { id: 'alice', name: 'Alice' }]),
    save([...canvas.pages, { id: 'bob', name: 'Bob' }]),
  ])
  expect(results.map((r) => r.status).sort()).toEqual([200, 409])
  const current = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(current.pages).toHaveLength(2)
  expect(
    (
      await owner.req(`/api/canvases/${canvas.id}/pages`, {
        method: 'PUT',
        body: JSON.stringify({ pages: current.pages }),
      })
    ).status,
  ).toBe(409)
})
