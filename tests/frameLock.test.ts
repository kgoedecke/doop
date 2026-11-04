import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = new Client(server)
  await owner.signUp('lock@test.dev', 'Lock Owner')
}, 60_000)

afterAll(() => server?.stop())

it('locks and unlocks a frame through the frame update API', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Locks' })).json()
  const frame: Frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero' })).json()
  expect(frame.locked).toBeUndefined()

  const locked = await owner.patch(`/api/frames/${frame.id}`, { locked: true })
  expect(locked.status).toBe(200)
  expect(((await locked.json()) as Frame).locked).toBe(true)

  /* the lock is part of the frame everyone loads, not a client-side flag */
  const loaded: Canvas = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  expect(loaded.frames.find((f) => f.id === frame.id)?.locked).toBe(true)

  /* a lock travels alongside other metadata, and other fields still land */
  const moved: Frame = await (await owner.patch(`/api/frames/${frame.id}`, { x: 40, name: 'Hero v2' })).json()
  expect(moved).toMatchObject({ x: 40, name: 'Hero v2', locked: true })

  const unlocked: Frame = await (await owner.patch(`/api/frames/${frame.id}`, { locked: false })).json()
  expect(unlocked.locked).toBe(false)
})

it('keeps the lock across a server restart', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Durable locks' })).json()
  const frame: Frame = await (await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Kept' })).json()
  expect((await owner.patch(`/api/frames/${frame.id}`, { locked: true })).status).toBe(200)

  const dataDir = server.dataDir
  await server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, dataDir)

  const again = new Client(server)
  expect(
    (await again.post('/api/auth/sign-in/email', { email: 'lock@test.dev', password: 'password12345' })).status,
  ).toBe(200)
  const loaded: Canvas = await (await again.get(`/api/canvases/${canvas.id}`)).json()
  expect(loaded.frames.find((f) => f.id === frame.id)?.locked).toBe(true)
}, 60_000)
