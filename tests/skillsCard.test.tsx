// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ listSkills: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { listSkills: mocks.listSkills }, errorMessage: () => 'failed' }))
import { Skills } from '../src/components/Skills'
import { MAX_SKILLS, type Skill } from '../shared/skills'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const skill = (i: number): Skill => ({
  handle: `skill-${i}`,
  description: `Skill ${i}`,
  body: 'x'.repeat(20),
  createdAt: i,
  updatedAt: i,
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  /* the composer's "New skill" lands here */
  history.replaceState(null, '', '/w/ws1?pane=agents&skill=new')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const formOpen = () => document.body.textContent?.includes('Handle') ?? false

it('opens the create form from ?skill=new once the list shows there is room', async () => {
  let answer: (list: Skill[]) => void = () => {}
  mocks.listSkills.mockReturnValue(new Promise((resolve) => (answer = resolve)))
  await act(async () => root.render(<Skills workspaceId="ws1" />))
  /* not before the list is known */
  expect(formOpen()).toBe(false)
  await act(async () => answer([skill(1)]))
  expect(formOpen()).toBe(true)
  /* opened once: a reload or Back does not open it again */
  expect(location.search).toBe('?pane=agents')
})

it('keeps the form shut on a full scope and says why', async () => {
  mocks.listSkills.mockResolvedValue(Array.from({ length: MAX_SKILLS }, (_, i) => skill(i)))
  await act(async () => root.render(<Skills workspaceId="ws1" />))
  expect(formOpen()).toBe(false)
  expect(host.textContent).toContain(`There is room for ${MAX_SKILLS} skills`)
})

it('keeps a typed "/" in the handle and adds one when it is left out', async () => {
  mocks.listSkills.mockResolvedValue([])
  await act(async () => root.render(<Skills workspaceId="ws1" />))
  const field = document.querySelector<HTMLInputElement>('input[placeholder="/brand-check"]')!
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  type('/')
  expect(field.value).toBe('/')
  type('/Brand check')
  expect(field.value).toBe('/brandcheck')
  type('')
  type('brand-check')
  expect(field.value).toBe('/brand-check')
})
