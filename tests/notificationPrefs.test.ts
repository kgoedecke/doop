import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_id: string) => ({ commentEmails: true })),
  save: vi.fn(async (_id: string, _prefs: { commentEmails: boolean }) => {}),
}))
vi.mock('../server/mailer.ts', () => ({ mailerConfigured: true, sendMail: async () => {} }))
vi.mock('../server/notificationPrefs.ts', () => ({
  getNotificationPrefs: mocks.get,
  saveNotificationPrefs: mocks.save,
}))
import { notificationsRouter } from '../server/notifications.ts'

let server: Server
let origin: string
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'alice' } as typeof req.user
    next()
  })
  app.use(notificationsRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => vi.clearAllMocks())

it('reports the switches with whether email works on this instance', async () => {
  const res = await fetch(origin)
  expect(await res.json()).toEqual({ commentEmails: true, emailConfigured: true })
  expect(mocks.get).toHaveBeenCalledWith('alice')
})

it('saves a switch for the signed-in user', async () => {
  const res = await fetch(origin, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commentEmails: false }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ commentEmails: false, emailConfigured: true })
  expect(mocks.save).toHaveBeenCalledWith('alice', { commentEmails: false })
})

it('rejects anything but a boolean', async () => {
  const res = await fetch(origin, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commentEmails: 'yes' }),
  })
  expect(res.status).toBe(400)
  expect(mocks.save).not.toHaveBeenCalled()
})
