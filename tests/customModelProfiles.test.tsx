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

const localMode = vi.hoisted(() => ({ preference: { enabled: true, model: 'default' as string } }))

vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))

vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: (selector: (state: { preference: typeof localMode.preference }) => unknown) =>
    selector({ preference: localMode.preference }),
  refreshLocalAgent: vi.fn().mockResolvedValue({ preference: { enabled: false, model: 'default' } }),
  selectLocalAgent: vi.fn(),
}))

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

import { CustomModelProfiles, pickCustomModel } from '../src/components/CustomModelProfiles'
import { refreshLocalAgent } from '../src/lib/localAgent'

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

const selectOption = async (label: string) => {
  const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
  await act(async () => trigger.focus())
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  const option = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.trim() === label)
  expect(option).toBeDefined()
  await act(async () => {
    ;(option as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  })
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
  expect(input('sk-… (optional)')).toBeDefined()
  expect(container.querySelector('[role="switch"]')).not.toBeNull()
  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
})

it('creates a profile with the vision value and never renders the key back', async () => {
  mocks.list.mockResolvedValueOnce([]).mockResolvedValue([profile({ supportsVision: false })])
  mocks.create.mockResolvedValue(profile())
  mocks.test.mockResolvedValue({ reachable: true, models: ['qwen3.5-coder'] })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('Local Ollama'), 'Local Ollama')
  await fill(input('https://provider.example/v1'), 'http://127.0.0.1:11434/v1')
  await fill(input('sk-… (optional)'), 'sk-never-rendered')
  await act(async () => (container.querySelector('[role="switch"]') as HTMLElement).click())
  await click(button('Test connection'))
  await selectOption('qwen3.5-coder')
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
  expect(mocks.test).toHaveBeenLastCalledWith({
    baseUrl: 'https://provider.example/v1',
    apiKey: 'sk-test-secret',
  })

  await click(button('Test connection'))
  expect(container.textContent).toContain('The endpoint rejected the API key')
})

it('tests an existing profile with its stored key when a replacement field is erased', async () => {
  mocks.list.mockResolvedValue([profile()])
  mocks.test.mockResolvedValue({ reachable: true, models: ['qwen3.5-coder'] })
  await render(disconnected)
  await click(button('Edit'))
  await fill(input('sk-… (optional)'), 'sk-temporary')
  await fill(input('sk-… (optional)'), '')
  await click(button('Test connection'))
  expect(mocks.test).toHaveBeenCalledExactlyOnceWith({
    baseUrl: 'http://127.0.0.1:11434/v1',
    profileId: 'profile-1',
  })
})

it('preserves a stored key when editing and clears it only when asked', async () => {
  mocks.list.mockResolvedValue([profile()])
  mocks.test.mockResolvedValue({ reachable: true, models: ['qwen3.5-coder'] })
  mocks.update.mockResolvedValue(profile({ name: 'Renamed' }))
  const account = disconnected
  await render(account)
  await click(button('Edit'))
  expect((input('Local Ollama') as HTMLInputElement).value).toBe('Local Ollama')
  expect((input('sk-… (optional)') as HTMLInputElement).value).toBe('')
  await fill(input('Local Ollama'), 'Renamed')
  await click(button('Test connection'))
  await selectOption('qwen3.5-coder')
  await click(button('Save endpoint'))
  expect(mocks.update).toHaveBeenNthCalledWith(1, 'profile-1', {
    name: 'Renamed',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5-coder',
    supportsVision: false,
  })

  mocks.test.mockResolvedValue({ reachable: true, models: ['qwen3.5-coder'] })
  await click(button('Edit'))
  await click(container.querySelector('input[type="checkbox"]')!)
  await click(button('Test connection'))
  await selectOption('qwen3.5-coder')
  await click(button('Save endpoint'))
  expect(mocks.update).toHaveBeenNthCalledWith(2, 'profile-1', {
    name: 'Local Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5-coder',
    supportsVision: false,
    apiKey: null,
  })
})

