// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  refresh: vi.fn(),
  canInstall: true,
  native: { installed: false, connected: false, enabled: false },
}))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'tester' } } }) } }))
vi.mock('../src/lib/api', () => ({ api: {} }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => true }))
vi.mock('../src/lib/localAgent', () => ({
  hasLocalClaude: () => true,
  canInstallClaude: () => mocks.canInstall,
  invokeClaude: mocks.invoke,
  refreshLocalAgent: mocks.refresh,
  disconnectLocalAgent: vi.fn(),
  selectLocalAgent: vi.fn(),
  useLocalAgent: () => ({ preference: null, native: mocks.native, running: false, progress: '', error: '' }),
}))
import { LocalClaudeRow } from '../src/components/LocalClaude'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.canInstall = true
  mocks.native = { installed: false, connected: false, enabled: false }
  mocks.refresh.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<LocalClaudeRow />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows progress, prevents duplicate clicks, and refreshes into sign-in after installation', async () => {
  let finish!: () => void
  mocks.invoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => button('Install Claude Code')!.click())
  expect(button('Installing…')?.disabled).toBe(true)
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('claude_install')
  mocks.native.installed = true
  await act(async () => finish())
  expect(mocks.refresh).toHaveBeenLastCalledWith('tester')
  expect(button('Sign in')).toBeDefined()
  expect(button('Install Claude Code')).toBeUndefined()
})

it('shows installer errors and allows retry', async () => {
  mocks.invoke.mockRejectedValue(new Error('Installation failed'))
  await act(async () => button('Install Claude Code')!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Installation failed')
  expect(button('Install Claude Code')?.disabled).toBe(false)
})

it('keeps the guide fallback for older shells', async () => {
  mocks.canInstall = false
  await act(async () => root.render(<LocalClaudeRow />))
  expect(button('Install Claude Code')).toBeUndefined()
  expect(container.querySelector('a')?.textContent).toBe('Installation guide')
})
