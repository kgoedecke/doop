// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { imageDescriptions: mocks.read, setImageDescriptions: mocks.write } }))
vi.mock('../src/lib/store', () => ({
  useStore: (select: (s: { allowanceVersion: number }) => unknown) => select({ allowanceVersion: 0 }),
}))
import { ImageDescriptionsCard } from '../src/components/ImageDescriptionsCard'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue({
    mode: 'account',
    describer: { label: 'Claude API (claude-haiku-4-5-20251001)' },
    paidBy: 'account',
  })
  mocks.write.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows the mode and the model that would run, and saves a pick', async () => {
  await act(async () => root.render(<ImageDescriptionsCard />))
  expect(button('My model').getAttribute('data-state')).toBe('on')
  expect(container.textContent).toContain('Ready: Claude API (claude-haiku-4-5-20251001)')
  expect(container.textContent).toContain('Runs on your connected account')
  mocks.write.mockResolvedValue({ mode: 'server', describer: { label: null, reason: 'no-model' }, paidBy: null })
  await act(async () => button('Server model').click())
  expect(mocks.write).toHaveBeenCalledWith('server')
  expect(button('Server model').getAttribute('data-state')).toBe('on')
  expect(container.textContent).toContain('No model is available for this.')
})

it('explains an off switch', async () => {
  mocks.read.mockResolvedValue({ mode: 'off', describer: { label: null, reason: 'off' }, paidBy: null })
  await act(async () => root.render(<ImageDescriptionsCard />))
  expect(button('Off').getAttribute('data-state')).toBe('on')
  expect(container.textContent).toContain('Your uploads and images on canvases you own are not described.')
})

it('says when My model falls back to the server, which pays', async () => {
  mocks.read.mockResolvedValue({ mode: 'account', describer: { label: 'Doop (haiku)' }, paidBy: 'server' })
  await act(async () => root.render(<ImageDescriptionsCard />))
  expect(container.textContent).toContain('Ready: Doop (haiku)')
  expect(container.textContent).toContain('your account is not charged')
  expect(container.textContent).not.toContain('Runs on your connected account')
})
