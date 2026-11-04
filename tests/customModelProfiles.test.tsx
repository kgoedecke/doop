// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CustomModelProfile, ModelAccountStatus } from '../src/lib/api'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  activate: vi.fn(),
  test: vi.fn(),
  models: vi.fn(),
  pick: vi.fn(),
  disconnect: vi.fn(),
  account: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    modelProfiles: mocks.list,
    createModelProfile: mocks.create,
    updateModelProfile: mocks.update,
    deleteModelProfile: mocks.remove,
    activateModelProfile: mocks.activate,
    testModelProfile: mocks.test,
    agentModels: mocks.models,
    setAgentModel: mocks.pick,
    disconnectModelAccount: mocks.disconnect,
    modelAccount: mocks.account,
  },
}))

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

import { CustomModelProfiles } from '../src/components/CustomModelProfiles'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const profile = (overrides: Partial<CustomModelProfile> = {}): CustomModelProfile => ({
  id: 'profile-1',
  name: 'Local Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3.5-coder',
  supportsVision: false,
  active: false,
  connectedAt: 1,
  updatedAt: 1,
  ...overrides,
})

const disconnected: ModelAccountStatus = { connected: false }
const activeAccount = (overrides: Partial<ModelAccountStatus> = {}): ModelAccountStatus => ({
  connected: true,
  kind: 'custom-key',
  profileId: 'profile-1',
  model: 'qwen3.5-coder',
  menus: {
    chatgpt: [],
    'openai-key': [],
    'anthropic-key': [],
    'openrouter-key': [],
    'gemini-key': [],
    'custom-key': [],
  },
  ...overrides,
})

const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
const input = (placeholder: string) =>
  Array.from(container.querySelectorAll('input')).find((i) => i.placeholder === placeholder)!
const fill = async (target: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = async (target: Element | undefined) => {
  expect(target).toBeDefined()
  await act(async () => (target as HTMLElement).click())
}
const wait = () => act(async () => await Promise.resolve())
const render = async (account: ModelAccountStatus, props: Record<string, unknown> = {}) => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<CustomModelProfiles account={account} {...props} />))
  await wait()
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.list.mockResolvedValue([])
  mocks.models.mockResolvedValue({ models: [], live: false })
  mocks.account.mockResolvedValue(disconnected)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows the empty state and opens a form with the optional key and vision toggle', async () => {
  await render(disconnected)
  expect(container.textContent).toContain('No custom endpoints yet')
  expect(container.textContent).toContain('CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS=1')

  await click(button('Add custom endpoint'))
  expect(input('Local Ollama')).toBeDefined()
  expect(input('https://provider.example/v1')).toBeDefined()
  expect(input('qwen3.5-coder')).toBeDefined()
  expect(input('sk-… (optional)')).toBeDefined()
  expect(container.querySelector('[role="switch"]')).not.toBeNull()
  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
})

it('creates a profile with the vision value and never renders the key back', async () => {
  mocks.list.mockResolvedValueOnce([]).mockResolvedValue([profile({ supportsVision: false })])
  mocks.create.mockResolvedValue(profile())
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('Local Ollama'), 'Local Ollama')
  await fill(input('https://provider.example/v1'), 'http://127.0.0.1:11434/v1')
  await fill(input('qwen3.5-coder'), 'qwen3.5-coder')
  await fill(input('sk-… (optional)'), 'sk-never-rendered')
  await act(async () => (container.querySelector('[role="switch"]') as HTMLElement).click())
  await click(button('Save endpoint'))

  expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
    name: 'Local Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'sk-never-rendered',
    model: 'qwen3.5-coder',
    supportsVision: false,
  })
  expect(container.textContent).toContain('Local Ollama')
  expect(container.textContent).toContain('127.0.0.1:11434/v1')
  expect(container.textContent).not.toContain('sk-never-rendered')
})

it('tests an endpoint and reports translated success and failure without echoing the key', async () => {
  mocks.test
    .mockResolvedValueOnce({ reachable: true, models: ['one', 'two'] })
    .mockResolvedValueOnce({ reachable: false, errorCode: 'auth_failed' })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('https://provider.example/v1'), 'https://provider.example/v1')
  await fill(input('sk-… (optional)'), 'sk-test-secret')
  await click(button('Test connection'))
  expect(container.textContent).toContain('Connection works — 2 models available')
  expect(container.textContent).not.toContain('sk-test-secret')

  await click(button('Test connection'))
  expect(container.textContent).toContain('The endpoint rejected the API key')
})

it('preserves a stored key when editing and clears it only when asked', async () => {
  mocks.list.mockResolvedValue([profile()])
  mocks.update.mockResolvedValue(profile({ name: 'Renamed' }))
  const account = disconnected
  await render(account)
  await click(button('Edit'))
  expect((input('Local Ollama') as HTMLInputElement).value).toBe('Local Ollama')
  expect((input('sk-… (optional)') as HTMLInputElement).value).toBe('')
  await fill(input('Local Ollama'), 'Renamed')
  await click(button('Save endpoint'))
  expect(mocks.update).toHaveBeenNthCalledWith(1, 'profile-1', {
    name: 'Renamed',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5-coder',
    supportsVision: false,
  })

  await click(button('Edit'))
  await click(container.querySelector('input[type="checkbox"]')!)
  await click(button('Save endpoint'))
  expect(mocks.update).toHaveBeenNthCalledWith(2, 'profile-1', {
    name: 'Local Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5-coder',
    supportsVision: false,
    apiKey: null,
  })
})

it('activates a saved profile and reports the new account', async () => {
  const next = activeAccount()
  mocks.list.mockResolvedValue([profile()])
  mocks.activate.mockResolvedValue(next)
  const onAccountChange = vi.fn()
  const onChange = vi.fn()
  await render(disconnected, { onAccountChange, onChange })
  await click(button('Use this endpoint'))
  expect(mocks.activate).toHaveBeenCalledExactlyOnceWith('profile-1')
  expect(onAccountChange).toHaveBeenCalledWith(next)
  expect(onChange).toHaveBeenCalled()
})

it('asks before deleting and refreshes the list', async () => {
  mocks.list.mockResolvedValue([profile()])
  mocks.remove.mockResolvedValue({ ok: true })
  await render(disconnected)
  await click(button('Delete'))
  expect(document.body.textContent).toContain('Delete Local Ollama?')
  await click(button('Delete endpoint'))
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('profile-1')
  expect(mocks.list).toHaveBeenCalledTimes(2)
})

it('keeps the selected model visible and warns when the live catalog fails', async () => {
  mocks.list.mockResolvedValue([profile({ active: true })])
  mocks.models.mockResolvedValue({ models: [], live: false, error: 'Could not load models' })
  await render(activeAccount())
  expect(container.textContent).toContain('qwen3.5-coder')
  expect(container.textContent).toContain('live model list is unavailable')
  expect(container.textContent).toContain('Active')
})
