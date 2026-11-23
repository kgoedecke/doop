// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  update: vi.fn(),
  discover: vi.fn(),
  test: vi.fn(),
  addShared: vi.fn(),
  updateShared: vi.fn(),
  discoverShared: vi.fn(),
  testShared: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api: {
    addCustomProvider: mocks.add,
    updateCustomProvider: mocks.update,
    discoverCustomModels: mocks.discover,
    testCustomProvider: mocks.test,
  },
  adminApi: {
    addSharedProvider: mocks.addShared,
    updateSharedProvider: mocks.updateShared,
    discoverSharedModels: mocks.discoverShared,
    testSharedProvider: mocks.testShared,
  },
}))
import { CustomProviderForm } from '../src/components/CustomProviderForm'
import type { ModelAccountStatus } from '../src/lib/api'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The custom provider form sends what the server validates, and on an edit
   leaves the stored key and headers alone unless the person replaces them. */

let root: Root
let container: HTMLDivElement
const view = { accounts: [], chatgptEnabled: true, menus: {} }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.add.mockResolvedValue(view)
  mocks.update.mockResolvedValue(view)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)

/* React tracks an input's value itself, so set it the way a keystroke would */
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const field = (selector: string) => document.querySelector<HTMLInputElement>(selector)!

async function click(label: string) {
  await act(async () => {
    button(label)!.click()
  })
}

it('adds a provider with what the form says, the key blank meaning none', async () => {
  const onSaved = vi.fn()
  act(() => root.render(<CustomProviderForm onSaved={onSaved} onClose={() => {}} />))
  act(() => {
    type(field('input[placeholder="My provider"]'), 'Local vLLM')
    type(field('input[placeholder="https://api.example.com/v1"]'), 'https://llm.example.com/v1/')
    type(field('input[placeholder="my-model-id"]'), 'qwen3-coder')
    type(field('input[placeholder="Max output tokens"]'), '8k000')
  })
  await click('Add provider')
  expect(mocks.add).toHaveBeenCalledWith({
    name: 'Local vLLM',
    apiType: 'openai-chat',
    baseUrl: 'https://llm.example.com/v1',
    models: [{ id: 'qwen3-coder', vision: false, maxOutputTokens: 8000 }],
    apiKey: '',
  })
  expect(onSaved).toHaveBeenCalledWith(view)
})

it('shows what is wrong instead of sending a provider with no model', async () => {
  act(() => root.render(<CustomProviderForm onSaved={() => {}} onClose={() => {}} />))
  act(() => {
    type(field('input[placeholder="My provider"]'), 'Acme')
    type(field('input[placeholder="https://api.example.com/v1"]'), 'https://llm.example.com/v1')
  })
  await click('Add provider')
  expect(mocks.add).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('at least one model')
})

it('edits without resending the stored key or headers, and lists the endpoint’s models to add', async () => {
  const provider: ModelAccountStatus = {
    kind: 'custom:0123456789abcdef01',
    enabled: true,
    model: 'glm-5',
    connectedAt: 1,
    custom: {
      name: 'Acme',
      apiType: 'openai-chat',
      baseUrl: 'https://llm.example.com/v1',
      models: [{ id: 'glm-5', vision: true }],
      headerNames: ['X-Tenant'],
      hasKey: true,
    },
  }
  mocks.discover.mockResolvedValue({ models: ['glm-5', 'kimi-k3'] })
  act(() => root.render(<CustomProviderForm provider={provider} onSaved={() => {}} onClose={() => {}} />))
  expect(document.body.textContent).toContain('Saved: X-Tenant')

  await click('Fetch models')
  /* the probe names the provider, so the server can use its stored key */
  expect(mocks.discover).toHaveBeenCalledWith({
    apiType: 'openai-chat',
    baseUrl: 'https://llm.example.com/v1',
    kind: provider.kind,
  })

  await click('Save')
  expect(mocks.update).toHaveBeenCalledWith(provider.kind, {
    name: 'Acme',
    apiType: 'openai-chat',
    baseUrl: 'https://llm.example.com/v1',
    models: [{ id: 'glm-5', vision: true }],
  })

  await click('Remove key')
  await click('Remove saved headers')
  /* a probe after removing them must not fall back to the stored ones */
  await click('Fetch models')
  expect(mocks.discover).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: '', headers: {} }))
  await click('Save')
  expect(mocks.update).toHaveBeenLastCalledWith(provider.kind, expect.objectContaining({ apiKey: '', headers: {} }))
})

it('in admin mode saves and probes a shared provider through the admin routes', async () => {
  const shared = { providers: [], customProviders: true }
  mocks.addShared.mockResolvedValue(shared)
  mocks.discoverShared.mockResolvedValue({ models: ['qwen3-coder'] })
  mocks.testShared.mockResolvedValue({ ok: true, model: 'qwen3-coder' })
  const onSaved = vi.fn()
  act(() => root.render(<CustomProviderForm admin onSaved={onSaved} onClose={() => {}} />))
  expect(document.body.textContent).toContain('Shared provider')
  act(() => {
    type(field('input[placeholder="My provider"]'), 'Acme Gateway')
    type(field('input[placeholder="https://api.example.com/v1"]'), 'https://llm.example.com/v1')
    type(field('input[placeholder="my-model-id"]'), 'qwen3-coder')
    type(field('input[type="password"]'), 'sk-gateway')
  })
  await click('Fetch models')
  expect(mocks.discoverShared).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-gateway' }))
  await click('Test')
  expect(mocks.testShared).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen3-coder' }))
  await click('Add provider')
  expect(mocks.addShared).toHaveBeenCalledWith(expect.objectContaining({ name: 'Acme Gateway', apiKey: 'sk-gateway' }))
  expect(onSaved).toHaveBeenCalledWith(shared)
  /* nothing went through a person's own routes */
  expect(mocks.add).not.toHaveBeenCalled()
  expect(mocks.discover).not.toHaveBeenCalled()
  expect(mocks.test).not.toHaveBeenCalled()
})
