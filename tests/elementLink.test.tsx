// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { elementLink, copyElementLink } from '../src/lib/elementLink'
import { useStore } from '../src/lib/store'
import { api } from '../src/lib/api'
import { LayersPanel } from '../src/components/LayersPanel'
import { TooltipProvider } from '../src/components/ui/tooltip'
import type { Frame } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'frame',
  canvasId: 'canvas',
  name: 'Frame',
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  html: '<main id="hero"><h1 id="title">Hello</h1></main>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'User',
}
const writeText = vi.fn().mockResolvedValue(undefined)
let root: Root | undefined
let container: HTMLDivElement | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
  writeText.mockClear()
  useStore.setState({ notice: null, selectedId: null, selectedIds: [], selectedElement: null, elementPanelOpen: false })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = undefined
  container?.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('names the element by its id, not by a selector', () => {
  const url = new URL(elementLink(frame, 'ab12cd'))
  expect(url.origin).toBe(location.origin)
  expect(url.pathname).toBe('/c/canvas')
  expect([...url.searchParams.keys()]).toEqual(['frame', 'element'])
  expect(url.searchParams.get('frame')).toBe(frame.id)
  expect(url.searchParams.get('element')).toBe('ab12cd')
  expect(url.hash).toBe('')
})

it('stamps the element first when it carries no id yet, vouching with the live excerpt', async () => {
  const stamp = vi.spyOn(api, 'ensureElementId').mockResolvedValue({ elementId: 'ab12cd' })
  await copyElementLink(frame, { selector: '#title', snippet: '<h1 id="title">Hello</h1>' })
  expect(stamp).toHaveBeenCalledWith(frame.id, '#title', '<h1 id="title">Hello</h1>')
  expect(writeText).toHaveBeenCalledWith(elementLink(frame, 'ab12cd'))
  expect(useStore.getState().notice?.text).toBe('Element link copied')
})

it('uses the id the element already wears without asking the server', async () => {
  const stamp = vi.spyOn(api, 'ensureElementId')
  await copyElementLink(frame, { selector: '#title', elementId: 'zz9900' })
  expect(stamp).not.toHaveBeenCalled()
  expect(writeText).toHaveBeenCalledWith(elementLink(frame, 'zz9900'))
})

it('reports a refused stamp without a false success or a rejected promise', async () => {
  vi.spyOn(api, 'ensureElementId').mockRejectedValueOnce(new Error('409'))
  await copyElementLink(frame, { selector: '#title' })
  expect(writeText).not.toHaveBeenCalled()
  expect(useStore.getState().notice?.text).toBe('Couldn’t copy the element link. Please try again.')
})

it('reports clipboard failure without a false success or a rejected promise', async () => {
  vi.spyOn(api, 'ensureElementId').mockResolvedValue({ elementId: 'ab12cd' })
  writeText.mockRejectedValueOnce(new Error('Permission denied'))
  await copyElementLink(frame, { selector: '#title' })
  expect(useStore.getState().notice?.text).toBe('Couldn’t copy the element link. Please try again.')
})

it('copies the right-clicked layer even when another element is selected', async () => {
  const stamp = vi.spyOn(api, 'ensureElementId').mockResolvedValue({ elementId: 'he4o00' })
  useStore.getState().setCanvas({ id: 'canvas', name: 'Canvas', frames: [frame], createdAt: 0, updatedAt: 0 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <LayersPanel onAddFrame={() => {}} />
      </TooltipProvider>,
    )
  })
  act(() => {
    useStore.getState().select(frame.id)
    useStore.getState().pickElement({ frameId: frame.id, selector: '#title' })
  })
  const row = container.querySelector<HTMLElement>('[data-row-key="frame|#hero"]')!
  expect(row).not.toBeNull()
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (el) => el.textContent === 'Copy link to element',
  )!
  expect(item).toBeDefined()
  await act(async () => item.click())
  /* a Layers row names the element from the saved HTML itself: nothing live to vouch */
  expect(stamp).toHaveBeenCalledWith(frame.id, '#hero', undefined)
  expect(writeText).toHaveBeenCalledWith(elementLink(frame, 'he4o00'))
  expect(useStore.getState().notice?.text).toBe('Element link copied')
})
