// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ status: vi.fn(), check: vi.fn(), select: vi.fn(), changed: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({
  api: { remoteClaude: mocks.status, checkRemoteClaude: mocks.check, selectRemoteClaude: mocks.select },
  ApiError: class extends Error {},
}))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => ({ allowanceChanged: mocks.changed }) } }))
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
  expect(mocks.select).toHaveBeenCalledWith('alice', 'claude-sonnet-5')
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
