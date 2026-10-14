import { beforeEach, expect, it, vi } from 'vitest'
const post = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/api', () => ({
  api: { remoteClaudeAuth: post },
  ApiError: class extends Error {
    body: Record<string, unknown>
    constructor(_status: number, text: string) {
      super(`${_status} ${text}`)
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

it('cancels a late-created login if the component was disposed while starting', async () => {
  let resolve!: (value: unknown) => void
  post
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    .mockResolvedValueOnce({ cancelled: true })
  const connected = vi.fn()
  const login = new RemoteClaudeLogin('alice', 'default', () => {}, connected)
  const starting = login.start()
  login.dispose()
  const attemptId = 'lgn_' + '1'.repeat(32)
  resolve({ attemptId, url: 'https://claude.ai/login' })
  await starting
  expect(post).toHaveBeenLastCalledWith('alice', 'cancel', { attemptId })
  expect(connected).not.toHaveBeenCalled()
})

it('applies a sign-in the server confirmed even if the login was cancelled meanwhile', async () => {
  const attemptId = 'lgn_' + '1'.repeat(32)
  let resolve!: (value: unknown) => void
  post
    .mockResolvedValueOnce({ attemptId, url: 'https://claude.ai/login' })
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    .mockResolvedValueOnce({ cancelled: true })
  const connected = vi.fn()
  const login = new RemoteClaudeLogin('alice', 'claude-sonnet-5', () => {}, connected)
  await login.start()
  const sending = login.send('code')
  await login.cancel()
  resolve({ authenticated: true, preference })
  await sending
  expect(connected).toHaveBeenCalledWith(preference)
})

it('shows a readable failure and stops preparing when sign-in cannot start', async () => {
  const update = vi.fn()
  post.mockRejectedValueOnce(new ApiError(502, JSON.stringify({ error: 'Hosted Claude is unavailable.' })))
  const login = new RemoteClaudeLogin('alice', 'default', update, vi.fn())
  await login.start()
  expect(update).toHaveBeenLastCalledWith({
    status: 'Hosted Claude is unavailable.',
    url: undefined,
    ready: false,
    active: false,
  })
})

it('clears an unusable sign-in link when code confirmation fails', async () => {
  const update = vi.fn()
  post
    .mockResolvedValueOnce({ attemptId: 'attempt', url: 'https://claude.ai/login' })
    .mockRejectedValueOnce(new ApiError(502, JSON.stringify({ error: 'Hosted Claude is unavailable.' })))
  const login = new RemoteClaudeLogin('alice', 'default', update, vi.fn())
  await login.start()
  await login.send('code')
  expect(update).toHaveBeenLastCalledWith({
    status: 'Hosted Claude is unavailable.',
    url: undefined,
    ready: false,
    active: false,
  })
})
