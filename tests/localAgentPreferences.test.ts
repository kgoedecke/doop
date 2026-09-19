import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
const mocks = vi.hoisted(() => ({ wake: vi.fn(), online: vi.fn(), poll: vi.fn(), cancel: vi.fn(), save: vi.fn() }))
vi.mock('../server/auth.ts', () => ({ isBanned: async () => false }))
vi.mock('../server/resident.ts', () => ({ onFeedback: mocks.wake }))
vi.mock('../server/access.ts', () => ({ canAccessCanvas: () => true }))
vi.mock('../server/store.ts', () => ({ store: { canvases: new Map([['canvas', { id: 'canvas' }]]) } }))
vi.mock('../server/localAgentPreferences.ts', () => ({
  getLocalAgentPreference: async () => ({ enabled: true, model: 'claude-sonnet-5' }),
  saveLocalAgentPreference: mocks.save,
}))
vi.mock('../server/localAgentRuns.ts', () => ({ localAgentRuns: mocks }))
import { localAgentRouter } from '../server/localAgent.ts'
let server: Server
let origin: string
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'alice' } as typeof req.user
    next()
  })
  app.use(localAgentRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.online.mockReturnValue(true)
  mocks.poll.mockReturnValue(null)
})
const poll = () =>
  fetch(`${origin}/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: '12345678-1234-4234-8234-123456789abc' }),
  })
it('does not sweep canvases on repeated idle polls from online desktops', async () => {
  for (let i = 0; i < 3; i++) expect((await poll()).status).toBe(200)
  expect(mocks.wake).not.toHaveBeenCalled()
})
it('wakes queued work when a desktop comes online', async () => {
  mocks.online.mockReturnValueOnce(false)
  expect((await poll()).status).toBe(200)
  expect(mocks.wake).toHaveBeenCalledExactlyOnceWith('canvas')
  await poll()
  expect(mocks.wake).toHaveBeenCalledOnce()
})

it('preserves an in-flight run when changing the selected model', async () => {
  const response = await fetch(origin, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, model: 'claude-opus-5' }),
  })
  expect(response.status).toBe(200)
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith('alice', { enabled: true, model: 'claude-opus-5' })
  expect(mocks.cancel).not.toHaveBeenCalled()
})
it('cancels an in-flight run when local execution is explicitly disabled', async () => {
  const response = await fetch(origin, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, model: 'claude-opus-5' }),
  })
  expect(response.status).toBe(200)
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('alice')
})
