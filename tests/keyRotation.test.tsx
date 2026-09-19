// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ replace: vi.fn(), disconnect: vi.fn(), selectLocal: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({
  api: {
    modelAccount: async () => ({ connected: true, kind: 'anthropic-key', model: 'claude-opus-5', models: [] }),
    connectAnthropicKey: mocks.replace,
    disconnectModelAccount: mocks.disconnect,
  },
}))
vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: () => ({ enabled: false }),
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
beforeEach(async () => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<ModelAccountPanel />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
it('opens an empty replacement form and cancels without disconnecting', async () => {
  await act(async () => button('Rotate key').click())
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('')
  expect(container.textContent).not.toContain('Workspace settings')
  await act(async () => button('Cancel').click())
  expect(button('Disconnect')).toBeDefined()
  expect(mocks.disconnect).not.toHaveBeenCalled()
  expect(mocks.replace).not.toHaveBeenCalled()
})
it('replaces the key without changing the active execution provider', async () => {
  mocks.replace.mockResolvedValue({ connected: true, kind: 'anthropic-key', model: 'claude-opus-5', models: [] })
  await act(async () => button('Rotate key').click())
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-ant-new-test')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Rotate key').click())
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('sk-ant-new-test')
  expect(mocks.selectLocal).not.toHaveBeenCalled()
  expect(mocks.disconnect).not.toHaveBeenCalled()
  expect(container.querySelector('input[type="password"]')).toBeNull()
})
