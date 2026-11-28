// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const SHARED = 'custom:0123456789abcdef01'
const OWN = 'custom:aaaaaaaaaaaaaaaaaa'
const mocks = vi.hoisted(() => ({
  disconnect: vi.fn(),
  toggle: vi.fn(),
}))
const custom = (baseUrl: string) => ({
  name: 'Acme Gateway',
  apiType: 'openai-chat' as const,
  baseUrl,
  models: [{ id: 'qwen3-coder', vision: true }],
  headerNames: [],
  hasKey: true,
})
const view = {
  accounts: [
    { kind: OWN, enabled: true, model: 'qwen3-coder', connectedAt: 1, custom: custom('https://mine.example/v1') },
    {
      kind: SHARED,
      enabled: true,
      model: 'qwen3-coder',
      connectedAt: 2,
      custom: custom('https://llm.acme.example'),
      shared: true,
    },
  ],
  default: SHARED,
  chatgptEnabled: true,
  menus: {},
  customProviders: true,
}
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({
  api: {
    modelAccounts: async () => view,
    agentModels: async () => ({ models: [], live: true }),
    disconnectModelAccount: mocks.disconnect,
    setModelAccountEnabled: mocks.toggle,
  },
}))
vi.mock('../src/lib/localAgent', () => ({ useLocalAgent: () => ({ enabled: false }) }))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => ({ allowanceChanged: vi.fn() }) } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/LocalClaude', () => ({ LocalClaudeRow: () => null }))
import { ModelAccountPanel } from '../src/components/ModelAccount'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* An admin's shared provider sits among the person's connections with a
   badge saying so: its switch and Make default work, Edit and Disconnect are
   not offered. A personal provider of the same name keeps both. */

let root: Root
let container: HTMLDivElement
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

const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[role="listitem"]'))
const rowOf = (host: string) => rows().find((row) => row.textContent?.includes(host))!

async function menuOf(row: HTMLElement): Promise<string[]> {
  act(() => {
    row
      .querySelector('[aria-label="More for Acme Gateway"]')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((el) => el.textContent)
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  return items.filter((item): item is string => !!item)
}

it('badges the shared provider and offers no edit or disconnect on it', async () => {
  const shared = rowOf('llm.acme.example')
  expect(shared.textContent).toContain('Shared by your admin')
  expect(await menuOf(shared)).toEqual(['Make default'])
})

it('keeps a personal provider of the same name editable and removable', async () => {
  const own = rowOf('mine.example')
  expect(own.textContent).not.toContain('Shared by your admin')
  expect(await menuOf(own)).toEqual(['Make default', 'Edit provider', 'Disconnect'])
})
