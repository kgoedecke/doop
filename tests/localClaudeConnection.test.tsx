// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), select: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({ api: {} }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => true }))
vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: () => ({
    preference: { enabled: false, model: 'claude-opus-5' },
    native: { installed: true, connected: true, enabled: false },
  }),
  hasLocalClaude: () => true,
  canInstallClaude: () => true,
  refreshLocalAgent: mocks.refresh,
  selectLocalAgent: mocks.select,
  disconnectLocalAgent: vi.fn(),
  invokeClaude: vi.fn(),
}))
import { LocalClaudeRow } from '../src/components/LocalClaude'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
beforeEach(async () => {
  vi.resetAllMocks()
  mocks.refresh.mockResolvedValue({ native: { installed: true, connected: true } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<LocalClaudeRow />))
  mocks.refresh.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
it('hides Refresh on a healthy disconnected row and rechecks status before selecting Claude', async () => {
  expect(button('Refresh')).toBeUndefined()
  mocks.refresh.mockImplementation(async () => {
    expect(mocks.select).not.toHaveBeenCalled()
    return { native: { installed: true, connected: true } }
  })
  await act(async () => button('Use instead')!.click())
  expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith('alice')
  expect(mocks.select).toHaveBeenCalledExactlyOnceWith('alice', { enabled: true, model: 'claude-opus-5' })
})
it.each([
  [{ installed: false, connected: false }, 'Install Claude Code to connect.'],
  [{ installed: true, connected: false }, 'Sign in to Claude Code to connect.'],
])('does not activate stale CLI credentials and offers recovery', async (native, message) => {
  mocks.refresh.mockResolvedValueOnce({ native })
  await act(async () => button('Use instead')!.click())
  expect(mocks.select).not.toHaveBeenCalled()
  expect(container.textContent).toContain(message)
  expect(button('Refresh')).toBeDefined()
  await act(async () => button('Refresh')!.click())
  expect(button('Refresh')).toBeUndefined()
})
