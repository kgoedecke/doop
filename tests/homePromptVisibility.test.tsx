// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HomeHero } from '../src/components/HomeHero'
import { GeneralSettings } from '../src/components/GeneralSettings'
import { Button } from '../src/components/ui/button'
import { SparkIcon } from '../src/components/ui/icons'
import { PROMPT_BOX_STORAGE_KEY, setPromptBoxHidden, usePromptBoxHidden } from '../src/lib/homePreferences'

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
  onCommunity: vi.fn(),
}
const composer = '[aria-label="Ask Doop what to design"]'
const collapseButton = 'button[aria-label="Collapse prompt box"]'
const expandButton = '[aria-label="Show Prompt Box"]'

function HeaderExpand() {
  const hidden = usePromptBoxHidden()
  if (!hidden) return null
  return (
    <Button variant="default" size="bar" aria-label="Show Prompt Box" onClick={() => setPromptBoxHidden(false)}>
      <SparkIcon width={15} height={15} className="text-ink-soft" /> Show Prompt Box
    </Button>
  )
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
  await act(async () =>
    root.render(
      <>
        <HeaderExpand />
        <HomeHero busy={busy} actions={actions} focusAt={0} skillScope={{ personal: true }} />
      </>,
    ),
  )
}

async function click(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

it('collapses the prompt box immediately and persists the choice', async () => {
  await render()
  const input = container.querySelector(composer)
  expect(input).not.toBeNull()
  const button = container.querySelector(collapseButton)
  expect(button?.parentElement?.matches('[data-slot="home-hero"]')).toBe(true)
  expect(input?.parentElement?.contains(button)).toBe(false)
  expect(button?.getAttribute('title')).toBe('Collapse prompt box')
  await click(collapseButton)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector(composer)).toBeNull()
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('true')
})

it('restores the prompt box from the header in one click', async () => {
  await render()
  expect(container.querySelector(expandButton)).toBeNull()
  await click(collapseButton)
  expect(container.querySelector(expandButton)?.textContent?.trim()).toBe('Show Prompt Box')
  await click(expandButton)
  expect(container.querySelector(composer)).not.toBeNull()
  expect(container.querySelector(expandButton)).toBeNull()
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('false')
})

it('reads a stored true as collapsed after reload', async () => {
  localStorage.setItem(PROMPT_BOX_STORAGE_KEY, 'true')
  // A fresh module reads the persisted choice, as a page reload would.
  vi.resetModules()
  const fresh = await import('../src/lib/homePreferences')
  function ReloadedHome() {
    return fresh.usePromptBoxHidden() ? <p>Collapsed</p> : null
  }
  await act(async () => root.render(<ReloadedHome />))
  expect(container.textContent).toBe('Collapsed')
})

it('lets Settings restore the prompt box', async () => {
  setPromptBoxHidden(true)
  await act(async () => root.render(<GeneralSettings />))
  const settingsSwitch = '[role="switch"]#show-prompt-box'
  expect(container.querySelector(settingsSwitch)?.getAttribute('aria-checked')).toBe('false')
  await click(settingsSwitch)
  expect(container.querySelector(settingsSwitch)?.getAttribute('aria-checked')).toBe('true')
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('false')
  await render()
  expect(container.querySelector(composer)).not.toBeNull()
})

it('cannot collapse the prompt box during submission', async () => {
  await render(true)
  expect(container.querySelector<HTMLButtonElement>(collapseButton)?.disabled).toBe(true)
  await click(collapseButton)
  expect(container.querySelector(composer)).not.toBeNull()
  expect(container.querySelector(expandButton)).toBeNull()
  expect(localStorage.getItem(PROMPT_BOX_STORAGE_KEY)).toBe('false')
})
