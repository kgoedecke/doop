import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'
import type express from 'express'
import { emptyBodyByDefault, INTERNAL_ERROR } from '../server/http.ts'

/* The real server's HTTP edge on Express 5: what a request that fails, or one that Express 5 reads
   differently from Express 4, is answered. */

describe('the HTTP edge, on the real server', () => {
  let server: Server
  let owner: Client

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('owner@http-edge.test', 'Owner')
  }, 60_000)

  afterAll(() => server?.stop())

  /* POST /api/agent-keys awaits a database insert with no catch of its own, and Postgres refuses
     text holding a NUL byte, so a key named with one makes the handler reject. Express 4 dropped
     that rejection and the request hung until the client gave up. Should the route come to refuse
     such a name itself, point this at another handler that rejects. */
  it('answers a handler that rejects with a JSON 500, not the database error', async () => {
    const res = await owner.req('/api/agent-keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'nul\u0000byte' }),
      signal: AbortSignal.timeout(5_000),
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: INTERNAL_ERROR })
  })

  it('still answers the same route when it succeeds', async () => {
    const res = await owner.post('/api/agent-keys', { name: 'Fine' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }).name).toBe('Fine')
  })

  it('answers malformed JSON and a body over the limit as JSON 400 and 413', async () => {
    const malformed = await owner.req('/api/agent-keys', { method: 'POST', body: '{"name":' })
    expect(malformed.status).toBe(400)
    expect(malformed.headers.get('content-type')).toMatch(/application\/json/)
    const tooLarge = await owner.post('/api/agent-keys', { name: 'x'.repeat(11 * 1024 * 1024) })
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toEqual({ error: 'request entity too large' })
  })

  it('answers a route parameter that does not decode as a JSON 400', async () => {
    const res = await owner.get('/api/canvases/%E0%A4%A')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Bad request' })
  })

  it('serves better-auth under its named wildcard route', async () => {
    const res = await owner.get('/api/auth/get-session')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe('owner@http-edge.test')
  })
})

/* A request with no JSON body (no body and no content type, as `curl -X PUT` sends): body-parser 2
   leaves `req.body` undefined where Express 4's left `{}`, and routes read the body as `{}`. */
describe('a request sent without a JSON body', () => {
  it('reads as an empty one, as Express 4 did', () => {
    const req = {} as express.Request
    let passed = false
    emptyBodyByDefault(req, {} as express.Response, () => (passed = true))
    expect(req.body).toEqual({})
    expect(passed).toBe(true)
  })

  it('keeps a body a parser read', () => {
    const req = { body: { name: 'kept' } } as express.Request
    emptyBodyByDefault(req, {} as express.Response, () => {})
    expect(req.body).toEqual({ name: 'kept' })
  })
})
