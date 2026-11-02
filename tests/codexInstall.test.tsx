// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), capture: vi.fn(), invoke: vi.fn() }))
vi.mock('../src/App', () => ({ navigate: mocks.navigate }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
vi.mock('../src/lib/store', () => ({
  useStore: (select: (s: { presences: Record<string, never> }) => unknown) => select({ presences: {} }),
}))
import { ConnectModal } from '../src/components/ConnectModal'
import { DesktopCodexSetup } from '../src/pages/DesktopCodexSetup'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
const text = () => document.body.textContent ?? ''

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('location', new URL('https://doop.design'))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount() {
  await act(async () => root.render(<ConnectModal initialAgent="codex" canvasId="canvas-1" onClose={vi.fn()} />))
}

function native() {
  vi.stubGlobal('__DOOP_DESKTOP__', '0.4.0')
  vi.stubGlobal('__DOOP_CODEX_SETUP__', true)
  vi.stubGlobal('__TAURI__', { core: { invoke: mocks.invoke } })
}

it('opens the desktop setup from the browser and keeps the manual command available', async () => {
  await mount()
  const link = Array.from(document.body.querySelectorAll('a')).find(
    (a) => a.textContent?.trim() === 'Open Doop Desktop',
  )!
  expect(link.getAttribute('href')).toBe('doop://connect/codex?origin=https%3A%2F%2Fdoop.design&canvas=canvas-1')
  expect(document.querySelector('[data-slot="collapsible-trigger"]')?.getAttribute('aria-expanded')).toBe('false')
  expect(text()).toContain('codex mcp add doop --url https://doop.design/mcp')
  expect(text()).toContain('codex mcp login doop')
  expect(document.querySelector('a[download]')).toBeNull()
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it('waits for successful native setup before displaying configured, without claiming agent presence', async () => {
  native()
  let finish!: () => void
  mocks.invoke.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    }),
  )
  await mount()
  await act(async () => button('Add to Codex')!.click())
  expect(button('Adding Doop…')?.disabled).toBe(true)
  expect(text()).not.toContain('Doop is configured')
  await act(async () => finish())
  expect(button('Added to Codex')?.disabled).toBe(true)
  expect(text()).toContain('Doop is configured')
  expect(text()).toContain('listening for Codex')
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('codex_add_mcp')
})

it('shows a native config conflict and permits retry', async () => {
  native()
  mocks.invoke.mockRejectedValueOnce('Codex already has a different doop connection.')
  await mount()
  await act(async () => button('Add to Codex')!.click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('different doop connection')
  expect(text()).not.toContain('Doop is configured')
  mocks.invoke.mockResolvedValueOnce(undefined)
  await act(async () => button('Add to Codex')!.click())
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(text()).toContain('Doop is configured')
})

it('offers an update hint in older desktop shells instead of a broken command', async () => {
  vi.stubGlobal('__DOOP_DESKTOP__', '0.3.0')
  await mount()
  expect(text()).toContain('Update Doop Desktop')
  expect(button('Add to Codex')).toBeUndefined()
  expect(document.querySelector('a[href^="doop:"]')).toBeNull()
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it('opens a matching handoff as a review screen and requires a click to write config', async () => {
  native()
  vi.stubGlobal(
    'location',
    new URL('https://doop.design/desktop/connect/codex?origin=https%3A%2F%2Fdoop.design&canvas=from-browser'),
  )
  await act(async () => root.render(<DesktopCodexSetup />))
  expect(button('Add to Codex')).toBeDefined()
  expect(text()).toContain('Work on Doop canvas from-browser.')
  expect(text()).not.toContain('listening for')
  expect(mocks.invoke).not.toHaveBeenCalled()
  await act(async () => button('Done')!.click())
  expect(mocks.navigate).toHaveBeenCalledWith('/c/from-browser')
})

it('rejects a different server handoff without offering an installation button', async () => {
  native()
  vi.stubGlobal('location', new URL('https://doop.design/desktop/connect/codex?origin=http%3A%2F%2Flocalhost%3A4301'))
  await act(async () => root.render(<DesktopCodexSetup />))
  expect(text()).toContain('Open the matching Doop server')
  expect(button('Add to Codex')).toBeUndefined()
  expect(mocks.invoke).not.toHaveBeenCalled()
})
