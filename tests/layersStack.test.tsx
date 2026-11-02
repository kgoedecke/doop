// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

const updateFrame = vi.fn((_id: string, _patch: Partial<Frame>) => Promise.resolve())
vi.mock('../src/lib/api', () => ({
  api: {
    updateFrame: (id: string, patch: Partial<Frame>) => updateFrame(id, patch),
    deleteFrame: () => Promise.resolve(),
  },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: () => Promise.resolve(null),
  settleFrames: () => Promise.resolve(),
}))

const { useStore } = await import('../src/lib/store')
const { undo } = await import('../src/lib/history')
const { LayersPanel } = await import('../src/components/LayersPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

const page = (body: string) => `<!doctype html>\n<html><head></head><body>${body}</body></html>`

function frameWith(id: string, createdAt: number, html = page('<p>x</p>')): Frame {
  return {
    id,
    canvasId: 'c1',
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html,
    createdAt,
    updatedAt: 0,
    updatedBy: 'me',
  }
}

const shape = page('<div data-doop-drawing="rect" style="position:absolute">x</div>').replace(
  '<body>',
  '<body data-doop-canvas-element="true">',
)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

/* back to front, as the stage paints them */
const stack = () => useStore.getState().canvas?.frames.map((f) => f.id)
/* top to bottom, as the panel lists the top-level rows */
const listed = () =>
  [...container.querySelectorAll<HTMLElement>('[data-row-key]')].map((el) => el.dataset.rowKey!.split('|')[0])

const row = (key: string) => {
  const el = [...container.querySelectorAll<HTMLElement>('[data-row-key]')].find((r) =>
    r.dataset.rowKey!.startsWith(key),
  )
  if (!el) throw new Error(`row ${key} not rendered`)
  return el
}

/* happy-dom has no layout: the row under the pointer is whichever one the
   test names, and every row is 28px tall at y 0 */
function dragRow(from: string, to: string | null, atY = 14) {
  const target = to ? row(to) : container.querySelector<HTMLElement>('[data-slot="panel-body"]')!
  document.elementFromPoint = () => target
  target.getBoundingClientRect = () => ({ top: 0, height: 28 }) as DOMRect
  act(() => {
    row(from).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: atY }))
  })
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: atY }))
  })
}

describe('LayersPanel stacking', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    const canvas: Canvas = {
      id: 'c1',
      name: 'Canvas',
      frames: [frameWith('f1', 1), frameWith('f2', 2), { ...frameWith('s1', 3, shape), name: 'Rectangle' }],
    } as Canvas
    useStore.getState().setCanvas(canvas)
    useStore.setState({ selectedId: null, selectedIds: [], selectedElement: null })
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
    act(() => root.unmount())
    container.remove()
  })

  it('lists the frame in front at the top', () => {
    expect(stack()).toEqual(['f1', 'f2', 's1'])
    expect(listed()).toEqual(['s1', 'f2', 'f1'])
  })

  it('brings a frame dragged above the top row to the front', () => {
    dragRow('f1', 's1', 2)
    expect(stack()).toEqual(['f2', 's1', 'f1'])
    expect(listed()).toEqual(['f1', 's1', 'f2'])
    expect(updateFrame).toHaveBeenCalledTimes(1)
    expect(updateFrame.mock.calls[0]?.[0]).toBe('f1')
  })

  it('sends a standalone element dragged under the last row to the back', () => {
    dragRow('s1', 'f1', 26)
    expect(stack()).toEqual(['s1', 'f1', 'f2'])
  })

  it('sends a frame dropped on the list’s empty tail to the back', () => {
    dragRow('f2', null)
    expect(stack()).toEqual(['f2', 'f1', 's1'])
  })

  it('leaves a frame dropped next to itself where it is', () => {
    dragRow('f2', 'f2', 2)
    dragRow('f2', 'f1', 2)
    expect(stack()).toEqual(['f1', 'f2', 's1'])
    expect(updateFrame).not.toHaveBeenCalled()
  })

  it('moves the selected frame with ⌥↑ and ⌥↓, and undoes the move', async () => {
    act(() => useStore.getState().select('f1'))
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!
    const press = (key: string) =>
      act(() => {
        tree.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }))
      })
    press('ArrowUp')
    expect(stack()).toEqual(['f2', 'f1', 's1'])
    press('ArrowUp')
    expect(stack()).toEqual(['f2', 's1', 'f1'])
    press('ArrowDown')
    expect(stack()).toEqual(['f2', 'f1', 's1'])
    await act(async () => {
      undo()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(stack()).toEqual(['f2', 's1', 'f1'])
  })
})
