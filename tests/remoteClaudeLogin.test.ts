import { beforeEach, expect, it, vi } from 'vitest'
const post = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/api', () => ({
  api: { remoteClaudeAuth: post },
  ApiError: class extends Error {
    body: Record<string, unknown>
    constructor(_status: number, text: string) {
      super(text)
      this.body = JSON.parse(text)
    }
  },
}))
import { ApiError } from '../src/lib/api'
import { RemoteClaudeLogin, anthropicLink, type LoginView } from '../src/lib/remoteClaudeLogin'

const preference = { enabled: true, transport: 'remote' as const, model: 'claude-sonnet-5' }

beforeEach(() => post.mockReset())

it('accepts only an Anthropic HTTPS sign-in link', () => {
  expect(anthropicLink('https://claude.ai/login')).toBe('https://claude.ai/login')
  expect(anthropicLink('https://claude.ai.evil.example/login')).toBeUndefined()
  expect(anthropicLink('http://claude.ai/login')).toBeUndefined()
})

it('starts login, retries a rejected code, and connects after native confirmation', async () => {
  const attemptId = crypto.randomUUID()
  const views: LoginView[] = []
  const connected = vi.fn()
  post
    .mockResolvedValueOnce({ attemptId, url: 'https://claude.ai/login' })
    .mockRejectedValueOnce(new ApiError(422, JSON.stringify({ code: 'code_rejected', error: 'Rejected' })))
    .mockResolvedValueOnce({ authenticated: true, preference })
  const login = new RemoteClaudeLogin('alice', 'claude-sonnet-5', (view) => views.push(view), connected)
  await login.start()
  expect(views.at(-1)).toMatchObject({ url: 'https://claude.ai/login', ready: true })
  await login.send('wrong')
  expect(views.at(-1)).toMatchObject({ ready: true, status: expect.stringContaining('Paste it again') })
  await login.send('right')
  expect(post).toHaveBeenNthCalledWith(1, 'alice', 'start', { model: 'claude-sonnet-5' })
  expect(post).toHaveBeenNthCalledWith(2, 'alice', 'code', { attemptId, code: 'wrong', model: 'claude-sonnet-5' })
  expect(post).toHaveBeenNthCalledWith(3, 'alice', 'code', { attemptId, code: 'right', model: 'claude-sonnet-5' })
  expect(connected).toHaveBeenCalledWith(preference)
})

it('uses an already confirmed sign-in without another status request', async () => {
  const connected = vi.fn()
  post.mockResolvedValueOnce({ authenticated: true, preference })
  const login = new RemoteClaudeLogin('alice', 'claude-sonnet-5', () => {}, connected)
  await login.start()
  expect(post).toHaveBeenCalledExactlyOnceWith('alice', 'start', { model: 'claude-sonnet-5' })
  expect(connected).toHaveBeenCalledWith(preference)
})

it('cancels the active attempt without exposing terminal output', async () => {
  const attemptId = crypto.randomUUID()
  post.mockResolvedValueOnce({ attemptId, url: 'https://claude.ai/login' }).mockResolvedValueOnce({ cancelled: true })
  const login = new RemoteClaudeLogin(
    'alice',
    'claude-sonnet-5',
    () => {},
    () => {},
  )
  await login.start()
  await login.cancel()
  expect(post).toHaveBeenLastCalledWith('alice', 'cancel', { attemptId })
})
