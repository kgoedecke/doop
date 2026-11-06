// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  disconnect: vi.fn(),
  selectLocal: vi.fn(),
  models: vi.fn(async (): Promise<AgentModelCatalog> => ({ models: [], live: false })),
}))
const claudeView = {
  accounts: [{ kind: 'anthropic-key', enabled: true, model: 'claude-opus-5', connectedAt: 1 }],
  default: 'anthropic-key',
  chatgptEnabled: true,
  menus: { chatgpt: [], 'openai-key': [], 'anthropic-key': [], 'openrouter-key': [], 'gemini-key': [] },
}
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({
  api: {
    modelAccounts: async () => claudeView,
    agentModels: mocks.models,
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
import type { AgentModelCatalog } from '../src/lib/api'
import { ModelAccountPanel } from '../src/components/ModelAccount'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
/* the replacement opens in a modal, which renders outside the container */
const button = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label)!
/* Replace key lives in the row's "…" menu; Radix opens a menu on pointerdown */
async function openReplaceForm() {
  act(() => {
    container
      .querySelector('[aria-label="More for Claude API key"]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (el) => el.textContent === 'Replace key',
  )!
  await act(async () => item.click())
}
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
  await openReplaceForm()
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('')
  expect(container.textContent).not.toContain('Workspace settings')
  await act(async () => button('Cancel').click())
  expect(document.querySelector('input[type="password"]')).toBeNull()
  expect(container.querySelector('[aria-label="More for Claude API key"]')).not.toBeNull()
  expect(mocks.disconnect).not.toHaveBeenCalled()
  expect(mocks.replace).not.toHaveBeenCalled()
})
it('replaces the key without changing the active execution provider', async () => {
  mocks.replace.mockResolvedValue(claudeView)
  await openReplaceForm()
  const input = document.querySelector<HTMLInputElement>('input[type="password"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-ant-new-test')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  /* the new key may unlock other models: the catalog is asked again, not kept */
  expect(mocks.models).toHaveBeenCalledExactlyOnceWith('anthropic-key')
  mocks.models.mockResolvedValue({
    models: [{ id: 'claude-opus-5', name: 'Opus 5 (rotated key)', blurb: '', vision: true }],
    live: true,
  })
  await act(async () => button('Replace key').click())
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('sk-ant-new-test')
  expect(mocks.selectLocal).not.toHaveBeenCalled()
  expect(mocks.disconnect).not.toHaveBeenCalled()
  expect(document.querySelector('input[type="password"]')).toBeNull()
  expect(mocks.models).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('Opus 5 (rotated key)')
})
it('shows a refused key directly under its field, and clears it on the next keystroke', async () => {
  const hint = 'That does not look like an Anthropic API key (they start with "sk-ant-")'
  mocks.replace.mockRejectedValue(Object.assign(new Error('400'), { body: { error: hint } }))
  await openReplaceForm()
  const input = document.querySelector<HTMLInputElement>('input[type="password"]')!
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  await type('nope')
  await act(async () => button('Replace key').click())
  const alert = document.querySelector('[role="alert"]')!
  expect(alert.textContent).toBe(hint)
  /* right after the field, inside the modal, and named by it */
  expect(input.nextElementSibling).toBe(alert)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.getAttribute('aria-describedby')).toBe(alert.id)
  /* not repeated under the lists */
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
  await type('sk-ant-')
  expect(document.querySelector('[role="alert"]')).toBeNull()
})
