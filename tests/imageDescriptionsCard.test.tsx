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
  mocks.read
    .mockReset()
    .mockResolvedValue({ mode: 'account', describer: { label: 'Claude API (claude-haiku-4-5-20251001)' } })
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
  expect(button('My account').getAttribute('data-state')).toBe('on')
  expect(container.textContent).toContain('Images are described by Claude API (claude-haiku-4-5-20251001).')
  mocks.write.mockResolvedValue({ mode: 'server', describer: { label: null, reason: 'no-model' } })
  await act(async () => button('This server').click())
  expect(mocks.write).toHaveBeenCalledWith('server')
  expect(button('This server').getAttribute('data-state')).toBe('on')
  expect(container.textContent).toContain('This server has no model for descriptions')
})

it('explains an off switch', async () => {
  mocks.read.mockResolvedValue({ mode: 'off', describer: { label: null, reason: 'off' } })
  await act(async () => root.render(<ImageDescriptionsCard />))
  expect(button('Off').getAttribute('data-state')).toBe('on')
  expect(container.textContent).toContain('Images on your canvases are not described.')
})
