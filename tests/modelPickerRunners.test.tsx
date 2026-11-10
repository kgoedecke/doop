// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentRunners } from '../shared/agentRunner.ts'
const mocks = vi.hoisted(() => ({ runners: vi.fn(), models: vi.fn(), capture: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { agentRunners: mocks.runners, agentModels: mocks.models } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
vi.mock('../src/App', () => ({ navigate: vi.fn() }))
import { ModelPicker } from '../src/components/ModelPicker'
import { currentRunnerPick, RUNNER_PICK_KEY, useRunnerPick } from '../src/lib/runnerPick'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* Both connections at once: the shape the feedback came from, where the
   old picker showed only the GPT list while the Plan ran the task. */
const both: AgentRunners = {
  runners: [
    {
      provider: 'claude-local',
      name: 'Claude Plan',
      online: true,
      model: 'sonnet',
      models: [
        { id: 'opus', name: 'Opus', blurb: 'the big one' },
        { id: 'sonnet', name: 'Sonnet', blurb: 'the everyday one' },
      ],
      efforts: [
        { id: 'medium', name: 'Medium', blurb: '' },
        { id: 'max', name: 'Max', blurb: '' },
      ],
    },
    {
      provider: 'chatgpt',
      name: 'ChatGPT',
      email: 'alice@example.com',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      models: [{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', blurb: 'the workhorse' }],
      efforts: [{ id: 'medium', name: 'Medium', blurb: '' }],
    },
  ],
  default: 'claude-local',
}

let root: Root
let container: HTMLDivElement
const trigger = () => container.querySelector('button')!
const open = () =>
  act(() => {
    /* Radix opens a menu on pointerdown, not click */
    trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
const radio = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) => el.textContent?.startsWith(label))
const pickItem = (label: string) =>
  act(() => {
    const item = radio(label)!
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    item.click()
  })
const settle = () => act(async () => {})

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  useRunnerPick.setState({ stored: null, runners: null })
  mocks.runners.mockResolvedValue(both)
  mocks.models.mockResolvedValue({ models: [], live: false })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows the default connection’s model on the trigger and every connection in the menu', async () => {
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(trigger().textContent).toBe('Sonnet')
  expect(trigger().getAttribute('aria-label')).toBe('Model: Sonnet')
  await open()
  const text = document.body.textContent ?? ''
  /* several connections: each group is its provider's name, nothing more */
  expect(text).toContain('Claude Plan')
  expect(text).toContain('ChatGPT')
  expect(text).not.toContain('alice@example.com')
  expect(text).not.toContain('· default')
  expect(radio('Opus')).toBeTruthy()
  expect(radio('GPT-5.6 Terra')).toBeTruthy()
  expect(radio('Sonnet')?.getAttribute('aria-checked')).toBe('true')
})

it('sends the next task to the picked connection and remembers it in this browser', async () => {
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  await pickItem('GPT-5.6 Terra')
  /* the effort reads after the model, in a lighter span */
  expect(trigger().textContent).toBe('GPT-5.6 TerraMedium')
  expect(currentRunnerPick()).toEqual({ provider: 'chatgpt', model: 'gpt-5.6-terra', effort: 'medium' })
  expect(JSON.parse(localStorage.getItem(RUNNER_PICK_KEY)!)).toEqual({
    provider: 'chatgpt',
    model: 'gpt-5.6-terra',
    effort: 'medium',
  })
  expect(mocks.capture).toHaveBeenCalledWith('agent_runner_picked', {
    provider: 'chatgpt',
    model: 'gpt-5.6-terra',
    via: 'composer',
  })
})

it('keeps a stored pick for the Plan with its effort, and shows the dial', async () => {
  useRunnerPick.setState({ stored: { provider: 'claude-local', model: 'opus', effort: 'max' } })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(trigger().textContent).toBe('OpusMax')
  expect(trigger().getAttribute('aria-label')).toBe('Model: Opus')
  expect(currentRunnerPick()).toEqual({ provider: 'claude-local', model: 'opus', effort: 'max' })
  await open()
  /* effort is a stepped slider under the models, naming its level */
  const slider = document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Reasoning effort"]')
  expect(slider?.getAttribute('aria-valuetext')).toBe('Max')
})

it('falls back to the default when the stored connection is gone', async () => {
  useRunnerPick.setState({ stored: { provider: 'chatgpt', model: 'gpt-5.6-terra' } })
  mocks.runners.mockResolvedValue({ runners: [both.runners[0]!], default: 'claude-local' })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(trigger().textContent).toBe('Sonnet')
  expect(currentRunnerPick()).toEqual({ provider: 'claude-local', model: 'sonnet' })
})

it('says so with nothing connected, and carries no pick', async () => {
  mocks.runners.mockResolvedValue({ runners: [] })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(trigger().textContent).toBe('Doop Agent')
  expect(currentRunnerPick()).toBeUndefined()
  await open()
  expect(document.body.textContent).toContain('Nothing connected yet')
  expect(document.body.textContent).toContain('Connect a model…')
})
