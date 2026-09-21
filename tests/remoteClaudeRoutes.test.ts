import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  disable: vi.fn(),
  preference: vi.fn(),
  clearAuth: vi.fn(),
  beginAuth: vi.fn(),
  login: vi.fn(),
  fetch: vi.fn(),
  check: vi.fn(),
  identity: vi.fn(),
  save: vi.fn(),
  cancel: vi.fn(),
  wake: vi.fn(),
  banned: false,
  impersonated: false,
}))
vi.mock('../server/remoteClaudeClient.ts', () => ({
  remotePost: mocks.post,
  remoteFetch: mocks.fetch,
  checkRemoteAuth: mocks.check,
  checkRemoteLogin: mocks.login,
  remoteIdentity: mocks.identity,
  remoteClaudeConfigured: () => true,
}))
vi.mock('../server/auth.ts', () => ({ PUBLIC_ORIGIN: 'https://doop.example', isBanned: async () => mocks.banned }))
vi.mock('../server/localAgentRuns.ts', () => ({ localAgentRuns: { cancel: mocks.cancel, runningRemote: () => false } }))
vi.mock('../server/localAgentPreferences.ts', () => ({
  getLocalAgentPreference: mocks.preference,
  disableRemoteExecution: mocks.disable,
  clearRemoteAuth: mocks.clearAuth,
  beginRemoteReauth: mocks.beginAuth,
  saveLocalAgentPreference: mocks.save,
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: mocks.wake }))
vi.mock('../server/store.ts', () => ({ store: { canvases: new Map([['canvas', { id: 'canvas' }]]) } }))
vi.mock('../server/access.ts', () => ({ canAccessCanvas: () => true }))
import { remoteClaudeRouter } from '../server/remoteClaude.ts'
let server: Server
let origin: string
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'alice', name: 'Alice', email: 'alice@example.com' }
    req.impersonatedBy = mocks.impersonated ? 'admin' : undefined
    next()
  })
  app.use(remoteClaudeRouter)
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
  mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
  mocks.banned = false
  mocks.impersonated = false
  mocks.post.mockResolvedValue({ sessionId: 'alice:auth' })
  mocks.identity.mockReturnValue('alice')
  mocks.check.mockResolvedValue(true)
})
const post = (path: string, body: unknown, headers = {}) =>
  fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Doop-User': 'alice', ...headers },
    body: JSON.stringify(body),
  })
it('rejects plaintext credentials, private keys, and caller-selected sessions', async () => {
  for (const body of [
    { claudeToken: 'secret' },
    { attemptId: crypto.randomUUID(), publicKey: { d: 'private' } },
    { sessionId: 'bob:auth' },
  ])
    expect((await post('/auth/start', body)).status).toBe(400)
  expect((await post('/auth/input', { code: 'plaintext' })).status).toBe(400)
  expect(mocks.post).not.toHaveBeenCalled()
  expect((await post('/auth/start', {})).status).toBe(202)
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith('alice', '/v1/auth', {})
})
it('requires fresh native authentication before enabling the requester', async () => {
  mocks.check.mockResolvedValueOnce(false)
  expect((await post('/select', { model: 'claude-sonnet-5' })).status).toBe(409)
  expect(mocks.save).not.toHaveBeenCalled()
  expect((await post('/select', { model: 'claude-sonnet-5' })).status).toBe(200)
  expect(mocks.save).toHaveBeenCalledWith('alice', { enabled: true, transport: 'remote', model: 'claude-sonnet-5' })
  expect(mocks.wake).toHaveBeenCalledWith('canvas')
})
it('blocks cross-origin writes, bans, and impersonation before using hosted identity', async () => {
  expect((await post('/auth/start', {}, { Origin: 'https://evil.example' })).status).toBe(403)
  mocks.banned = true
  expect((await post('/auth/start', {})).status).toBe(403)
  mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
  mocks.banned = false
  mocks.impersonated = true
  expect((await fetch(origin + '/events', { headers: { 'X-Doop-User': 'alice' } })).status).toBe(403)
  expect(mocks.post).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
})
it('always streams only the caller auth session and forwards the replay cursor', async () => {
  mocks.fetch.mockResolvedValue(new Response('data: {"type":"auth.status","authenticated":false}\n\n'))
  const response = await fetch(origin + '/events?sessionId=bob:agent', {
    headers: { 'Last-Event-ID': 'stream:4', 'X-Doop-User': 'alice' },
  })
  expect(response.status).toBe(200)
  await response.text()
  expect(mocks.fetch).toHaveBeenCalledWith(
    'alice',
    '/v1/events?sessionId=alice%3Aauth',
    expect.objectContaining({ headers: { 'Last-Event-ID': 'stream:4' } }),
  )
})

