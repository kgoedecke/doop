import express from 'express'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyBodyByDefault, INTERNAL_ERROR, routeErrorAnswer } from '../server/http.ts'

/* An async handler's rejection reaches the error handlers (Express 5 passes it to `next`; Express 4
   dropped it and the request was never answered), and the last one, routeErrorAnswer, answers it
   as JSON. Each request below that rejects would time out on Express 4. */

const ANSWER_WITHIN_MS = 5_000

describe('an async handler that rejects', () => {
  let base = ''
  let close = () => {}

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = express()
    app.use(express.json())
    app.use(emptyBodyByDefault)
    app.get('/rejects', async () => {
      await Promise.resolve()
      throw new Error('relation "secret_table" does not exist')
    })
    app.get('/rejects-with-nothing', () => Promise.reject(undefined))
    app.get('/rejects-with-odd-status', async () => {
      await Promise.resolve()
      throw Object.assign(new Error('odd'), { status: 404.5 })
    })
    app.get('/rejects-with-status', async () => {
      await Promise.resolve()
      throw Object.assign(new Error('not here'), { status: 404, expose: true })
    })
    app.get('/catches-itself', async (_req, res) => {
      try {
        await Promise.reject(new Error('conflict'))
      } catch {
        res.status(409).json({ error: 'its own answer' })
      }
    })
    app.get('/passes-on', async (_req, _res, next) => {
      await Promise.resolve()
      next()
    })
    app.get('/passes-on', (_req, res) => {
      res.json({ ok: true })
    })
    app.get('/sends-then-rejects', async (_req, res) => {
      res.json({ ok: true })
      throw new Error('after the answer')
    })
    app.post('/echo', (req, res) => {
      res.json(req.body)
    })
    app.post('/raw', express.raw({ type: () => true }), (req, res) => {
      res.json({ buffer: Buffer.isBuffer(req.body), text: Buffer.isBuffer(req.body) ? req.body.toString() : null })
    })
    app.use(
      '/mounted',
      async (_req, _res, next) => {
        await Promise.resolve()
        next()
      },
      express.Router().get('/rejects', async () => {
        await Promise.resolve()
        throw new Error('in a router')
      }),
    )
    app.use('/middleware', async () => {
      await Promise.resolve()
      throw new Error('in middleware')
    })
    app.use(routeErrorAnswer)
    const server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () => server.close()
  })

  afterAll(() => {
    close()
    vi.restoreAllMocks()
  })

  const fetchWithin = (path: string, init?: RequestInit) =>
    fetch(base + path, { ...init, signal: AbortSignal.timeout(ANSWER_WITHIN_MS) })

  it('answers a JSON 500 with a generic body, not the error message', async () => {
    const res = await fetchWithin('/rejects')
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ error: INTERNAL_ERROR })
    expect(body).not.toContain('secret_table')
  })

  it('logs what failed for the server, without the query', async () => {
    const logged = vi.mocked(console.error)
    logged.mockClear()
    await fetchWithin('/rejects?code=secret-sign-in-code')
    expect(logged).toHaveBeenCalledWith('[route-error] GET /rejects', expect.any(Error))
    expect(JSON.stringify(logged.mock.calls)).not.toContain('secret-sign-in-code')
  })

  it('answers a promise rejected with nothing', async () => {
    const res = await fetchWithin('/rejects-with-nothing')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: INTERNAL_ERROR })
  })

  it('answers in a router mounted under app.use and in async middleware', async () => {
    for (const path of ['/mounted/rejects', '/middleware']) {
      const res = await fetchWithin(path)
      expect(res.status, path).toBe(500)
      expect(await res.json()).toEqual({ error: INTERNAL_ERROR })
    }
  })

  it('keeps the status an error asks for, and its message when it is safe to show', async () => {
    const res = await fetchWithin('/rejects-with-status')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not here' })
  })

  it("leaves a handler's own catch answering as it did", async () => {
    const res = await fetchWithin('/catches-itself')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'its own answer' })
  })

  it('lets an async handler pass on to the next one', async () => {
    const res = await fetchWithin('/passes-on')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('leaves a response already sent as it was', async () => {
    const res = await fetchWithin('/sends-then-rejects')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect((await fetchWithin('/passes-on')).status).toBe(200)
  })

  it("answers body-parser's refusal of malformed JSON as a JSON 400", async () => {
    const res = await fetchWithin('/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect((await res.json()) as { error: string }).toHaveProperty('error')
  })

  it('reads a request with no JSON body as an empty object, as Express 4 did', async () => {
    const res = await fetchWithin('/echo', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it("leaves a route's own raw parser reading the body after the empty default", async () => {
    const res = await fetchWithin('/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: 'bytes',
    })
    expect(await res.json()).toEqual({ buffer: true, text: 'bytes' })
  })

  it('answers 500 for an error whose status is not an HTTP status', async () => {
    const res = await fetchWithin('/rejects-with-odd-status')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: INTERNAL_ERROR })
  })
})
