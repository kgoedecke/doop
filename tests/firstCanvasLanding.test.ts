import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { FIRST_CANVAS_PATH, firstCanvasPathAfterSignup } from '../shared/firstCanvas.ts'

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

  /* the lifecycle emails link to /api/welcome?connect=1: the Connect AI
     intent must survive a sign-in, and reach the canvas as ?connect=1 */
  it('keeps ?connect=1 through the login page when signed out', async () => {
    const res = await new Client(server).get(`${FIRST_CANVAS_PATH}?connect=1`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/?redirect_to=${encodeURIComponent(`${FIRST_CANVAS_PATH}?connect=1`)}`)
  })

  it('passes ?connect=1 on to the first canvas when signed in', async () => {
    const client = await new Client(server).signUp('connect-flag@example.com', 'Flagged')
    const res = await client.get(`${FIRST_CANVAS_PATH}?connect=1`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^\/c\/[^/?]+\?connect=1$/)
  })

  /* a provider signup lands here as its newUserCallbackURL with the method
     attached; the app reports the signup from the canvas it ends up on */
  it('passes a provider signup method on to the first canvas', async () => {
    const client = await new Client(server).signUp('google-signup@example.com', 'Googler')
    const res = await client.get(`${firstCanvasPathAfterSignup('google')}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^\/c\/[^/?]+\?signup=google$/)
  })

  it('drops a signup method it does not know', async () => {
    const client = await new Client(server).signUp('odd-signup@example.com', 'Odd')
    const res = await client.get(`${FIRST_CANVAS_PATH}?signup=<script>&connect=1`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^\/c\/[^/?]+\?connect=1$/)
  })
})