it('rejects an old tab after the browser changes Doop accounts', async () => {
  expect((await post('/auth/start', {}, { 'X-Doop-User': 'bob' })).status).toBe(409)
  expect(mocks.post).not.toHaveBeenCalled()
})

it('requires verified fresh login completion before clearing a blocked account', async () => {
  const attemptId = crypto.randomUUID()
  mocks.preference.mockResolvedValue({
    transport: 'remote',
    enabled: true,
    remoteAuthRequired: true,
    remoteAuthAttempt: attemptId,
  })
  expect((await post('/select', { model: 'claude-sonnet-5' })).status).toBe(409)
  expect(mocks.clearAuth).not.toHaveBeenCalled()
  mocks.login.mockResolvedValue(false)
  expect((await post('/select', { model: 'claude-sonnet-5', loginAttemptId: attemptId })).status).toBe(409)
  mocks.login.mockResolvedValue(true)
  expect((await post('/select', { model: 'claude-sonnet-5', loginAttemptId: attemptId })).status).toBe(200)
  expect(mocks.clearAuth).toHaveBeenCalledWith('alice', 0, attemptId)
  expect(mocks.wake).toHaveBeenCalledWith('canvas')
})

it('forces a native re-login for a paused account and records its attempt', async () => {
  const attemptId = crypto.randomUUID()
  mocks.preference.mockResolvedValue({ remoteAuthRequired: true })
  const publicKey = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }
  expect((await post('/auth/start', { attemptId, publicKey })).status).toBe(202)
  expect(mocks.beginAuth).toHaveBeenCalledWith('alice', attemptId)
  expect(mocks.post).toHaveBeenCalledWith('alice', '/v1/auth', { attemptId, publicKey, force: true })
})

it('disables and stops hosted tasks before confirming native sign-out', async () => {
  mocks.post.mockResolvedValueOnce({ sessionId: 'alice:auth', type: 'auth.status', authenticated: false })
  expect((await post('/disable', {})).status).toBe(200)
  expect(mocks.disable).toHaveBeenCalledWith('alice')
  expect(mocks.cancel).toHaveBeenCalledWith('alice', 'remote')
  expect(mocks.post).toHaveBeenCalledWith('alice', '/v1/auth/logout', {})
  expect(mocks.disable.mock.invocationCallOrder[0]).toBeLessThan(mocks.cancel.mock.invocationCallOrder[0]!)
  expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.post.mock.invocationCallOrder[0]!)
})
it('does not claim successful logout when the API fails or still reports signed in', async () => {
  for (const result of [
    { sessionId: 'alice:auth' },
    { sessionId: 'alice:auth', type: 'auth.status', authenticated: true },
  ]) {
    mocks.post.mockResolvedValueOnce(result)
    const response = await post('/disable', {})
    expect(response.status).toBe(502)
    expect((await response.json()).error).toContain('sign-out could not be confirmed')
  }
  mocks.post.mockRejectedValueOnce(new Error('timeout'))
  expect((await post('/disable', {})).status).toBe(502)
  expect(mocks.disable).toHaveBeenCalledTimes(3)
})
