// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  select: vi.fn(),
  disconnect: vi.fn(),
  /* what the row reads: the server preference and the desktop's own status */
  state: {
    preference: { enabled: false, model: 'claude-opus-5' },
    native: { installed: true, connected: true, enabled: false },
  },
}))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({ api: {} }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => true }))
vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: () => mocks.state,
  hasLocalClaude: () => true,
  canInstallClaude: () => true,
  canChooseClaude: () => false,
  refreshLocalAgent: mocks.refresh,
  selectLocalAgent: mocks.select,
  disconnectLocalAgent: mocks.disconnect,
  invokeClaude: vi.fn(),
}))
import { LocalClaudeRow } from '../src/components/LocalClaude'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
beforeEach(async () => {
  vi.resetAllMocks()
  mocks.state = {
    preference: { enabled: false, model: 'claude-opus-5' },
    native: { installed: true, connected: true, enabled: false },
  }
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
  await act(async () => button('Connect')!.click())
  expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith('alice')
  expect(mocks.select).toHaveBeenCalledExactlyOnceWith('alice', { enabled: true, model: 'claude-opus-5' })
})
it.each([
  [{ installed: false, connected: false }, 'Install Claude Code to connect.'],
  [{ installed: true, connected: false }, 'Sign in to Claude Code to connect.'],
])('does not activate stale CLI credentials and offers recovery', async (native, message) => {
  mocks.refresh.mockResolvedValueOnce({ native })
  await act(async () => button('Connect')!.click())
  expect(mocks.select).not.toHaveBeenCalled()
  expect(container.textContent).toContain(message)
  expect(button('Refresh')).toBeDefined()
  await act(async () => button('Refresh')!.click())
  expect(button('Refresh')).toBeUndefined()
})

describe('a connected Plan', () => {
  const mount = async (props: Parameters<typeof LocalClaudeRow>[0]) => {
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<LocalClaudeRow {...props} />))
  }
  const on = {
    preference: { enabled: true, model: 'claude-opus-5' },
    native: { installed: true, connected: true, enabled: true },
  }
  /* Radix opens a menu on pointerdown; returns the open menu's items */
  const openMenu = (label: string) => {
    act(() => {
      container
        .querySelector(`[aria-label="${label}"]`)!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    })
    return (text: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')).find((el) =>
        el.textContent?.startsWith(text),
      )
  }
  const pick = (item: HTMLElement) => act(async () => item.click())
  const toggle = () => container.querySelector<HTMLElement>('[role="switch"]')!

  it('removes the connection with Disconnect in its menu, and the pane hears about it', async () => {
    mocks.state = on
    const onChange = vi.fn()
    await mount({ isDefault: true, onMakeDefault: vi.fn(), onChange })
    expect(container.textContent).toContain('Default')
    expect(button('Connect')).toBeUndefined()
    await pick(openMenu('More for Claude Plan')('Disconnect')!)
    expect(mocks.disconnect).toHaveBeenCalledExactlyOnceWith('alice')
    expect(mocks.select).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('pins a model from the Claude Code settings modal, not under the row', async () => {
    mocks.state = {
      ...on,
      native: { ...on.native, cliVersion: '2.1.281', cliPath: '/opt/claude', cliSource: 'shell' },
    } as typeof on
    await mount({ isDefault: false, onMakeDefault: vi.fn() })
    /* nothing of it under the row */
    expect(container.querySelector('input[aria-label="Pin a model id"]')).toBeNull()
    await pick(openMenu('More for Claude Plan')('Claude Code settings…')!)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    /* this shell cannot choose a CLI, so the modal holds only the pin */
    expect(dialog.textContent).toContain('Pin a model')
    expect(Array.from(dialog.querySelectorAll('button')).some((b) => b.textContent === 'Choose…')).toBe(false)
    const input = dialog.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'claude-opus-5-5')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      Array.from(dialog.querySelectorAll('button'))
        .find((b) => b.textContent === 'Pin')!
        .click(),
    )
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith('alice', { enabled: true, model: 'claude-opus-5-5' })
  })

  it('turns off with its switch, keeping the connection', async () => {
    mocks.state = on
    await mount({ isDefault: false, onMakeDefault: vi.fn() })
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle().click())
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith('alice', { enabled: false, model: 'claude-opus-5' })
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('offers Make default in its menu while on, and keeps a model change from switching it on', async () => {
    mocks.state = on
    const onMakeDefault = vi.fn()
    await mount({ isDefault: false, onMakeDefault })
    const item = openMenu('More for Claude Plan')('Make default')!
    expect(item.getAttribute('aria-disabled')).toBeNull()
    await pick(item)
    expect(onMakeDefault).toHaveBeenCalledOnce()

    mocks.state = { ...on, preference: { enabled: false, model: 'claude-opus-5' } }
    await mount({ isDefault: false, onMakeDefault })
    expect(container.textContent).toContain('Off')
    /* off: still connected, cannot be the default, and its switch brings it back */
    expect(button('Connect')).toBeUndefined()
    expect(openMenu('More for Claude Plan')('Make default')?.getAttribute('aria-disabled')).toBe('true')
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => toggle().click())
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith('alice', { enabled: true, model: 'claude-opus-5' })
    mocks.select.mockClear()
    await pick(openMenu('Model for Claude Plan')('Sonnet')!)
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith('alice', { enabled: false, model: 'sonnet' })
  })
})
