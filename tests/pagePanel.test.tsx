// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas } from '../shared/types'

const setPageBackground = vi.fn((_canvasId: string, _pageId: string, _color: string | null) => Promise.resolve([]))
vi.mock('../src/lib/api', () => ({
  api: { setPageBackground: (c: string, p: string, color: string | null) => setPageBackground(c, p, color) },
  ApiError: class extends Error {},
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { clearHistory, undo } = await import('../src/lib/history')
const { PagePanel } = await import('../src/components/PagePanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

const canvas: Canvas = {
  id: 'c1',
  name: 'Design',
  pages: [
    { id: 'p1', name: 'Home', background: '#1e1e1e' },
    { id: 'p2', name: 'Flows' },
  ],
  frames: [],
  createdAt: 0,
  updatedAt: 0,
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  clearHistory()
  useStore.getState().setCanvas(structuredClone(canvas))
  useStore.getState().setPagePanelOpen(true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = () =>
  act(() =>
    root.render(
      <TooltipProvider>
        <PagePanel />
      </TooltipProvider>,
    ),
  )
const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Background"]')!
const background = (id: string) => useStore.getState().canvas?.pages?.find((p) => p.id === id)?.background

it('shows the active page and its colour, and follows the page in view', async () => {
  await render()
  expect(host.textContent).toContain('Home')
  expect(field().value).toBe('#1e1e1e')
  await act(async () => useStore.getState().setActivePage('p2'))
  expect(host.textContent).toContain('Flows')
  expect(field().value).toBe('')
})

it('paints the page from a typed hex, clears it from an empty field, and undoes', async () => {
  await render()
  await act(async () => useStore.getState().setActivePage('p2'))
  await act(async () => {
    const input = field()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, 'ffd166')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  await vi.waitFor(() => expect(setPageBackground).toHaveBeenCalledWith('c1', 'p2', '#ffd166'))
  expect(background('p2')).toBe('#ffd166')
  await act(async () => {
    await undo()
  })
  expect(setPageBackground).toHaveBeenLastCalledWith('c1', 'p2', null)
  expect(background('p2')).toBeUndefined()
})

it('closes from its header', async () => {
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('header button')!.click())
  expect(useStore.getState().pagePanelOpen).toBe(false)
})
