import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { FIRST_CANVAS_PATH } from '../shared/firstCanvas.ts'

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

describe('first-canvas landing', () => {
  it('sends a fresh signup to the canvas made for it', async () => {
    const client = await new Client(server).signUp('new@example.com', 'Newcomer')
    const canvases: { id: string; name: string }[] = await (await client.get('/api/canvases')).json()
    const first = canvases.find((c) => c.name === "Newcomer's first canvas")
    expect(first).toBeDefined()

    const res = await client.get(FIRST_CANVAS_PATH)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/c/${first!.id}`)
  })

  it('falls back to the dashboard once that canvas is gone', async () => {
    const client = await new Client(server).signUp('tidy@example.com', 'Tidy')
    const canvases: { id: string }[] = await (await client.get('/api/canvases')).json()
    for (const c of canvases) expect((await client.delete(`/api/canvases/${c.id}`)).status).toBe(200)

    const res = await client.get(FIRST_CANVAS_PATH)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('redirects a signed-out browser to the dashboard rather than answering 401', async () => {
    const res = await new Client(server).get(FIRST_CANVAS_PATH)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })
})
