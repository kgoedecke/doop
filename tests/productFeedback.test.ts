import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MAX_PRODUCT_FEEDBACK_CHARS, parseProductFeedback } from '../shared/productFeedback'

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn<(mail: object) => Promise<void>>(),
  capture: vi.fn(),
  env: { FEEDBACK_EMAIL: 'team@doop.example.com' as string | undefined },
}))
vi.mock('../server/mailer.ts', () => ({ sendMail: mocks.sendMail }))
vi.mock('../server/analytics.ts', () => ({ capture: mocks.capture }))
vi.mock('../server/env.ts', () => ({ env: mocks.env }))
import { productFeedbackEmail, productFeedbackRouter } from '../server/productFeedback.ts'

describe('parseProductFeedback', () => {
  it('trims the message and keeps the page', () => {
    expect(parseProductFeedback({ message: '  love it \n', page: '/c/abc' })).toEqual({
      message: 'love it',
      page: '/c/abc',
    })
  })

  it('refuses an empty, overlong or non-text message', () => {
    expect(parseProductFeedback({ message: '   ' })).toBeNull()
    expect(parseProductFeedback({ message: 'x'.repeat(MAX_PRODUCT_FEEDBACK_CHARS + 1) })).toBeNull()
    expect(parseProductFeedback({ message: 42 })).toBeNull()
    expect(parseProductFeedback(null)).toBeNull()
  })
})

describe('productFeedbackEmail', () => {
  it('replies to the sender and keeps a chosen name on one subject line', () => {
    const mail = productFeedbackEmail(
      { name: 'Alice\r\nBcc: someone@else.example', email: 'alice@example.com' },
      { message: 'More fonts please', page: '/c/abc' },
      'team@doop.example.com',
    )
    expect(mail.to).toBe('team@doop.example.com')
    expect(mail.replyTo).toBe('alice@example.com')
    expect(mail.subject).not.toMatch(/[\r\n]/)
    expect(mail.text).toContain('More fonts please')
    expect(mail.text).toContain('Page: /c/abc')
  })
})

describe('POST /api/product-feedback', () => {
  let server: Server
  let origin: string
  let userId = 'alice'
  const post = (body: unknown) =>
    fetch(origin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = { id: userId, name: 'Alice', email: `${userId}@example.com` } as typeof req.user
      next()
    })
    app.use('/api/product-feedback', productFeedbackRouter)
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/product-feedback`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendMail.mockResolvedValue()
    mocks.env.FEEDBACK_EMAIL = 'team@doop.example.com'
  })

  it('emails the note to the configured address', async () => {
    userId = 'alice'
    const res = await post({ message: 'The pen tool is great', page: '/c/abc' })
    expect(res.status).toBe(200)
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'team@doop.example.com', replyTo: 'alice@example.com' }),
    )
  })

  it('refuses an empty note without sending', async () => {
    userId = 'bob'
    expect((await post({ message: ' ' })).status).toBe(400)
    expect(mocks.sendMail).not.toHaveBeenCalled()
  })

  it('is off when no address is set', async () => {
    userId = 'carol'
    mocks.env.FEEDBACK_EMAIL = undefined
    expect((await post({ message: 'hello' })).status).toBe(404)
    expect(mocks.sendMail).not.toHaveBeenCalled()
  })

  it('stops one account after five notes in an hour', async () => {
    userId = 'dave'
    for (let i = 0; i < 5; i++) expect((await post({ message: `note ${i}` })).status).toBe(200)
    expect((await post({ message: 'one more' })).status).toBe(429)
    expect(mocks.sendMail).toHaveBeenCalledTimes(5)
  })
})
