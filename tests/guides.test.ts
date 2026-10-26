import WebSocket from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { CanvasGuide } from '../shared/types.ts'
import { MAX_GUIDES } from '../shared/guides.ts'

let server: Server
let owner: Client
let outsider: Client
beforeAll(async () => {
  server = await startServer()
  owner = new Client(server)
  await owner.signUp('guides-owner@test.dev', 'Guide Owner')
  outsider = new Client(server)
  await outsider.signUp('guides-outsider@test.dev', 'Outsider')
}, 60_000)
afterAll(() => server?.stop())

const put = (client: Client, canvasId: string, guide: CanvasGuide | Record<string, unknown>, id = guide.id) =>
  client.req(`/api/canvases/${canvasId}/guides/${String(id)}`, { method: 'PUT', body: JSON.stringify(guide) })

/** A room observer: resolves with the first `guide` message it sees. */
async function observe(canvasId: string) {
  const socket = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject)
    socket.on('open', () =>
      socket.send(
        JSON.stringify({ type: 'join', canvasId, clientId: 'guide-observer', name: 'Observer', kind: 'user' }),
      ),
    )
    socket.on('message', (data) => {
      if (JSON.parse(String(data)).type === 'init') resolve()
    })
  })
  const messages: { id: string; guide: CanvasGuide | null }[] = []
  socket.on('message', (data) => {
    const message = JSON.parse(String(data))
    if (message.type === 'guide') messages.push(message)
  })
  return { socket, messages }
}

it('stores guides per page, broadcasts them live, gates them by access and survives a restart', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Guides' })).json()
  const [first] = canvas.pages
  const vertical: CanvasGuide = { id: 'gv', pageId: first.id, axis: 'v', at: 120.004 }
  const horizontal: CanvasGuide = { id: 'gh', pageId: first.id, axis: 'h', at: -40 }

  expect((await put(outsider, canvas.id, vertical)).status).toBe(403)
  expect((await outsider.delete(`/api/canvases/${canvas.id}/guides/gv`)).status).toBe(403)
  expect((await put(owner, canvas.id, { ...vertical, axis: 'z' })).status).toBe(400)
  expect((await put(owner, canvas.id, { ...vertical, pageId: 'nope' })).status).toBe(400)
  expect((await put(owner, canvas.id, vertical, 'bad id!')).status).toBe(400)

  const room = await observe(canvas.id)
  try {
    const saved = await (await put(owner, canvas.id, vertical)).json()
    expect(saved).toEqual({ ...vertical, at: 120 })
    expect((await put(owner, canvas.id, horizontal)).status).toBe(200)
    /* moving keeps the id */
    expect((await put(owner, canvas.id, { ...horizontal, at: -60 })).status).toBe(200)
    await expect.poll(() => room.messages.length).toBe(3)
    expect(room.messages.map((m) => m.guide?.at)).toEqual([120, -40, -60])
    expect((await owner.delete(`/api/canvases/${canvas.id}/guides/gv`)).status).toBe(200)
    await expect.poll(() => room.messages.at(-1)).toEqual(expect.objectContaining({ id: 'gv', guide: null }))
    /* removing what is already gone is no error, and tells nobody */
    expect((await owner.delete(`/api/canvases/${canvas.id}/guides/gv`)).status).toBe(200)
  } finally {
    room.socket.close()
  }

  const current = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(current.guides).toEqual([{ ...horizontal, at: -60 }])

  await new Promise((resolve) => setTimeout(resolve, 600))
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, server.dataDir)
  const persisted = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(persisted.guides).toEqual([{ ...horizontal, at: -60 }])
}, 60_000)

it('copies guides with a page or canvas and drops them with a deleted page', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Guide pages' })).json()
  const [first] = canvas.pages
  const second = { id: 'second', name: 'Second' }
  const pages = await owner.req(`/api/canvases/${canvas.id}/pages`, {
    method: 'PUT',
    body: JSON.stringify({ pages: [first, second], expectedPages: canvas.pages }),
  })
  expect(pages.status).toBe(200)
  expect((await put(owner, canvas.id, { id: 'a', pageId: first.id, axis: 'v', at: 10 })).status).toBe(200)
  expect((await put(owner, canvas.id, { id: 'b', pageId: second.id, axis: 'h', at: 20 })).status).toBe(200)

  const copy = await (await owner.post(`/api/canvases/${canvas.id}/pages/${first.id}/duplicate`)).json()
  const withCopy = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  const copied = withCopy.guides.filter((g: CanvasGuide) => g.pageId === copy.page.id)
  expect(copied).toEqual([{ id: expect.any(String), pageId: copy.page.id, axis: 'v', at: 10 }])
  expect(copied[0].id).not.toBe('a')

  const duplicate = await (await owner.post(`/api/canvases/${canvas.id}/duplicate`)).json()
  expect(duplicate.guides).toEqual(withCopy.guides)

  const remove = await owner.req(`/api/canvases/${canvas.id}/pages`, {
    method: 'PUT',
    body: JSON.stringify({ pages: [first, copy.page], expectedPages: withCopy.pages }),
  })
  expect(remove.status).toBe(200)
  const after = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(after.guides.map((g: CanvasGuide) => g.pageId).sort()).toEqual([copy.page.id, first.id].sort())
}, 60_000)

it('tells the room which guides left with a deleted page', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Guide page delete' })).json()
  const [first] = canvas.pages
  const second = { id: 'gone', name: 'Gone' }
  await owner.req(`/api/canvases/${canvas.id}/pages`, {
    method: 'PUT',
    body: JSON.stringify({ pages: [first, second], expectedPages: canvas.pages }),
  })
  expect((await put(owner, canvas.id, { id: 'leaves', pageId: second.id, axis: 'v', at: 5 })).status).toBe(200)
  const room = await observe(canvas.id)
  try {
    const remove = await owner.req(`/api/canvases/${canvas.id}/pages`, {
      method: 'PUT',
      body: JSON.stringify({ pages: [first], expectedPages: [first, second] }),
    })
    expect(remove.status).toBe(200)
    await expect.poll(() => room.messages).toEqual([expect.objectContaining({ id: 'leaves', guide: null })])
  } finally {
    room.socket.close()
  }
}, 60_000)

it('refuses a page copy whose guides would pass the canvas limit', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Guide limit' })).json()
  const [first] = canvas.pages
  const half = Math.ceil(MAX_GUIDES / 2) + 1
  for (let i = 0; i < half; i++)
    expect((await put(owner, canvas.id, { id: `g${i}`, pageId: first.id, axis: 'v', at: i })).status).toBe(200)
  const copy = await owner.post(`/api/canvases/${canvas.id}/pages/${first.id}/duplicate`)
  expect(copy.status).toBe(400)
  expect((await copy.json()).error).toBe(`A canvas holds at most ${MAX_GUIDES} guides.`)
  const after = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(after.pages).toHaveLength(1)
  expect(after.guides).toHaveLength(half)
}, 60_000)
