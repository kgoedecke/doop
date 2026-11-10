import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = new Client(server)
  await owner.signUp('turn@test.dev', 'Turn Owner')
}, 60_000)

afterAll(() => server?.stop())

it('turns a frame through the frame update API and straightens it with zero', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Turns' })).json()
  const frame: Frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero' })).json()
  expect(frame.rotation).toBeUndefined()

  const turned = await owner.patch(`/api/frames/${frame.id}`, { rotation: 30 })
  expect(turned.status).toBe(200)
  expect(((await turned.json()) as Frame).rotation).toBe(30)

  /* the turn is part of the frame everyone loads */
  const loaded: Canvas = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(loaded.frames.find((f) => f.id === frame.id)?.rotation).toBe(30)

  /* the box stays the unrotated one, and other fields still land */
  const moved: Frame = await (await owner.patch(`/api/frames/${frame.id}`, { x: 40, width: 300 })).json()
  expect(moved).toMatchObject({ x: 40, width: 300, rotation: 30 })

  /* stored in (-180, 180], so a full turn plus a quarter is a quarter */
  const wrapped: Frame = await (await owner.patch(`/api/frames/${frame.id}`, { rotation: 630 })).json()
  expect(wrapped.rotation).toBe(-90)

  const straight: Frame = await (await owner.patch(`/api/frames/${frame.id}`, { rotation: 0 })).json()
  expect(straight.rotation).toBeUndefined()

  const bad = await owner.patch(`/api/frames/${frame.id}`, { rotation: 'sideways' })
  expect(bad.status).toBe(400)
})

it('creates a frame already turned, and keeps the turn across a restart', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Durable turns' })).json()
  const frame: Frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Tilted', rotation: -12.5 })
  ).json()
  expect(frame.rotation).toBe(-12.5)

  const dataDir = server.dataDir
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, dataDir)

  const again = new Client(server)
  expect(
    (await again.post('/api/auth/sign-in/email', { email: 'turn@test.dev', password: 'password12345' })).status,
  ).toBe(200)
  const loaded: Canvas = await (await again.get(`/api/canvases/${canvas.id}`)).json()
  expect(loaded.frames.find((f) => f.id === frame.id)?.rotation).toBe(-12.5)
}, 60_000)
