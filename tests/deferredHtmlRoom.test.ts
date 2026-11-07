import WebSocket from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Canvas, ClientMessage, Frame, ServerMessage } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let canvas: Canvas
const bodyOf = (id: string) => `<!doctype html><html><body><p>${id}</p>${'x'.repeat(2000)}</body></html>`

beforeAll(async () => {
  server = await startServer()
  owner = new Client(server)
  await owner.signUp('deferred-owner@test.dev', 'Deferred Owner')
  canvas = await (await owner.post('/api/canvases', { name: 'Deferred html' })).json()
  const first = canvas.pages![0]!
  const second = { id: 'second', name: 'Second' }
  const saved = await owner.req(`/api/canvases/${canvas.id}/pages`, {
    method: 'PUT',
    body: JSON.stringify({ pages: [first, second], expectedPages: canvas.pages }),
  })
  expect(saved.status).toBe(200)
  const add = async (name: string, pageId: string) =>
    (await (
      await owner.post(`/api/canvases/${canvas.id}/frames`, { name, pageId, html: bodyOf(name) })
    ).json()) as Frame
  await add('one-a', first.id)
  await add('two-a', second.id)
  await add('two-b', second.id)
  canvas = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
}, 60_000)
afterAll(() => server?.stop())

const frameNamed = (name: string) => canvas.frames.find((f) => f.name === name)!

