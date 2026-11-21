// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ listBuiltInAgents: vi.fn(), listCustomAgents: vi.fn(), listSkills: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: mocks, errorMessage: () => 'failed' }))
import { CustomAgents } from '../src/components/CustomAgents'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  mocks.listBuiltInAgents.mockResolvedValue([])
  mocks.listCustomAgents.mockResolvedValue([])
  mocks.listSkills.mockReset().mockResolvedValue([
    { handle: 'brand-check', description: 'Brand voice', body: 'x', createdAt: 1, updatedAt: 1 },
    { handle: 'release-notes', description: 'Release notes tone', body: 'x', createdAt: 2, updatedAt: 2 },
  ])
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/* the form is a modal, portalled out of the host */
const instructions = () => document.querySelector<HTMLTextAreaElement>('textarea')
const options = () => [...document.querySelectorAll('[role=option]')].map((o) => o.textContent)

async function openNewAgentForm(workspaceId?: string) {
  await act(async () => root.render(<CustomAgents workspaceId={workspaceId} />))
  const add = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Add agent'))!
  await act(async () => add.click())
}

async function type(value: string) {
  const el = instructions()!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
    el.setSelectionRange(value.length, value.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string) {
  await act(async () => {
    instructions()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

it("lists the workspace's skills on '/' in Instructions, and Enter writes the handle", async () => {
  await openNewAgentForm('ws1')
  await type('always apply /br')
  expect(mocks.listSkills).toHaveBeenCalledWith('ws1')
  expect(options()).toEqual(['/brand-checkBrand voice'])
  await press('Enter')
  expect(instructions()!.value).toBe('always apply /brand-check ')
  expect(options()).toEqual([])
})

it('reads the personal skills for a personal team', async () => {
  await openNewAgentForm()
  await type('/')
  expect(mocks.listSkills).toHaveBeenCalledWith(undefined)
  expect(options()).toEqual(['/brand-checkBrand voice', '/release-notesRelease notes tone'])
})

it('Escape closes the skill menu first and the form only after', async () => {
  await openNewAgentForm('ws1')
  await type('always apply /br')
  expect(options()).toHaveLength(1)
  await press('Escape')
  expect(options()).toEqual([])
  expect(instructions()?.value).toBe('always apply /br')
  await press('Escape')
  expect(instructions()).toBeNull()
})
