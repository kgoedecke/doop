// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  capture: vi.fn(),
  native: false,
  desktop: false,
  addToDesktop: vi.fn(),
}))
vi.mock('../src/lib/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/shell')>()),
  isDesktopShell: () => mocks.desktop,
}))
vi.mock('../src/lib/claudeConnection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/claudeConnection')>()),
  canAddToClaudeDesktop: () => mocks.native,
  addToClaudeDesktop: mocks.addToDesktop,
}))
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
/* a row on the picker opens that agent's steps */
const pickAgent = (name: string) =>
  act(async () => {
    buttons()
      .find((b) => b.dataset.slot === 'choice-row' && b.textContent?.includes(name))!
      .click()
  })
const text = () => document.body.textContent ?? ''

const mount = async (canvasId?: string) => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<ConnectModal canvasId={canvasId} onClose={onClose} />))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.native = false
  mocks.desktop = false
  vi.stubGlobal('location', new URL('http://localhost:4301'))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('opens on the agent picker and walks to an agent’s own steps and back', async () => {
  await mount('c1')
  expect(text()).toContain('Choose your agent')
  expect(text()).not.toContain('Connect your plan')
  expect(buttons().filter((b) => b.dataset.slot === 'choice-row')).toHaveLength(7)

  await pickAgent('Codex')
  expect(mocks.capture).toHaveBeenCalledWith('connect_ai_agent_chosen', { agent: 'codex' })
  expect(text()).toContain('Connect Codex')
  expect(text()).toContain(`codex mcp add doop --url ${location.origin}/mcp`)
  expect(text()).toContain('Work on Doop canvas c1.')
  expect(text()).toContain('listening for Codex')

  await click('Back')
  expect(text()).toContain('Choose your agent')
})

it('shows Claude Code’s command plus the sign-in step', async () => {
  await mount('c1')
  await pickAgent('Claude Code')
  expect(text()).toContain('Connect Claude Code')
  expect(text()).toContain(`claude mcp add --transport http doop "${location.origin}/mcp"`)
  expect(text()).toContain('/mcp')
  await click('Done')
  expect(onClose).toHaveBeenCalledOnce()
})

it('switches the generic MCP screen between browser sign-in and an agent key', async () => {
  await mount('c1')
  await pickAgent('Other MCP client')
  expect(button('Sign in with a browser')?.getAttribute('aria-pressed')).toBe('true')
  expect(text()).toContain('"mcpServers"')
  expect(text()).not.toContain('Bearer dpk_')

  await click('Agent key (headless)')
  expect(text()).toContain('"Authorization": "Bearer dpk_…"')
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  await click('Open Settings → Agent keys')
  expect(open).toHaveBeenCalledWith('/settings?pane=keys', '_blank', 'noopener')
  expect(mocks.navigate).not.toHaveBeenCalled()
})

it('opens Agent keys in place in the desktop app, coming back to the canvas', async () => {
  mocks.desktop = true
  await mount('c1')
  await pickAgent('Headless agent or server')
  await click('Open Settings → Agent keys')
  expect(mocks.navigate).toHaveBeenCalledWith('/settings?pane=keys&from=%2Fc%2Fc1')
})

it('lists automations as their own agent, straight to the agent-key steps', async () => {
  await mount('c1')
  await pickAgent('Headless agent or server')
  expect(text()).toContain('Connect Headless agent or server')
  expect(text()).toContain('"Authorization": "Bearer dpk_…"')
  expect(button('Sign in with a browser')).toBeUndefined()
  expect(text()).toContain('Work on Doop canvas c1.')
})

it('skips the canvas prompt and the arrival status when opened without a canvas', async () => {
  await mount()
  await pickAgent('Claude Code')
  expect(text()).not.toContain('Work on Doop canvas')
  expect(text()).not.toContain('listening for')
  expect(text()).toContain('Open a canvas and tell the agent to work on it')
})

