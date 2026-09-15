// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

const updateFrame = vi.fn(() => Promise.resolve())
const deleteFrame = vi.fn(() => Promise.resolve())
vi.mock('../src/lib/api', () => ({
  api: { updateFrame: () => updateFrame(), deleteFrame: () => deleteFrame() },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { LayersPanel } = await import('../src/components/LayersPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

const frame: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'Frame',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '<!doctype html><html><head></head><body><div><p>A</p></div></body></html>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
const DIV = 'body:nth-of-type(1) > div:nth-of-type(1)'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
/* stands in for the canvas page's window-level ⌫ shortcut, which deletes the
   selected frames when a keydown reaches it */
const reachedWindow = vi.fn()

function pressDelete() {
  const tree = container.querySelector<HTMLElement>('[tabindex="0"]')
  if (!tree) throw new Error('layers tree not rendered')
  act(() => {
    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
  })
}

describe('LayersPanel ⌫', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    deleteFrame.mockClear()
    reachedWindow.mockClear()
    window.addEventListener('keydown', reachedWindow)
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [frame] } as Canvas
    useStore.setState({ canvas, selectedId: 'f1', selectedIds: ['f1'], selectedElement: null })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <TooltipProvider>
          <LayersPanel onAddFrame={() => {}} />
        </TooltipProvider>,
      ),
    )
  })

  afterEach(() => {
    window.removeEventListener('keydown', reachedWindow)
    act(() => root.unmount())
    container.remove()
  })

  it('deletes only the selected element, never the frame it lives in', () => {
    act(() => useStore.getState().pickElement({ frameId: 'f1', selector: DIV }))
    pressDelete()
    expect(useStore.getState().canvas?.frames[0]?.html).not.toContain('<div>')
    expect(updateFrame).toHaveBeenCalledTimes(1)
    expect(deleteFrame).not.toHaveBeenCalled()
    expect(reachedWindow).not.toHaveBeenCalled()
  })

  it('deletes a selected frame once, without handing the key to the canvas shortcut', () => {
    pressDelete()
    expect(deleteFrame).toHaveBeenCalledTimes(1)
    expect(reachedWindow).not.toHaveBeenCalled()
  })
})
