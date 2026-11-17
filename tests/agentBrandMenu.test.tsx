// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AGENT_ROLES } from '../shared/agents'
import type { AgentTask, Canvas } from '../shared/types'

/**
 * The Agents-panel icon menu: who may change an outside agent's mark, which
 * choice reads as checked, what a pick writes, and what happens when the
 * write fails. The panel is the same one the prompt composer test drives.
 */

const mocks = vi.hoisted(() => ({
  listIdentities: vi.fn(),
  setIdentity: vi.fn(),
  addCard: vi.fn(() => Promise.resolve({})),
  agentAllowance: vi.fn(() => Promise.resolve({ used: 0, limit: 5, byoModel: false })),
  agentRunners: vi.fn(() => Promise.resolve({ runners: [] })),
  stopCard: vi.fn(() => Promise.resolve({})),
  retryCard: vi.fn(() => Promise.resolve({})),
}))
vi.mock('../src/lib/api', () => ({
  api: {
    listAgentIdentities: mocks.listIdentities,
    setAgentIdentity: mocks.setIdentity,
    addCard: mocks.addCard,
    agentAllowance: mocks.agentAllowance,
    agentRunners: mocks.agentRunners,
    stopCard: mocks.stopCard,
    retryCard: mocks.retryCard,
  },
  ApiError: class ApiError extends Error {},
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/me', () => ({
  useMe: () => ({ id: 'alice', name: 'Alice', admin: false, plan: 'free', billing: false }),
}))
vi.mock('../src/lib/frameClipboard', () => ({ uploadImageFrames: () => Promise.resolve([]) }))
vi.mock('../src/components/ChatPanel', () => ({ ChatPanel: () => null }))
vi.mock('../src/components/MemoryPanel', () => ({ MemoryPanel: () => null }))

const { useStore } = await import('../src/lib/store')
const { ActivityPanel } = await import('../src/components/ActivityPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const canvas = {
  id: 'c1',
  name: 'Canvas',
  frames: [],
  pages: [],
  /* the built-in team, so UX Lead is on the roster */
  team: AGENT_ROLES,
} as unknown as Canvas

function task(over: Pick<AgentTask, 'id' | 'agentName'> & Partial<AgentTask>): AgentTask {
  return {
    color: '#000000',
    status: 'Finished the hero',
    startedAt: Date.now() - 120_000,
    endedAt: Date.now() - 60_000,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let consoleError: MockInstance

async function render() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ActivityPanel canvasId="c1" onClose={() => {}} />
      </TooltipProvider>,
    ),
  )
}

const settle = () => act(async () => {})

/** Persons, agents and the ended stamp are already in place; the choices
 *  request resolves a microtask after mount, so settle before opening. */
const seed = (...tasks: AgentTask[]) => useStore.setState({ tasks })

const recent = () => {
  const section = container.querySelector<HTMLElement>('section[aria-label="Recent tasks"]')
  if (!section) throw new Error('recent tasks not rendered')
  return section
}

/** The row whose agent name is `agentName`, found by its name cell. */
function taskRow(agentName: string): HTMLElement {
  const name = [...recent().querySelectorAll('b')].find((b) => b.textContent === agentName)
  if (!name) throw new Error(`no task row for ${agentName}`)
  return name.closest<HTMLElement>('div')!
}

const trigger = () => {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Agent icon"]')
  if (!button) throw new Error('icon menu trigger not rendered')
  return button
}

/** Radix opens a menu on pointerdown, not click */
const open = () =>
  act(async () => {
    trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })

const radio = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) => el.textContent?.startsWith(label))

const pick = (label: string) =>
  act(async () => {
    const item = radio(label)
    if (!item) throw new Error(`no menu item ${label}`)
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    item.click()
  })

/** Radix unmounts a portal after its exit presence settles: poll rather than guess a delay. */
async function waitUntil(predicate: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the DOM')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  /* one account, one outside agent whose icon was pinned to Kimi */
  mocks.listIdentities.mockResolvedValue([{ agentName: 'Bau', brand: 'kimi' }])
  mocks.setIdentity.mockResolvedValue({ agentName: 'Bau', brand: 'claude' })
  useStore.setState({
    canvas,
    tasks: [],
    panelTab: 'tasks',
    composerFocusAt: 0,
    composerDrafts: {},
    composerSend: null,
    flyTo: null,
    selectedId: null,
    selectedElement: null,
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  consoleError.mockRestore()
})

describe('the Agents-panel icon menu', () => {
  /* The choices live in a module-level cache (one request per process), so
     the checked-state case runs before the picks below change it. */
  it('checks the choice its owner already made, and only that one', async () => {
    seed(task({ id: 't1', agentName: 'Bau', owner: 'Alice' }))
    await render()
    await settle()

    await open()
    expect(radio('Kimi')?.getAttribute('aria-checked')).toBe('true')
    expect(radio('Automatic')?.getAttribute('aria-checked')).toBe('false')
  })

  it('puts the menu on an outside agent the signed-in person connected, nowhere else', async () => {
    seed(
      task({ id: 't1', agentName: 'Bau', owner: 'Alice' }),
      task({ id: 't2', agentName: 'Nova', owner: 'Bob' }),
      task({ id: 't3', agentName: 'UX Lead', owner: 'Alice' }),
    )
    await render()
    await settle()

    expect(taskRow('Bau').querySelector('button[aria-label="Agent icon"]')).not.toBeNull()
    expect(taskRow('Nova').querySelector('button[aria-label="Agent icon"]')).toBeNull()
    expect(taskRow('UX Lead').querySelector('button[aria-label="Agent icon"]')).toBeNull()
  })

  it('writes the picked brand once and closes the menu', async () => {
    seed(task({ id: 't1', agentName: 'Bau', owner: 'Alice' }))
    await render()
    await settle()

    await open()
    await pick('Claude')
    expect(mocks.setIdentity).toHaveBeenCalledExactlyOnceWith('Bau', 'claude')
    await waitUntil(() => document.querySelector('[role="menu"]') === null)
  })

  it('sends null when the owner goes back to Automatic', async () => {
    mocks.setIdentity.mockResolvedValue({ agentName: 'Bau', brand: null })
    seed(task({ id: 't1', agentName: 'Bau', owner: 'Alice' }))
    await render()
    await settle()

    await open()
    await pick('Automatic')
    expect(mocks.setIdentity).toHaveBeenCalledExactlyOnceWith('Bau', null)
    await waitUntil(() => document.querySelector('[role="menu"]') === null)
  })

  it('keeps the menu open and says so when the write fails', async () => {
    mocks.setIdentity.mockRejectedValue(new Error('offline'))
    seed(task({ id: 't1', agentName: 'Bau', owner: 'Alice' }))
    await render()
    await settle()

    await open()
    await pick('DeepSeek')
    expect(mocks.setIdentity).toHaveBeenCalledExactlyOnceWith('Bau', 'deepseek')
    await waitUntil(
      () => document.querySelector('[role="status"]')?.textContent === 'Could not change the icon. Try again.',
    )
    /* still open, so the choice can be retried */
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })
})
