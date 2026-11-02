import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let author: Client
let visitor: Client

beforeAll(async () => {
  server = await startServer()
  author = new Client(server)
  await author.signUp('author@test.dev', 'Ada Author')
  visitor = new Client(server)
  await visitor.signUp('visitor@test.dev', 'Vic Visitor')
}, 60_000)

afterAll(() => server?.stop())

async function canvasWithFrame(client: Client, name: string) {
  const canvas = await (await client.post('/api/canvases', { name })).json()
  const frame = await (await client.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero' })).json()
  await client.patch(`/api/frames/${frame.id}`, { html: '<h1>hello</h1>' })
  return { canvas, frame }
}

it('lists a published canvas for others to copy without opening the source', async () => {
  const { canvas, frame } = await canvasWithFrame(author, 'Launch page')

  /* the gallery is opt-in: nothing shows before the owner publishes */
  expect(await (await visitor.get('/api/community')).json()).toEqual([])

  const published = await author.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ description: 'A bold hero.', category: 'website' }),
  })
  expect(published.status).toBe(200)
  expect(await published.json()).toMatchObject({ description: 'A bold hero.', category: 'website' })

  const listing = await (await visitor.get('/api/community')).json()
  expect(listing).toMatchObject([
    {
      id: canvas.id,
      name: 'Launch page',
      description: 'A bold hero.',
      category: 'website',
      authorName: 'Ada Author',
      copyCount: 0,
      frames: [{ id: frame.id, name: 'Hero' }],
    },
  ])
  /* previews only — the HTML stays on the owner's canvas */
  expect(JSON.stringify(listing)).not.toContain('hello')

  /* publishing does not open the canvas itself */
  expect((await visitor.get(`/api/canvases/${canvas.id}`)).status).toBe(403)
  expect((await visitor.post(`/api/canvases/${canvas.id}/duplicate`)).status).toBe(403)

  const copied = await visitor.post(`/api/community/${canvas.id}/copy`)
  const copy = await copied.json()
  expect(copied.status, JSON.stringify(copy)).toBe(200)
  expect(copy.id).not.toBe(canvas.id)
  expect(copy.name).toBe('Launch page')
  expect(copy.frames).toHaveLength(1)
  expect(copy.frames[0].html).toBe('<h1>hello</h1>')
  expect(copy.publishedAt).toBeUndefined()

  /* the copy is the visitor's own private canvas now */
  expect((await visitor.get(`/api/canvases/${copy.id}`)).status).toBe(200)
  expect((await author.get(`/api/canvases/${copy.id}`)).status).toBe(403)

  /* and the source counted it */
  const [after] = await (await visitor.get('/api/community')).json()
  expect(after.copyCount).toBe(1)

  /* only the owner may list or delist */
  const stranger = await visitor.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ category: 'app' }),
  })
  expect(stranger.status).toBe(403)

  expect((await author.delete(`/api/canvases/${canvas.id}/publish`)).status).toBe(200)
  expect(await (await visitor.get('/api/community')).json()).toEqual([])
  expect((await visitor.post(`/api/community/${canvas.id}/copy`)).status).toBe(404)
}, 60_000)

it('lists every real frame of a large design, oldest first', async () => {
  const canvas = await (await author.post('/api/canvases', { name: 'Big system' })).json()
  const names = Array.from({ length: 15 }, (_, i) => `Screen ${i + 1}`)
  for (const name of names) await author.post(`/api/canvases/${canvas.id}/frames`, { name })
  await author.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ category: 'app' }),
  })

  const listing: { id: string; frames: { name: string }[] }[] = await (await visitor.get('/api/community')).json()
  const item = listing.find((i) => i.id === canvas.id)!
  expect(item.frames.map((f) => f.name)).toEqual(names)

  await author.delete(`/api/canvases/${canvas.id}/publish`)
}, 60_000)

it('refuses listings without real content or a valid shelf', async () => {
  const blank = await (await author.post('/api/canvases', { name: 'Blank' })).json()
  const noFrames = await author.req(`/api/canvases/${blank.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ category: 'website' }),
  })
  expect(noFrames.status).toBe(400)

  const { canvas } = await canvasWithFrame(author, 'Odd shelf')
  const badShelf = await author.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ category: 'memes' }),
  })
  expect(badShelf.status).toBe(400)
}, 60_000)

it('keeps a listing across a restart', async () => {
  const { canvas } = await canvasWithFrame(author, 'Durable')
  await author.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ description: 'Survives reboots.', category: 'dashboard' }),
  })
  await visitor.post(`/api/community/${canvas.id}/copy`)

  const dataDir = server.dataDir
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, dataDir)

  const back = new Client(server)
  await back.post('/api/auth/sign-in/email', { email: 'visitor@test.dev', password: 'password12345' })
  const listing = await (await back.get('/api/community')).json()
  expect(listing).toMatchObject([
    { id: canvas.id, description: 'Survives reboots.', category: 'dashboard', copyCount: 1 },
  ])
}, 60_000)