it('explains the local desktop path and keeps file installation as a collapsed fallback', async () => {
  await mount('desktop-canvas')
  await pickAgent('Add Doop to Claude')
  expect(button('Desktop app')?.getAttribute('aria-pressed')).toBe('true')
  const download = document.querySelector<HTMLAnchorElement>('a[download="doop.mcpb"]')
  expect(download?.getAttribute('href')).toBe('/claude-extension/doop.mcpb')
  expect(download?.closest('[data-slot="disclosure"] > [data-state]')?.getAttribute('data-state')).toBe('closed')
  expect(text()).toContain('Doop server URL')
  expect(text()).toContain(`${location.origin}/mcp`)
  expect(text()).toContain('Work on Doop canvas desktop-canvas.')
  expect(text()).toContain('Install Extension')

  await click('Connect online')
  expect(document.querySelector('a[download]')).toBeNull()
  expect(text()).toContain('publicly reachable HTTPS server')
  expect(document.querySelector('a[href*="claude.ai"]')).toBeNull()
  await click('Desktop app')
  expect(document.querySelector('a[download="doop.mcpb"]')).not.toBeNull()
})

it('defaults to a prefilled Add to Claude link on hosted Doop, without a download', async () => {
  vi.stubGlobal('location', new URL('https://design.example.com'))
  await mount('hosted-canvas')
  await pickAgent('Add Doop to Claude')
  expect(button('Connect online')?.getAttribute('aria-pressed')).toBe('true')
  const link = document.querySelector<HTMLAnchorElement>('a[href*="claude.ai"]')!
  const url = new URL(link.href)
  expect(link.textContent).toBe('Add to Claude')
  expect(url.searchParams.get('modal')).toBe('add-custom-connector')
  expect(url.searchParams.get('connectorUrl')).toBe('https://design.example.com/mcp')
  expect(document.querySelector('a[download]')).toBeNull()
  expect(text()).toContain('Work on Doop canvas hosted-canvas.')
})

it('opens Claude directly in a capable shell and waits for Claude’s confirmation', async () => {
  mocks.native = true
  let finish!: () => void
  mocks.addToDesktop.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await mount('local-canvas')
  await pickAgent('Add Doop to Claude')
  await click('Add to Claude')
  expect(button('Opening Claude…')?.disabled).toBe(true)
  expect(mocks.addToDesktop).toHaveBeenCalledExactlyOnceWith('http://localhost:4301/mcp')
  await act(async () => finish())
  expect(text()).toContain('Confirm the installation in Claude')
  expect(text()).not.toContain('is here — it worked')
})

it('shows native handoff errors and allows retry', async () => {
  mocks.native = true
  mocks.addToDesktop.mockRejectedValue(new Error('Install Claude Desktop first.'))
  await mount()
  await pickAgent('Add Doop to Claude')
  await click('Add to Claude')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Install Claude Desktop first.')
  expect(button('Add to Claude')?.disabled).toBe(false)
})

// Decode the actual rendered install link to catch a wrong config envelope or endpoint.
it.each(['https://doop.design', 'http://localhost:4301'])(
  'offers an Add to Cursor link for %s with a manual fallback and canvas prompt',
  async (origin) => {
    vi.stubGlobal('location', new URL(origin))
    await mount('cursor-canvas')
    await pickAgent('Cursor')

    const link = Array.from(document.body.querySelectorAll('a')).find((a) => a.textContent === 'Add to Cursor')!
    const installUrl = new URL(link.href)
    expect(installUrl.protocol).toBe('cursor:')
    expect(installUrl.host).toBe('anysphere.cursor-deeplink')
    expect(installUrl.pathname).toBe('/mcp/install')
    expect(installUrl.searchParams.get('name')).toBe('doop')
    expect(JSON.parse(atob(installUrl.searchParams.get('config')!))).toEqual({ url: `${origin}/mcp` })
    expect(document.querySelector('[data-slot="collapsible-trigger"]')?.getAttribute('aria-expanded')).toBe('false')
    expect(text()).toContain('keeping any existing servers')
    expect(text()).toContain('Work on Doop canvas cursor-canvas.')
    expect(text()).toContain('listening for Cursor')
    expect(text()).not.toContain('it worked')
    expect(document.querySelector('a[download]')).toBeNull()
  },
)
