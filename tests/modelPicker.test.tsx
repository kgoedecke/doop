// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const accountState = vi.hoisted(() => ({
  account: { connected: true, kind: 'custom-key' as const, model: 'm-missing', menus: { 'custom-key': [] } },
}))

vi.mock('../src/components/ModelAccount', () => ({
  useModelAccount: () => ({ account: accountState.account, set: vi.fn(), refresh: vi.fn() }),
  useAgentModels: () => ({ models: [{ id: 'm-a', name: 'm-a', blurb: '' }], live: true }),
}))

vi.mock('../src/lib/api', () => ({ api: { setAgentModel: vi.fn().mockResolvedValue(accountState.account) } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/i18n', () => ({ useT: () => (key: string) => key, t: (key: string) => key }))

import { ModelPicker } from '../src/components/ModelPicker'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('keeps the saved missing model in the composer label', async () => {
  await act(async () => root.render(<ModelPicker />))
  expect(container.textContent).toContain('m-missing')
})
