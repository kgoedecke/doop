// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GEMINI_MODELS, OPENROUTER_MODELS } from '../shared/modelMenu'

/**
 * The two roster providers in the Settings panel: the OpenRouter section
 * renders a dropdown picker (the roster outgrows chips), text-only models are
 * labelled, and each section's key form posts to its own connect route.
 */

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  connectOpenRouter: vi.fn(),
  connectGemini: vi.fn(),
  selectLocal: vi.fn(),
}))
const MENUS = {
  chatgpt: [],
  'openai-key': [],
  'anthropic-key': [],
  'openrouter-key': OPENROUTER_MODELS,
  'gemini-key': GEMINI_MODELS,
}
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({
  api: {
    modelAccounts: mocks.account,
    agentModels: async () => ({ models: [], live: false }),
    connectOpenRouterKey: mocks.connectOpenRouter,
    connectGeminiKey: mocks.connectGemini,
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
async function render() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<ModelAccountPanel />))
}
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows the connected OpenRouter roster as a dropdown with the text-only label', async () => {
  mocks.account.mockResolvedValue({
    accounts: [{ kind: 'openrouter-key', enabled: true, model: 'z-ai/glm-5.3', connectedAt: 1 }],
    default: 'openrouter-key',
    chatgptEnabled: true,
    menus: MENUS,
  })
  await render()
  expect(container.textContent).toContain('OpenRouter API key')
  const row = Array.from(container.querySelectorAll('[role="listitem"]')).find((r) =>
    r.textContent?.includes('OpenRouter API key'),
  )!
  expect(row.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  expect(row.textContent).toContain('Default')
  /* the picker is a dropdown trigger naming the current model, not a chip row */
  const trigger = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('GLM-5.3'))
  expect(trigger).toBeDefined()
  expect(trigger!.textContent).toContain('no visual review')
  /* and the chosen-model blurb spells the tradeoff out */
  expect(container.textContent).toContain('designs aren’t visually reviewed')
})

it('posts a new Gemini key to its own connect route', async () => {
  mocks.account.mockResolvedValue({ accounts: [], chatgptEnabled: true, menus: MENUS })
  mocks.connectGemini.mockResolvedValue({
    accounts: [{ kind: 'gemini-key', enabled: true, model: 'gemini-3.7-flash', connectedAt: 1 }],
    default: 'gemini-key',
    chatgptEnabled: true,
    menus: MENUS,
  })
  await render()
  const geminiSection = Array.from(container.querySelectorAll('[role="listitem"]')).find((r) =>
    r.textContent?.includes('Gemini API key'),
  )!
  await act(async () => {
    Array.from(geminiSection.querySelectorAll('button'))
      .find((b) => b.textContent === 'Connect')!
      .click()
  })
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
  expect(input.placeholder).toBe('AIza…')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'AIzaNewKeyLongEnough12345')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Save key').click())
  expect(mocks.connectGemini).toHaveBeenCalledExactlyOnceWith('AIzaNewKeyLongEnough12345')
  expect(mocks.connectOpenRouter).not.toHaveBeenCalled()
})
