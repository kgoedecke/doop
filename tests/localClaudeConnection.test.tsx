// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  select: vi.fn(),
  state: vi.fn(),
  invoke: vi.fn(),
  session: vi.fn(),
  capture: vi.fn(),
  hasLocal: vi.fn(),
}))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: mocks.session } }))
vi.mock('../src/lib/api', () => ({ api: {} }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => true }))
vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: mocks.state,
  hasLocalClaude: mocks.hasLocal,
  canInstallClaude: () => true,
  refreshLocalAgent: mocks.refresh,
  selectLocalAgent: mocks.select,
  disconnectLocalAgent: vi.fn(),
  invokeClaude: mocks.invoke,
}))
vi.mock('../src/components/ModelAccount', () => ({
  useModelAccount: () => ({ account: { connected: false }, set: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
vi.mock('../src/App', () => ({ navigate: vi.fn() }))
import { ModelPicker } from '../src/components/ModelPicker'
import { LocalClaudeRow } from '../src/components/LocalClaude'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
beforeEach(async () => {
  vi.resetAllMocks()
  mocks.session.mockReturnValue({ data: { user: { id: 'alice' } } })
  mocks.hasLocal.mockReturnValue(true)
  mocks.state.mockReturnValue({
    preference: { enabled: false, model: 'claude-opus-5' },
    native: { installed: true, connected: true, enabled: false },
  })
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
  [
    { installed: true, connected: false, provider: 'foundry' },
    'Check your Claude Code profile authentication, then Refresh.',
  ],
])('does not activate stale CLI credentials and offers recovery', async (native, message) => {
  mocks.refresh.mockResolvedValueOnce({ native })
  await act(async () => button('Use instead')!.click())
  expect(mocks.select).not.toHaveBeenCalled()
  expect(container.textContent).toContain(message)
  expect(button('Refresh')).toBeDefined()
  await act(async () => button('Refresh')!.click())
  expect(button('Refresh')).toBeUndefined()
})

it('allows disconnecting an enabled profile with expired authentication before changing it', async () => {
  mocks.state.mockReturnValue({
    preference: { enabled: true, model: 'deployment' },
    native: { installed: true, connected: false, enabled: true, modelDiscovery: true, customProfile: true },
  })
  await act(async () => root.render(<LocalClaudeRow />))
  expect(button('Disconnect')).toBeDefined()
  expect(button('Choose launcher…')).toBeUndefined()
  expect(container.textContent).not.toContain('Local configuration')
})

it('uses the profile model menu and sends the exact deployment selected in the composer', async () => {
  mocks.state.mockReturnValue({
    preference: { enabled: true, model: 'default' },
    native: {
      installed: true,
      connected: true,
      enabled: true,
      modelDiscovery: true,
      customProfile: true,
      models: [{ id: 'team/deployment-v2', name: 'Team deployment', blurb: 'Custom provider model' }],
    },
  })
  await act(async () => root.render(<ModelPicker />))
  const trigger = container.querySelector('button')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
  expect(options.map((option) => option.textContent)).toEqual(['Team deploymentCustom provider model'])
  await act(async () => options[0]!.click())
  expect(mocks.select).toHaveBeenCalledExactlyOnceWith('alice', { enabled: true, model: 'team/deployment-v2' })
  expect(mocks.capture).toHaveBeenCalledWith('agent_model_changed', { model: 'custom', via: 'composer' })
})

it('shows configuration errors without offering a misleading reinstall and preserves Disconnect', async () => {
  mocks.state.mockReturnValue({
    preference: { enabled: true, model: 'team/deployment' },
    native: {
      installed: false,
      connected: false,
      enabled: true,
      modelDiscovery: true,
      configError: 'The selected Claude Code launcher is missing',
    },
  })
  await act(async () => root.render(<LocalClaudeRow />))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('launcher is missing')
  expect(button('Install Claude Code')).toBeUndefined()
  expect(button('Sign in')).toBeUndefined()
  expect(button('Disconnect')).toBeDefined()
  expect(button('Refresh')).toBeDefined()
})

it('keeps the subscription default selected and hides custom entry without an opted-in profile', async () => {
  mocks.state.mockReturnValue({
    preference: { enabled: true, model: 'default' },
    native: { installed: true, connected: true, enabled: true, modelDiscovery: true, customProfile: false },
  })
  await act(async () => root.render(<ModelPicker />))
  expect(container.querySelector('button')?.textContent).toBe('Sonnet 5')
  await act(async () =>
    container.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  )
  expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toContain('Sonnet 5')
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Use a custom model')
})

it('shows local recovery guidance when a custom catalog is empty', async () => {
  mocks.state.mockReturnValue({
    preference: { enabled: true, model: 'default' },
    native: { installed: true, connected: true, enabled: true, modelDiscovery: true, customProfile: true, models: [] },
  })
  await act(async () => root.render(<ModelPicker />))
  expect(container.querySelector('button')?.textContent).toBe('Claude Code default')
  await act(async () =>
    container.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  )
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('No models were loaded from Claude Code')
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('server’s model')
  expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0)
})

it('shows a failed model change in the open menu and clears the error on reopening', async () => {
  mocks.state.mockReturnValue({
    preference: { enabled: true, model: 'default' },
    native: {
      installed: true,
      connected: true,
      enabled: true,
      customProfile: true,
      models: [{ id: 'team/model', name: 'Team model', blurb: '' }],
    },
  })
  mocks.select.mockRejectedValueOnce(new Error('Model update failed'))
  await act(async () => root.render(<ModelPicker />))
  const trigger = container.querySelector('button')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"]')!.click())
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Model update failed')
  await act(async () =>
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Model update failed')
})

it('reports a lost session during custom entry and clears that error on cancel', async () => {
  mocks.state.mockReturnValue({
    preference: { enabled: true, model: 'default' },
    native: { installed: true, connected: true, enabled: true, customProfile: true, models: [] },
  })
  await act(async () => root.render(<ModelPicker />))
  const trigger = container.querySelector('button')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const custom = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (el) => el.textContent === 'Use a custom model…',
  )!
  await act(async () => custom.click())
  mocks.session.mockReturnValue({ data: null })
  await act(async () => root.render(<ModelPicker />))
  const input = document.querySelector<HTMLInputElement>('#claude-custom-model')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'team/model')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () =>
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Sign in to Doop')
  expect(mocks.select).not.toHaveBeenCalled()
  const cancel = Array.from(document.querySelectorAll('button')).find((el) => el.textContent === 'Cancel')!
  await act(async () => cancel.click())
  mocks.session.mockReturnValue({ data: { user: { id: 'alice' } } })
  await act(async () => root.render(<ModelPicker />))
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Sign in to Doop')
})

it('does not present the server placeholder as the actual desktop model in a browser', async () => {
  mocks.hasLocal.mockReturnValue(false)
  mocks.state.mockReturnValue({ preference: { enabled: true, model: 'claude-sonnet-5' }, native: null })
  await act(async () => root.render(<ModelPicker />))
  expect(container.querySelector('button')?.textContent).toBe('Desktop model')
  expect(container.querySelector('button')?.disabled).toBe(true)
})
