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

const { pickedSelectors, useStore } = await import('../src/lib/store')
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
  const tree = container.querySelector<HTMLElement>('[role="tree"]')
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
    /* setCanvas also picks the active page; the panel lists that page's frames */
    useStore.getState().setCanvas(canvas)
    useStore.setState({ selectedId: 'f1', selectedIds: ['f1'], selectedElement: null })
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

  it('leaves ↵ on a focused lock button to the button, not to the tree', () => {
    const lock = container.querySelector<HTMLButtonElement>('button[aria-label="Lock"]')
    if (!lock) throw new Error('lock button not rendered')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      lock.dispatchEvent(enter)
    })
    /* the tree's ↵ flies to the frame and prevents the default — which would
       have been the button's click */
    expect(enter.defaultPrevented).toBe(false)
    expect(useStore.getState().flyTo).toBeNull()
    act(() => lock.click())
    expect(updateFrame).toHaveBeenCalledTimes(1)
    expect(useStore.getState().canvas?.frames[0]?.locked).toBe(true)
  })

  it('highlights every picked row, toggles with ⇧, and narrows to the row on a plain click', () => {
    const P = `${DIV} > p:nth-of-type(1)`
    const row = (selector: string) => container.querySelector<HTMLElement>(`[data-row-key="f1|${selector}"]`)!
    const picked = () => pickedSelectors(useStore.getState())
    /* picking the paragraph opens its parent's row */
    act(() => useStore.getState().pickElement({ frameId: 'f1', selector: P }))
    act(() => row(DIV).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
    expect(picked()).toEqual([P, DIV])
    expect(row(DIV).getAttribute('aria-selected')).toBe('true')
    expect(row(P).getAttribute('aria-selected')).toBe('true')
    /* a plain click on the primary row narrows too, not just one on another row */
    act(() => row(DIV).click())
    expect(picked()).toEqual([DIV])
    expect(row(P).getAttribute('aria-selected')).toBe('false')
  })
})
