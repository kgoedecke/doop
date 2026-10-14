// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), capture: vi.fn() }))
vi.mock('../src/App', () => ({ navigate: mocks.navigate }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
vi.mock('../src/lib/store', () => ({
  useStore: (select: (s: { presences: Record<string, never> }) => unknown) => select({ presences: {} }),
}))
import { ConnectModal } from '../src/components/ConnectModal'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const onClose = vi.fn()
const buttons = () => Array.from(document.body.querySelectorAll('button'))
const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label)
const click = (label: string) =>
  act(async () => {
    const b = button(label)
    if (!b) throw new Error(`no button "${label}"`)
    b.click()
  })
const pickCard = (name: string) =>
  act(async () => {
    buttons()
      .find((b) => b.getAttribute('aria-pressed') !== null && b.textContent?.includes(name))!
      .click()
  })
const text = () => document.body.textContent ?? ''

const mount = async (canvasId?: string) => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<ConnectModal canvasId={canvasId} onClose={onClose} />))
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('opens on the agent picker and walks to an agent’s own steps and back', async () => {
  await mount('c1')
  expect(text()).toContain('Choose your agent')
  expect(text()).not.toContain('Connect your plan')
  expect(button('Connect →')).toBeDefined()

  await pickCard('Codex')
  await click('Connect →')
  expect(mocks.capture).toHaveBeenCalledWith('connect_ai_agent_chosen', { agent: 'codex' })
  expect(text()).toContain('Connect Codex')
  expect(text()).toContain(`codex mcp add doop --url ${location.origin}/mcp`)
  expect(text()).toContain('Work on Doop canvas c1.')
  expect(text()).toContain('listening for Codex')

  await click('Back')
  expect(text()).toContain('Choose your agent')
})

it('defaults to Claude Code and shows its command plus the sign-in step', async () => {
  await mount('c1')
  await click('Connect →')
  expect(text()).toContain('Connect Claude Code')
  expect(text()).toContain(`claude mcp add --transport http doop "${location.origin}/mcp"`)
  expect(text()).toContain('/mcp')
  await click('Done')
  expect(onClose).toHaveBeenCalledOnce()
})

it('keeps the headless agent-key path on the generic MCP screen and returns to the canvas from Settings', async () => {
  await mount('c1')
  await pickCard('Other MCP client')
  await click('Connect →')
  expect(text()).toContain('"mcpServers"')
  await click('Settings → Agent keys')
  expect(mocks.navigate).toHaveBeenCalledWith('/settings?pane=keys&from=%2Fc%2Fc1')
})

it('skips the canvas prompt and the arrival status when opened without a canvas', async () => {
  await mount()
  await click('Connect →')
  expect(text()).not.toContain('Work on Doop canvas')
  expect(text()).not.toContain('listening for')
  expect(text()).toContain('Open a canvas and tell the agent to work on it')
})
