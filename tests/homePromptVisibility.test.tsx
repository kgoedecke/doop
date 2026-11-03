// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HomeHero } from '../src/components/HomeHero'
import { GeneralSettings } from '../src/components/GeneralSettings'
import { PROMPT_BOX_STORAGE_KEY, setPromptBoxHidden } from '../src/lib/homePreferences'

vi.mock('../src/components/ModelPicker', () => ({ ModelPicker: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const actions = {
  onPrompt: vi.fn(),
  onImport: vi.fn(),
  onConnectAgents: vi.fn(),
  onAutomations: vi.fn(),
  onIntegrations: vi.fn(),
}

beforeEach(() => {
  setPromptBoxHidden(false)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(busy = false) {
  await act(async () => root.render(<HomeHero busy={busy} actions={actions} focusAt={0} />))
}

async function click(selector: string, scope: ParentNode = document) {
  const button = scope.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

it('requires confirmation and keeps the prompt visible when cancelled or dismissed', async () => {
  await render()
  await click('[aria-label="Hide Prompt Box"]')
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Hide Prompt Box?')
  expect(dialog.textContent).toContain('Settings → General')
  expect(document.activeElement?.textContent).toBe('Cancel')
  await act(async () => (document.activeElement as HTMLButtonElement).click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('textarea')).not.toBeNull()
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('false')

  await click('[aria-label="Hide Prompt Box"]')
  await click('[aria-label="Close"]', document.querySelector('[role="dialog"]')!)
  expect(container.querySelector('textarea')).not.toBeNull()
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('false')
})

it('persists hiding and lets settings restore the prompt box', async () => {
  await render()
  await click('[aria-label="Hide Prompt Box"]')
  const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(
    (button) => button.textContent === 'Hide Prompt Box',
  )!
  await act(async () => confirm.click())
  expect(container.querySelector('[data-slot="home-hero"]')).toBeNull()
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('true')

  // A fresh module reads the persisted choice, as a page reload would.
  vi.resetModules()
  const fresh = await import('../src/lib/homePreferences')
  function ReloadedHome() {
    return fresh.usePromptBoxHidden() ? null : <p>Prompt box</p>
  }
  await act(async () => root.render(<ReloadedHome />))
  expect(container.textContent).toBe('')

  await act(async () => root.render(<GeneralSettings />))
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  await click('[role="switch"]', container)
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('false')
  await render()
  expect(container.querySelector('textarea')).not.toBeNull()
})

it('cannot hide a prompt while it is being submitted', async () => {
  await render(true)
  await click('[aria-label="Hide Prompt Box"]')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('textarea')).not.toBeNull()
})