it('does not clear a saved key when a replacement key is typed and then blanked', async () => {
  mocks.list.mockResolvedValue([profile()])
  mocks.test.mockResolvedValue({ reachable: true, models: ['qwen3.5-coder'] })
  mocks.update.mockResolvedValue(profile())
  await render(disconnected)
  await click(button('Edit'))
  await fill(input('sk-… (optional)'), 'sk-temporary')
  await fill(input('sk-… (optional)'), '')
  await click(button('Test connection'))
  await selectOption('qwen3.5-coder')
  await click(button('Save endpoint'))

  expect(mocks.update).toHaveBeenCalledWith('profile-1', {
    name: 'Local Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5-coder',
    supportsVision: false,
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
  expect(refreshLocalAgent).toHaveBeenCalled()
})

it('does not show the connected provider as active when local selection wins', async () => {
  mocks.list.mockResolvedValue([profile({ active: true })])
  mocks.account.mockResolvedValue(activeAccount())
  mocks.activate.mockResolvedValue(activeAccount())
  await render(activeAccount())
  expect(container.textContent).not.toContain('Active')
  expect(button('Use this endpoint')).toBeDefined()
  await click(button('Use this endpoint'))
  expect(mocks.activate).toHaveBeenCalledWith('profile-1')
})

it('refreshes the saved profile model after selecting a different live model', async () => {
  const next = activeAccount({ model: 'qwen3.5-coder:latest' })
  const refreshed = vi.fn().mockResolvedValue(undefined)
  const onAccountChange = vi.fn()
  const onChange = vi.fn()
  mocks.pick.mockResolvedValue(next)

  await pickCustomModel('qwen3.5-coder:latest', 'qwen3.5-coder', mocks.pick, refreshed, onAccountChange, onChange)

  expect(mocks.pick).toHaveBeenCalledWith('qwen3.5-coder:latest')
  expect(onAccountChange).toHaveBeenCalledWith(next)
  expect(refreshed).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledOnce()
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
})

it('requires selecting a discovered model before save', async () => {
  mocks.test.mockResolvedValue({ reachable: true, models: ['m-a', 'm-b'] })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('Local Ollama'), 'Local Ollama')
  await fill(input('https://provider.example/v1'), 'https://provider.example/v1')
  await click(button('Test connection'))

  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
  await selectOption('m-a')
  await click(button('Save endpoint'))
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'm-a' }))
})

it('invalidates discovery when base URL changes after test', async () => {
  mocks.test.mockResolvedValueOnce({ reachable: true, models: ['m-a'] })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('https://provider.example/v1'), 'https://one.example/v1')
  await click(button('Test connection'))
  await fill(input('https://provider.example/v1'), 'https://two.example/v1')

  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
})

it('uses stored key when blank key is tested for saved profile', async () => {
  mocks.list.mockResolvedValue([profile()])
  mocks.test.mockResolvedValue({ reachable: true, models: ['qwen3.5-coder'] })
  await render(disconnected)
  await click(button('Edit'))
  await click(button('Test connection'))

  expect(mocks.test).toHaveBeenCalledWith({
    baseUrl: 'http://127.0.0.1:11434/v1',
    profileId: 'profile-1',
  })
})

it('offers manual input only after enabling unverified fallback', async () => {
  mocks.test.mockResolvedValue({ reachable: true, models: [] })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('https://provider.example/v1'), 'https://provider.example/v1')
  await click(button('Test connection'))

  expect(container.querySelector('input[name="models-manual"]')).toBeNull()
  const checkbox = container.querySelector('input[name="models-fallback"]') as HTMLInputElement
  await click(checkbox)
  expect(container.querySelector('input[name="models-manual"]')).not.toBeNull()
})

it('discards a test result that resolves after the endpoint changed', async () => {
  let resolveTest!: (value: { reachable: boolean; models: string[] }) => void
  mocks.test.mockImplementation(
    () =>
      new Promise<{ reachable: boolean; models: string[] }>((resolve) => {
        resolveTest = resolve
      }),
  )
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('https://provider.example/v1'), 'https://one.example/v1')
  await click(button('Test connection'))
  await fill(input('https://provider.example/v1'), 'https://two.example/v1')
  await act(async () => {
    resolveTest({ reachable: true, models: ['m-a'] })
    await Promise.resolve()
  })
  await wait()

  expect(container.querySelector('[role="combobox"]')).toBeNull()
  expect(container.textContent).not.toContain('Connection works')
  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
})

