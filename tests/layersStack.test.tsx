// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

type StackWrite = { id: string; z: number }
const restackFrames = vi.fn((_canvasId: string, _frames: StackWrite[]) => Promise.resolve([]))
const createFrame = vi.fn((canvasId: string, input: Partial<Frame> & { name: string }) =>
  Promise.resolve({ ...frameWith('new', 9), canvasId, ...input } as Frame),
)
vi.mock('../src/lib/api', () => ({
  api: {
    restackFrames: (canvasId: string, frames: StackWrite[]) => restackFrames(canvasId, frames),
    createFrame: (canvasId: string, input: Partial<Frame> & { name: string }) => createFrame(canvasId, input),
    updateFrame: () => Promise.resolve(),
    deleteFrame: () => Promise.resolve(),
  },
  ApiError: class extends Error {},
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: () => Promise.resolve(null),
  inspectElement: () => Promise.resolve({ rect: { x: 5, y: 5, width: 40, height: 20 } }),
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
    restackFrames.mockClear()
    restackFrames.mockImplementation(() => Promise.resolve([]))
    createFrame.mockClear()
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
    expect(restackFrames).toHaveBeenCalledTimes(1)
    expect(restackFrames.mock.calls[0]?.[1].map((w) => w.id)).toEqual(['f1'])
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
    expect(restackFrames).not.toHaveBeenCalled()
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

  it('leaves a locked frame or shape where it is', () => {
    act(() => useStore.getState().patchFrameLocal('f1', { locked: true }))
    dragRow('f1', 's1', 2)
    const lockedShape = shape.replace('data-doop-drawing="rect"', 'data-doop-drawing="rect" data-doop-locked=""')
    act(() => useStore.getState().patchFrameLocal('s1', { html: lockedShape }))
    act(() => useStore.getState().select('s1'))
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!
    act(() => {
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    })
    expect(stack()).toEqual(['f1', 'f2', 's1'])
    expect(restackFrames).not.toHaveBeenCalled()
  })

  it('puts the whole order back when a renumbering save fails', async () => {
    restackFrames.mockImplementation(() => Promise.reject(new Error('nope')))
    /* f2 and s1 so close that nothing fits between them */
    act(() => {
      useStore.getState().patchFrameLocal('f2', { z: 1_700_000_000_000 })
      useStore.getState().patchFrameLocal('s1', { z: 1_700_000_000_000 + 2 ** -12 })
    })
    dragRow('f1', 's1', 26)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(restackFrames.mock.calls[0]?.[1]).toHaveLength(3)
    expect(stack()).toEqual(['f1', 'f2', 's1'])
  })

  it('renumbers the page before an element dropped into a full gap comes out', async () => {
    /* f1 and f2 so close that nothing fits between them, s1 in front */
    act(() => {
      useStore.getState().patchFrameLocal('f1', { z: 1_700_000_000_000 })
      useStore.getState().patchFrameLocal('f2', { z: 1_700_000_000_000 + 2 ** -12 })
      useStore.getState().patchFrameLocal('s1', { z: 1_700_000_000_001 })
    })
    /* f2's paragraph onto the band above f1's row: between f1 and f2 */
    act(() => row('f2').querySelector<HTMLElement>('[data-icon]')!.click())
    dragRow('f2|body', 'f1', 2)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(restackFrames).toHaveBeenCalledTimes(1)
    /* the element comes out where the line was: between f1 and f2 */
    expect(stack()).toEqual(['f1', 'new', 'f2', 's1'])
    expect(createFrame.mock.calls[0]?.[1].z).toBe(0.5)
    /* one undo takes the element back in and the renumbering with it, so
       every frame has the `z` it had before the drop */
    await act(async () => {
      await undo()
    })
    expect(stack()).toEqual(['f1', 'f2', 's1'])
    expect(useStore.getState().canvas?.frames.map((f) => [f.id, f.z])).toEqual([
      ['f1', 1_700_000_000_000],
      ['f2', 1_700_000_000_000 + 2 ** -12],
      ['s1', 1_700_000_000_001],
    ])
    expect(restackFrames).toHaveBeenCalledTimes(2)
  })
})