/** A socket in the room, with everything it has received so far */
async function join(extra: Partial<Extract<ClientMessage, { type: 'join' }>> = {}) {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  const messages: ServerMessage[] = []
  ws.on('message', (data) => messages.push(JSON.parse(String(data))))
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject)
    ws.once('open', resolve)
  })
  ws.send(
    JSON.stringify({
      type: 'join',
      canvasId: canvas.id,
      clientId: `c-${Math.random()}`,
      name: 't',
      kind: 'user',
      ...extra,
    }),
  )
  await expect.poll(() => messages.some((m) => m.type === 'init')).toBe(true)
  const init = messages.find((m): m is Extract<ServerMessage, { type: 'init' }> => m.type === 'init')!
  return {
    ws,
    init,
    messages,
    send: (msg: ClientMessage) => ws.send(JSON.stringify(msg)),
    htmlSent: () =>
      messages.flatMap((m) => (m.type === 'frames:html' ? m.frames : [])).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

it('sends every frame complete to a client that did not ask for deferral', async () => {
  const room = await join()
  try {
    expect(room.init.pageId).toBeUndefined()
    expect(room.init.canvas.frames).toHaveLength(3)
    for (const f of room.init.canvas.frames) {
      expect(f.html).toContain(f.name)
      expect(f).not.toHaveProperty('htmlDeferred')
    }
  } finally {
    room.ws.close()
  }
})

it('opens a deferring client on the first page, other pages without their HTML', async () => {
  const room = await join({ deferHtml: true })
  try {
    expect(room.init.pageId).toBe(canvas.pages![0]!.id)
    const byName = Object.fromEntries(room.init.canvas.frames.map((f) => [f.name, f]))
    expect(byName['one-a']!.html).toContain('one-a')
    expect(byName['one-a']).not.toHaveProperty('htmlDeferred')
    for (const name of ['two-a', 'two-b']) {
      expect(byName[name]).toMatchObject({ html: '', htmlDeferred: true, width: frameNamed(name).width })
    }
    const whole = await join()
    whole.ws.close()
    expect(JSON.stringify(room.init).length).toBeLessThan(JSON.stringify(whole.init).length)
    expect(JSON.stringify(room.init).includes('two-a</p>')).toBe(false)
  } finally {
    room.ws.close()
  }
})

it('opens on the page it names, or on the page of the frame a link names', async () => {
  const byPage = await join({ deferHtml: true, pageId: 'second' })
  const byFrame = await join({ deferHtml: true, frameId: frameNamed('two-b').id })
  const stale = await join({ deferHtml: true, pageId: 'gone', frameId: 'gone' })
  try {
    expect(byPage.init.pageId).toBe('second')
    expect(byPage.init.canvas.frames.filter((f) => f.htmlDeferred).map((f) => f.name)).toEqual(['one-a'])
    expect(byFrame.init.pageId).toBe('second')
    expect(stale.init.pageId).toBe(canvas.pages![0]!.id)
  } finally {
    for (const room of [byPage, byFrame, stale]) room.ws.close()
  }
})

it('loads the HTML of a page, or of named frames from any page, in answer to frames:load', async () => {
  const room = await join({ deferHtml: true })
  try {
    room.send({ type: 'frames:load', pageId: 'second' })
    await expect.poll(() => room.htmlSent().length).toBe(2)
    expect(room.htmlSent()).toEqual(
      ['two-a', 'two-b']
        .map((name) => ({ id: frameNamed(name).id, html: frameNamed(name).html }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    )

    const before = room.messages.length
    room.send({ type: 'frames:load', frameIds: [frameNamed('one-a').id, 'no-such-frame', 7 as unknown as string] })
    await expect.poll(() => room.messages.length).toBe(before + 1)
    expect(room.messages.at(-1)).toEqual({
      type: 'frames:html',
      frames: [{ id: frameNamed('one-a').id, html: frameNamed('one-a').html }],
    })
  } finally {
    room.ws.close()
  }
})

it('does not answer a frames:load from a socket that has not joined', async () => {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  const received: string[] = []
  ws.on('message', (data) => received.push(String(data)))
  await new Promise<void>((resolve) => ws.once('open', resolve))
  ws.send(JSON.stringify({ type: 'frames:load', pageId: 'second' }))
  /* nothing to await: the claim is that no reply ever comes */
  await new Promise((resolve) => setTimeout(resolve, 300))
  ws.close()
  expect(received).toEqual([])
})

it('negotiates permessage-deflate on the room socket', async () => {
  const room = await join()
  try {
    expect(room.ws.extensions).toContain('permessage-deflate')
  } finally {
    room.ws.close()
  }
})

it('opens the canvas over REST on one page, and by default whole', async () => {
  const whole = (await (await owner.get(`/api/canvases/${canvas.id}`)).json()) as Canvas
  expect(whole.frames.every((f) => f.html.includes(f.name) && !f.htmlDeferred)).toBe(true)

  const one = (await (await owner.get(`/api/canvases/${canvas.id}?pageId=second`)).json()) as Canvas
  expect(one.frames.filter((f) => f.htmlDeferred).map((f) => f.name)).toEqual(['one-a'])
  expect(one.frames.find((f) => f.name === 'two-a')!.html).toContain('two-a')
  expect(one).toMatchObject({ id: canvas.id, role: 'edit' })

  expect((await owner.get(`/api/canvases/${canvas.id}?pageId=gone`)).status).toBe(400)
})

it('serves one frame with its HTML, to those who may see the canvas', async () => {
  const frame = frameNamed('one-a')
  expect(await (await owner.get(`/api/frames/${frame.id}`)).json()).toMatchObject({ id: frame.id, html: frame.html })
  const stranger = await new Client(server).signUp('deferred-stranger@test.dev', 'Stranger')
  expect([403, 404]).toContain((await stranger.get(`/api/frames/${frame.id}`)).status)
})

it('compresses a canvas read for a client that accepts it, and leaves small replies alone', async () => {
  const res = await owner.req(`/api/canvases/${canvas.id}`, { headers: { 'Accept-Encoding': 'gzip' } })
  expect(res.headers.get('content-encoding')).toBe('gzip')
  expect(((await res.json()) as Canvas).frames).toHaveLength(3)
  const small = await owner.req('/api/me', { headers: { 'Accept-Encoding': 'gzip' } })
  expect(small.headers.get('content-encoding')).toBeNull()
})

it('keeps sending live updates with their HTML, for any page', async () => {
  const room = await join({ deferHtml: true })
  try {
    const edited = frameNamed('two-a')
    const res = await owner.patch(`/api/frames/${edited.id}`, {
      html: '<!doctype html><html><body>edited</body></html>',
    })
    expect(res.status).toBe(200)
    await expect.poll(() => room.messages.some((m) => m.type === 'frame:updated')).toBe(true)
    const update = room.messages.find((m) => m.type === 'frame:updated')
    expect(update).toMatchObject({ frame: { id: edited.id, html: expect.stringContaining('edited') } })
    expect(update).not.toHaveProperty('frame.htmlDeferred')
  } finally {
    room.ws.close()
  }
})