it('invalidates the tested fingerprint when the API key changes after test', async () => {
  mocks.test.mockResolvedValue({ reachable: true, models: ['m-a'] })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('Local Ollama'), 'Local Ollama')
  await fill(input('https://provider.example/v1'), 'https://provider.example/v1')
  await click(button('Test connection'))
  await selectOption('m-a')
  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(false)

  await fill(input('sk-… (optional)'), 'sk-changed-after-test')

  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
  expect(container.querySelector('[role="combobox"]')).toBeNull()
  expect(container.textContent).not.toContain('Connection works')
})

it('invalidates the tested fingerprint when the stored key is cleared after test', async () => {
  mocks.list.mockResolvedValue([profile()])
  mocks.test.mockResolvedValue({ reachable: true, models: ['qwen3.5-coder'] })
  await render(disconnected)
  await click(button('Edit'))
  await click(button('Test connection'))
  await selectOption('qwen3.5-coder')
  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(false)

  const clearLabel = Array.from(container.querySelectorAll('label')).find((label) =>
    label.textContent?.includes('Clear the saved API key'),
  )
  await click(clearLabel?.querySelector('input[type="checkbox"]') ?? undefined)

  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
  expect(container.querySelector('[role="combobox"]')).toBeNull()
})

it('blocks save for an invalid fallback id and enables it for a valid one', async () => {
  mocks.test.mockResolvedValue({ reachable: true, models: [] })
  mocks.create.mockResolvedValue(profile())
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('Local Ollama'), 'Local Ollama')
  await fill(input('https://provider.example/v1'), 'https://provider.example/v1')
  await click(button('Test connection'))
  await click(container.querySelector('input[name="models-fallback"]') as HTMLInputElement)
  const manual = container.querySelector('input[name="models-manual"]') as HTMLInputElement
  expect(manual).not.toBeNull()

  await fill(manual, 'bad id!')
  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)

  await fill(manual, 'valid.model-1:x')
  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(false)
  await click(button('Save endpoint'))
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'valid.model-1:x' }))
})

it('keeps the saved model visible with a notice when the endpoint reports none', async () => {
  mocks.list.mockResolvedValue([profile({ model: 'saved-model-x' })])
  mocks.test.mockResolvedValue({ reachable: true, models: [] })
  await render(disconnected)
  await click(button('Edit'))
  await click(button('Test connection'))

  expect(container.textContent).toContain('saved-model-x')
  expect(container.textContent).toContain('was not reported by the endpoint')
  expect((button('Save endpoint') as HTMLButtonElement).disabled).toBe(true)
})

it('keeps the saved model visible with a notice when the test fails', async () => {
  mocks.list.mockResolvedValue([profile({ model: 'saved-model-x' })])
  mocks.test.mockResolvedValue({ reachable: false, errorCode: 'unreachable' })
  await render(disconnected)
  await click(button('Edit'))
  await click(button('Test connection'))

  expect(container.textContent).toContain('saved-model-x')
  expect(container.textContent).toContain('was not reported by the endpoint')
})

it('filters a discovered list of more than 100 models with an accessible search', async () => {
  const many = Array.from({ length: 120 }, (_, i) => `model-${String(i).padStart(3, '0')}`)
  mocks.test.mockResolvedValue({ reachable: true, models: many })
  await render(disconnected)
  await click(button('Add custom endpoint'))
  await fill(input('Local Ollama'), 'Local Ollama')
  await fill(input('https://provider.example/v1'), 'https://provider.example/v1')
  await click(button('Test connection'))

  const search = container.querySelector('input[name="models-search"]') as HTMLInputElement
  expect(search).not.toBeNull()
  expect(search.getAttribute('aria-label')).toBe('Search models')
  expect(container.querySelector('label[for="custom-model-search"]')?.textContent).toBe('Search models')

  await fill(search, 'model-105')
  const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
  await act(async () => trigger.focus())
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  const options = [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent?.trim())
  expect(options).toContain('model-105')
  expect(options).not.toContain('model-000')
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
})
