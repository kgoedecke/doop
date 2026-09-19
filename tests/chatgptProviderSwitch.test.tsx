// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  account: vi.fn(),
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
    modelAccount: mocks.account,
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
let root: Root
let container: HTMLDivElement
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1500)
  })
const connected = { connected: true, kind: 'chatgpt', models: [] }
beforeEach(async () => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.spyOn(window, 'open').mockReturnValue(null)
  mocks.account.mockResolvedValue({ connected: true, kind: 'openai-key', models: [] })
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
it('keeps Claude selected when device sign-in is started, polled with an existing key, and cancelled', async () => {
  await act(async () => button('Use instead').click())
  await tick()
  expect(mocks.selectLocal).not.toHaveBeenCalled()
  await act(async () => button('Cancel').click())
  mocks.account.mockResolvedValue(connected)
  await tick()
  expect(mocks.cancel).toHaveBeenCalledOnce()
  expect(mocks.selectLocal).not.toHaveBeenCalled()
})
it('keeps Claude selected when authorization cannot start', async () => {
  mocks.authorize.mockRejectedValue(new Error('Sign-in unavailable'))
  await act(async () => button('Use instead').click())
  expect(container.textContent).toContain('Sign-in unavailable')
  expect(mocks.selectLocal).not.toHaveBeenCalled()
})
it('keeps Claude selected when device authorization expires', async () => {
  await act(async () => button('Use instead').click())
  mocks.status.mockResolvedValue({ status: 'error', userCode: 'TEST', error: 'Code expired' })
  await tick()
  expect(container.textContent).toContain('Code expired')
  expect(mocks.selectLocal).not.toHaveBeenCalled()
})
it.each([false, true])('switches only after successful authorization (loopback=%s)', async (catching) => {
  mocks.authorize.mockResolvedValue({ url: 'https://example.test/authorize', catching })
  await act(async () => button('Use instead').click())
  await tick()
  expect(mocks.selectLocal).not.toHaveBeenCalled()
  mocks.account.mockResolvedValue(connected)
  await tick()
  expect(mocks.selectLocal).toHaveBeenCalledExactlyOnceWith('alice', { enabled: false, model: 'claude-opus-5' })
})
it('keeps Claude on failed pasted redirects and switches after a successful retry', async () => {
  mocks.authorize.mockResolvedValue({ url: 'https://example.test/authorize', catching: true })
  await act(async () => button('Use instead').click())
  await act(async () => button('Paste the redirect URL instead').click())
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'http://localhost:1455/auth/callback?code=test',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  mocks.connect.mockRejectedValueOnce(new Error('Invalid code'))
  await act(async () => button('Finish connecting').click())
  expect(container.textContent).toContain('Invalid code')
  expect(mocks.selectLocal).not.toHaveBeenCalled()
  mocks.connect.mockImplementation(async () => {
    expect(mocks.selectLocal).not.toHaveBeenCalled()
    return connected
  })
  await act(async () => button('Finish connecting').click())
  expect(mocks.selectLocal).toHaveBeenCalledExactlyOnceWith('alice', { enabled: false, model: 'claude-opus-5' })
})

it('ignores an in-flight status response after cancelling device sign-in', async () => {
  await act(async () => button('Use instead').click())
  let resolveStatus!: (value: typeof connected) => void
  mocks.account.mockReturnValue(
    new Promise((resolve) => {
      resolveStatus = resolve
    }),
  )
  await tick()
  await act(async () => button('Cancel').click())
  await act(async () => resolveStatus(connected))
  expect(mocks.selectLocal).not.toHaveBeenCalled()
})

it.each([false, true])('shows a retryable switch failure after authorization (loopback=%s)', async (catching) => {
  mocks.authorize.mockResolvedValue({ url: 'https://example.test/authorize', catching })
  await act(async () => button('Use instead').click())
  mocks.account.mockResolvedValue(connected)
  mocks.selectLocal.mockRejectedValueOnce(new Error('Preference request failed'))
  await tick()
  expect(container.textContent).toContain('ChatGPT connected, but switching providers failed')
  expect(container.textContent).not.toContain('Waiting for approval')
  expect(button('Retry switch')).toBeDefined()
  await tick()
  expect(mocks.selectLocal).toHaveBeenCalledTimes(1)
  await act(async () => button('Retry switch').click())
  expect(mocks.selectLocal).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain('switching providers failed')
  expect(mocks.authorize).toHaveBeenCalledTimes(1)
  expect(mocks.connect).not.toHaveBeenCalled()
})

it('retries only the switch after a successful pasted-code exchange', async () => {
  mocks.authorize.mockResolvedValue({ url: 'https://example.test/authorize', catching: true })
  await act(async () => button('Use instead').click())
  await act(async () => button('Paste the redirect URL instead').click())
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'http://localhost:1455/auth/callback?code=test',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  mocks.connect.mockResolvedValue(connected)
  mocks.selectLocal.mockRejectedValueOnce(new Error('Preference request failed'))
  await act(async () => button('Finish connecting').click())
  expect(button('Retry switch')).toBeDefined()
  expect(button('Finish connecting')).toBeUndefined()
  await act(async () => button('Retry switch').click())
  expect(mocks.connect).toHaveBeenCalledTimes(1)
  expect(mocks.selectLocal).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain('switching providers failed')
})
