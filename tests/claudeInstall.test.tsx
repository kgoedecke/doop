// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  refresh: vi.fn(),
  canInstall: true,
  canChoose: true,
  native: { installed: false, connected: false, enabled: false } as Record<string, unknown>,
}))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'tester' } } }) } }))
vi.mock('../src/lib/api', () => ({ api: {} }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => true }))
vi.mock('../src/lib/localAgent', () => ({
  hasLocalClaude: () => true,
  canInstallClaude: () => mocks.canInstall,
  canChooseClaude: () => mocks.canChoose,
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
  mocks.canChoose = true
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

const render = async (native: Record<string, unknown>) => {
  mocks.native = native
  await act(async () => root.render(<LocalClaudeRow />))
}
const found = { installed: true, connected: true, enabled: false, cliVersion: '2.1.281' }

it('says which Claude Code runs and lets a person choose another', async () => {
  await render({ ...found, cliPath: '/Users/me/.claude/local/claude', cliSource: 'shell' })
  expect(container.textContent).toContain(
    'Using Claude Code 2.1.281 at /Users/me/.claude/local/claude, the one your terminal runs.',
  )
  expect(button('Use default')).toBeUndefined()
  mocks.invoke.mockResolvedValue(true)
  await act(async () => button('Choose…')!.click())
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('claude_choose_cli')
  expect(mocks.refresh).toHaveBeenLastCalledWith('tester')
})

it('leaves the status alone when the file panel is cancelled', async () => {
  await render({ ...found, cliPath: '/opt/claude', cliSource: 'found' })
  mocks.invoke.mockResolvedValue(false)
  await act(async () => button('Choose…')!.click())
  expect(mocks.refresh).not.toHaveBeenCalledAfter(mocks.invoke)
})

it('offers the default back once a Claude Code is chosen, or when the chosen one is gone', async () => {
  await render({ ...found, cliPath: '/opt/claude', cliSource: 'chosen' })
  expect(container.textContent).toContain('/opt/claude, chosen by you.')
  await act(async () => button('Use default')!.click())
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('claude_reset_cli')
  expect(mocks.refresh).toHaveBeenLastCalledWith('tester')
  await render({ ...found, cliPath: '/opt/claude', cliSource: 'found', chosenMissing: '/gone/claude' })
  expect(container.textContent).toContain('The Claude Code you chose at /gone/claude is gone.')
  expect(button('Use default')).toBeDefined()
})

it('asks the login shell again on Refresh', async () => {
  await render({
    installed: true,
    connected: false,
    enabled: false,
    outdated: true,
    cliPath: '/opt/homebrew/bin/claude',
  })
  expect(container.textContent).toContain('choose another install')
  expect(container.textContent).not.toContain('Using Claude Code')
  await act(async () => button('Refresh')!.click())
  expect(mocks.refresh).toHaveBeenLastCalledWith('tester', true)
})

it('hides the choice from desktop shells that cannot make it', async () => {
  mocks.canChoose = false
  await render({ ...found, cliPath: '/opt/claude', cliSource: 'found' })
  expect(button('Choose…')).toBeUndefined()
  expect(container.textContent).not.toContain('Using Claude Code')
})

it('lets a person choose an install Doop did not find', async () => {
  await render({ installed: false, connected: false, enabled: false })
  expect(container.textContent).toContain('Installed somewhere Doop did not look?')
  expect(container.textContent).not.toContain('Using Claude Code')
  mocks.invoke.mockResolvedValue(true)
  await act(async () => button('Choose…')!.click())
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('claude_choose_cli')
  expect(mocks.refresh).toHaveBeenLastCalledWith('tester')
})
