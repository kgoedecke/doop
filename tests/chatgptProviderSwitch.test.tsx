// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  authorize: vi.fn(),
  device: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  connect: vi.fn(),
  selectLocal: vi.fn(),
}))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({
  api: {
    modelAccounts: mocks.accounts,
    agentModels: async () => ({ models: [], live: false }),
    chatgptAuthorize: mocks.authorize,
    startDeviceAuth: mocks.device,
    deviceAuthStatus: mocks.status,
    cancelDeviceAuth: mocks.cancel,
    connectChatgpt: mocks.connect,
  },
}))
vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: () => ({ enabled: true, model: 'claude-opus-5' }),
  selectLocalAgent: mocks.selectLocal,
}))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => ({ allowanceChanged: vi.fn() }) } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/LocalClaude', () => ({ LocalClaudeRow: () => null }))
import { ModelAccountPanel } from '../src/components/ModelAccount'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* An OpenAI key is already connected and the Claude Plan is the default: a
   ChatGPT sign-in adds a connection beside them and switches nothing off. */
const view = (accounts: { kind: string; enabled: boolean; plan?: string }[]) => ({
  accounts: accounts.map((a) => ({ connectedAt: 1, ...a })),
  default: 'claude-local',
  chatgptEnabled: true,
  menus: { chatgpt: [], 'openai-key': [], 'anthropic-key': [], 'openrouter-key': [], 'gemini-key': [] },
})
const keyOnly = view([{ kind: 'openai-key', enabled: true }])
const withChatgpt = view([
  { kind: 'openai-key', enabled: true },
  { kind: 'chatgpt', enabled: true, plan: 'pro' },
])

let root: Root
let container: HTMLDivElement
/* the ChatGPT row comes first, so its Connect is the first one */
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1500)
  })
beforeEach(async () => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.spyOn(window, 'open').mockReturnValue(null)
  mocks.accounts.mockResolvedValue(keyOnly)
  mocks.authorize.mockResolvedValue({ url: 'https://example.test/authorize', catching: false })
  mocks.device.mockResolvedValue({
    status: 'pending',
    userCode: 'TEST',
    verificationUrl: 'https://example.test/device',
  })
  mocks.status.mockResolvedValue({ status: 'pending', userCode: 'TEST' })
  mocks.cancel.mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<ModelAccountPanel />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('offers Connect on every unconnected row, and no Use instead anywhere', () => {
  expect(button('Connect')).toBeDefined()
  expect(button('Use instead')).toBeUndefined()
  /* the connected key row: its switch and the "…" menu */
  const keyRow = Array.from(container.querySelectorAll('[role="listitem"]')).find((r) =>
    r.textContent?.includes('OpenAI API key'),
  )!
  expect(keyRow.querySelector('[role="switch"][aria-label="Use OpenAI API key"]')?.getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(keyRow.querySelector('[aria-label="More for OpenAI API key"]')).not.toBeNull()
})

it('stops polling when device sign-in is cancelled', async () => {
  await act(async () => button('Connect')!.click())
  await tick()
  await act(async () => button('Cancel')!.click())
  mocks.accounts.mockResolvedValue(withChatgpt)
  await tick()
  expect(mocks.cancel).toHaveBeenCalledOnce()
  expect(container.textContent).not.toContain('Your ChatGPT subscription · Pro')
})

it('says why when authorization cannot start', async () => {
  mocks.authorize.mockRejectedValue(new Error('Sign-in unavailable'))
  await act(async () => button('Connect')!.click())
  expect(container.textContent).toContain('Sign-in unavailable')
})

it('says why when device authorization expires', async () => {
  await act(async () => button('Connect')!.click())
  mocks.status.mockResolvedValue({ status: 'error', userCode: 'TEST', error: 'Code expired' })
  await tick()
  expect(container.textContent).toContain('Code expired')
})

it.each([false, true])('adds ChatGPT beside the others once authorized (loopback=%s)', async (catching) => {
  mocks.authorize.mockResolvedValue({ url: 'https://example.test/authorize', catching })
  await act(async () => button('Connect')!.click())
  await tick()
  /* the existing key alone is not evidence that this sign-in finished */
  expect(container.textContent).not.toContain('Your ChatGPT subscription · Pro')
  mocks.accounts.mockResolvedValue(withChatgpt)
  await tick()
  expect(container.textContent).toContain('Your ChatGPT subscription · Pro')
  expect(container.querySelectorAll('[role="switch"][aria-checked="true"]')).toHaveLength(2)
  /* the Plan stays on: connecting never switches another connection off */
  expect(mocks.selectLocal).not.toHaveBeenCalled()
})

it('shows a failed pasted redirect and connects after a successful retry', async () => {
  mocks.authorize.mockResolvedValue({ url: 'https://example.test/authorize', catching: true })
  await act(async () => button('Connect')!.click())
  await act(async () => button('Paste the redirect URL instead')!.click())
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'http://localhost:1455/auth/callback?code=test',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  mocks.connect.mockRejectedValueOnce(new Error('Invalid code'))
  await act(async () => button('Finish connecting')!.click())
  expect(container.textContent).toContain('Invalid code')
  mocks.connect.mockResolvedValue(withChatgpt)
  await act(async () => button('Finish connecting')!.click())
  expect(mocks.connect).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('Your ChatGPT subscription · Pro')
  expect(button('Finish connecting')).toBeUndefined()
  expect(mocks.selectLocal).not.toHaveBeenCalled()
})
