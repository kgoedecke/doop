// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ status: vi.fn(), check: vi.fn(), select: vi.fn(), changed: vi.fn() }))
const loginMocks = vi.hoisted(() => ({
  text: '',
  send: vi.fn(),
  update: undefined as undefined | ((view: { text: string; status: string; ready: boolean; active: boolean }) => void),
}))
vi.mock('../src/lib/remoteClaudeLogin', async (original) => {
  const actual = await original<typeof import('../src/lib/remoteClaudeLogin')>()
  return {
    ...actual,
    RemoteClaudeLogin: class {
      constructor(_user: string, update: typeof loginMocks.update) {
        loginMocks.update = update
      }
      async start() {
        loginMocks.update?.({
          text: loginMocks.text,
          status: 'Sign in to Claude in a new tab, then return here.',
          ready: true,
          active: true,
        })
      }
      async send(value: string) {
        loginMocks.send(value)
        loginMocks.update?.({ text: loginMocks.text, status: 'Verifying sign-in…', ready: false, active: true })
      }
      dispose() {}
      async cancel() {}
    },
  }
})
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({
  api: { remoteClaude: mocks.status, checkRemoteClaude: mocks.check, selectRemoteClaude: mocks.select },
  ApiError: class extends Error {
    body: Record<string, unknown>
    constructor(status: number, text: string) {
      super(`${status} ${text}`)
      this.body = JSON.parse(text)
    }
  },
}))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => ({ allowanceChanged: mocks.changed }) } }))
import { ApiError } from '../src/lib/api'
import { RemoteClaudeRow } from '../src/components/RemoteClaude'
import { useLocalAgent } from '../src/lib/localAgent'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  mocks.status.mockResolvedValue({ configured: true, running: false })
  useLocalAgent.setState({ preference: { enabled: true, transport: 'local', model: 'claude-sonnet-5' } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const connect = () =>
  Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Connect my account')!
it('selects hosted execution after verifying this user’s native connection', async () => {
  mocks.check.mockResolvedValue({ authenticated: true })
  mocks.select.mockResolvedValue({ enabled: true, transport: 'remote', model: 'claude-sonnet-5' })
  await act(async () => root.render(<RemoteClaudeRow />))
  await act(async () => connect().click())
  expect(mocks.check).toHaveBeenCalledWith('alice')
  expect(mocks.select).toHaveBeenCalledWith('alice', 'claude-sonnet-5', undefined)
  expect(useLocalAgent.getState().preference?.transport).toBe('remote')
  expect(container.textContent).toContain('Disable hosted execution')
})
it('preserves local selection and shows a retryable error when the upstream check fails', async () => {
  mocks.check.mockRejectedValue(new Error('Hosted runtime unavailable'))
  await act(async () => root.render(<RemoteClaudeRow />))
  await act(async () => connect().click())
  expect(mocks.select).not.toHaveBeenCalled()
  expect(useLocalAgent.getState().preference?.transport).toBe('local')
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Hosted runtime unavailable')
  expect(connect().disabled).toBe(false)
})

it('renders the API error message without HTTP status or serialized JSON', async () => {
  mocks.check.mockRejectedValue(
    new ApiError(502, JSON.stringify({ error: 'The hosted Claude workspace did not respond.' })),
  )
  await act(async () => root.render(<RemoteClaudeRow />))
  await act(async () => connect().click())
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The hosted Claude workspace did not respond.')
})

it('shows sign-in required and a reconnect action for a paused hosted account', async () => {
  mocks.status.mockResolvedValue({ configured: true, running: false, authRequired: true })
  useLocalAgent.setState({ preference: { enabled: true, transport: 'remote', model: 'claude-sonnet-5' } })
  await act(async () => root.render(<RemoteClaudeRow />))
  expect(container.textContent).toContain('Sign-in required')
  expect(container.textContent).toContain('Connect Claude to resume hosted tasks')
  expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Reconnect Claude')).toBe(true)
})

it('shows one sign-in action and keeps native output collapsed until needed', async () => {
  mocks.check.mockResolvedValue({ authenticated: false })
  loginMocks.text =
    'Opening browser to sign in…\nhttps://claude.com/oauth/authorize?test=1\nPaste code here if prompted >'
  await act(async () => root.render(<RemoteClaudeRow />))
  await act(async () => connect().click())
  const links = container.querySelectorAll('a')
  expect(links).toHaveLength(1)
  expect(links[0]?.textContent).toContain('Open Claude sign-in')
  expect(links[0]?.target).toBe('_blank')
  expect(container.querySelector('details')?.open).toBe(false)
  expect(container.querySelector('pre')?.closest('details')).not.toBeNull()
  expect(container.querySelector('label[for="hosted-sign-in-code"]')?.textContent).toBe('Code from Claude')
  const complete = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Complete sign-in')!
  expect(complete.disabled).toBe(true)
  const input = container.querySelector<HTMLInputElement>('#hosted-sign-in-code')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'test-code')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => complete.click())
  expect(loginMocks.send).toHaveBeenCalledWith('test-code')
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Verifying sign-in…')
})
it('waits for a code prompt before showing the code field', async () => {
  mocks.check.mockResolvedValue({ authenticated: false })
  loginMocks.text = 'Preparing login'
  await act(async () => root.render(<RemoteClaudeRow />))
  await act(async () => connect().click())
  expect(container.querySelector('#hosted-sign-in-code')).toBeNull()
  expect(container.querySelector('a')).toBeNull()
})
