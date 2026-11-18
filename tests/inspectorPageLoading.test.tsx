// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame, WireCanvas } from '../shared/types'
import { Inspector } from '../src/components/Inspector'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { api } from '../src/lib/api'
import { useStore } from '../src/lib/store'

/* A frame on a page this browser has not read (opened from Activity or a
   comment while its page loads) holds a blank copy here: the Inspector's HTML
   editor neither shows nor edits it, so no draft of it can be saved over the
   real document once the page arrives. */

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  pageId: 'second',
  name: 'Checkout',
  x: 0,
  y: 0,
  width: 760,
  height: 560,
  html: '<h1>The actual design</h1>',
  createdAt: 1,
  updatedAt: 10,
  updatedBy: 'Designer',
}
const { html: _html, ...meta } = frame
const pages = [
  { id: 'first', name: 'Main' },
  { id: 'second', name: 'Exploration' },
]
const wire: WireCanvas = { id: 'c', name: 'Canvas', pages, frames: [meta], createdAt: 1, updatedAt: 10 }

let root: Root
let container: HTMLDivElement

function Panel() {
  const current = useStore((s) => s.canvas?.frames[0])
  if (!current) return null
  return (
    <TooltipProvider>
      <Inspector frame={current} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.setItem('doop:inspector-html', '1')
  /* the room's init carried the first page only */
  useStore.getState().setCanvas(null)
  useStore.getState().setCanvas(wire, ['first'])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Panel />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('keeps the HTML of a frame whose page is loading out of reach, and saves no draft of it', async () => {
  const update = vi.spyOn(api, 'updateFrame').mockImplementation(async (id, patch) => ({ ...frame, ...patch, id }))
  const textarea = container.querySelector('textarea')!
  expect(textarea.readOnly).toBe(true)
  expect(textarea.value).toBe('')

  /* typing into it changes nothing, and the page arriving meanwhile saves nothing */
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, '<p>typed over a blank copy</p>')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => useStore.getState().setPageFrames('second', [frame]))
  await act(async () => vi.advanceTimersByTime(2000))
  expect(update).not.toHaveBeenCalled()
  expect(useStore.getState().canvas!.frames[0]!.html).toBe('<h1>The actual design</h1>')

  /* once here, the design shows and edits as before */
  const ready = container.querySelector('textarea')!
  expect(ready.readOnly).toBe(false)
  expect(ready.value).toBe('<h1>The actual design</h1>')
})

it('shows the real HTML when the page arrives while the field has focus, and saves no placeholder', async () => {
  const update = vi.spyOn(api, 'updateFrame').mockImplementation(async (id, patch) => ({ ...frame, ...patch, id }))
  const textarea = container.querySelector('textarea')!
  act(() => textarea.focus())
  expect(document.activeElement).toBe(textarea)

  act(() => useStore.getState().setPageFrames('second', [frame]))
  const ready = container.querySelector('textarea')!
  expect(ready.value).toBe('<h1>The actual design</h1>')

  /* a keystroke now edits the real design, never the blank copy */
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ready, '<h1>The actual design!</h1>')
    ready.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => vi.advanceTimersByTime(2000))
  expect(update).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledWith('f', { html: '<h1>The actual design!</h1>' })
})
