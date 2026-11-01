import WebSocket from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let outsider: Client
beforeAll(async () => {
  server = await startServer()
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
  const socket = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
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
  await server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, server.dataDir)
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

it('duplicates a page with its frames right after the source, numbering the name when taken', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Duplicate page' })).json()
  const [first] = canvas.pages
  const second = { id: 'second', name: 'Exploration' }
  expect(
    (
      await owner.req(`/api/canvases/${canvas.id}/pages`, {
        method: 'PUT',
        body: JSON.stringify({ pages: [first, second], expectedPages: canvas.pages }),
      })
    ).status,
  ).toBe(200)
  const hero = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, {
      name: 'Hero',
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      html: '<h1>Hero</h1>',
      hidden: true,
      locked: true,
    })
  ).json()
  const card = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Card', x: 400, y: 20, html: '<p>Card</p>' })
  ).json()
  await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Elsewhere', pageId: second.id })
  const url = `/api/canvases/${canvas.id}/pages/${first.id}/duplicate`
  expect((await outsider.post(url)).status).toBe(403)
  expect((await owner.post(`/api/canvases/${canvas.id}/pages/missing/duplicate`)).status).toBe(404)

  const socket = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  const seen: { type: string; frame?: { id: string }; pages?: unknown }[] = []
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject)
    socket.on('open', () =>
      socket.send(
        JSON.stringify({ type: 'join', canvasId: canvas.id, clientId: 'dup-observer', name: 'Observer', kind: 'user' }),
      ),
    )
    socket.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.type === 'init') resolve()
      else seen.push(message)
    })
  })
  let copy: { page: { id: string; name: string }; pages: { id: string }[]; frames: Record<string, unknown>[] }
  try {
    const res = await owner.post(url)
    expect(res.status).toBe(200)
    copy = await res.json()
    const deadline = Date.now() + 5_000
    while (seen.filter((m) => m.type === 'frame:created').length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20))
  } finally {
    socket.close()
  }
  expect(copy.page.name).toBe('Page 1 copy')
  expect(copy.pages.map((p) => p.id)).toEqual([first.id, copy.page.id, second.id])
  expect(copy.frames).toHaveLength(2)
  const copiedHero = copy.frames.find((f) => f.name === 'Hero')!
  expect(copiedHero).toMatchObject({
    pageId: copy.page.id,
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    html: '<h1>Hero</h1>',
    hidden: true,
    locked: true,
  })
  expect(copiedHero.id).not.toBe(hero.id)
  expect(copy.frames.find((f) => f.name === 'Card')).toMatchObject({
    pageId: copy.page.id,
    x: 400,
    html: '<p>Card</p>',
  })
  expect(copy.frames.every((f) => f.id !== card.id)).toBe(true)
  expect(seen.find((m) => m.type === 'canvas:pages')?.pages).toEqual(copy.pages)
  expect(seen.filter((m) => m.type === 'frame:created').map((m) => m.frame!.id)).toEqual(copy.frames.map((f) => f.id))

  const again = await (await owner.post(url)).json()
  expect(again.page.name).toBe('Page 1 copy 2')
  expect(again.pages.map((p: { id: string }) => p.id)).toEqual([first.id, again.page.id, copy.page.id, second.id])
  const nested = await (await owner.post(`/api/canvases/${canvas.id}/pages/${copy.page.id}/duplicate`)).json()
  expect(nested.page.name).toBe('Page 1 copy copy')
  expect(nested.pages.map((p: { id: string }) => p.id)).toEqual([
    first.id,
    again.page.id,
    copy.page.id,
    nested.page.id,
    second.id,
  ])

  // Reopen the database: the page and its frames were written as one unit.
  await server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, server.dataDir)
  const persisted = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(persisted.pages).toEqual(nested.pages)
  const onPage = (pageId: string) => persisted.frames.filter((f: { pageId: string }) => f.pageId === pageId)
  expect(onPage(first.id)).toHaveLength(2)
  expect(
    onPage(copy.page.id)
      .map((f: { name: string }) => f.name)
      .sort(),
  ).toEqual(['Card', 'Hero'])
  expect(onPage(again.page.id)).toHaveLength(2)
  expect(onPage(nested.page.id)).toHaveLength(2)
  expect(onPage(second.id)).toHaveLength(1)
  for (const pageId of [copy.page.id, again.page.id, nested.page.id]) {
    expect(onPage(pageId).find((f: { name: string }) => f.name === 'Hero')).toMatchObject({
      hidden: true,
      locked: true,
    })
    const card = onPage(pageId).find((f: { name: string }) => f.name === 'Card')
    expect(card.hidden).toBeFalsy()
    expect(card.locked).toBeFalsy()
  }
}, 60_000)

it('serializes concurrent duplicates so names stay unique and the page limit holds', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Concurrent duplicates' })).json()
  const [first] = canvas.pages
  const url = `/api/canvases/${canvas.id}/pages/${first.id}/duplicate`
  const pair = await Promise.all([owner.post(url), owner.post(url)])
  expect(pair.map((r) => r.status)).toEqual([200, 200])
  const copies = await Promise.all(pair.map((r) => r.json()))
  expect(copies.map((c) => c.page.name).sort()).toEqual(['Page 1 copy', 'Page 1 copy 2'])
  const after = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(after.pages.map((p: { name: string }) => p.name)).toEqual(['Page 1', 'Page 1 copy 2', 'Page 1 copy'])

  const filler = Array.from({ length: 96 }, (_, i) => ({ id: `fill-${i}`, name: `Fill ${i}` }))
  expect(
    (
      await owner.req(`/api/canvases/${canvas.id}/pages`, {
        method: 'PUT',
        body: JSON.stringify({ pages: [...after.pages, ...filler], expectedPages: after.pages }),
      })
    ).status,
  ).toBe(200)
  const atLimit = await Promise.all([owner.post(url), owner.post(url)])
  expect(atLimit.map((r) => r.status).sort()).toEqual([200, 400])
  const full = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(full.pages).toHaveLength(100)
  expect((await owner.post(url)).status).toBe(400)
})
