// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

type StackWrite = { id: string; z: number }
const restackFrames = vi.fn((_canvasId: string, _frames: StackWrite[]) => Promise.resolve([]))
const updateFrame = vi.fn((_id: string, _patch: unknown, _expected?: number) => Promise.resolve())
const deleteFrame = vi.fn((_id: string, _expected?: number) => Promise.resolve())
vi.mock('../src/lib/api', () => ({
  api: {
    /* the Components tab's dot asks; nothing waits in these tests */
    canvasLibrary: () => new Promise(() => {}),
    restackFrames: (canvasId: string, frames: StackWrite[]) => restackFrames(canvasId, frames),
    createFrame: () => new Promise(() => {}),
    updateFrame: (id: string, patch: unknown, expected?: number) => updateFrame(id, patch, expected),
    deleteFrame: (id: string, expected?: number) => deleteFrame(id, expected),
  },
  ApiError: class extends Error {},
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: () => Promise.resolve(null),
  inspectElement: () => Promise.resolve({ rect: { x: 5, y: 5, width: 40, height: 20 } }),
  layerPlacement: () => Promise.resolve(undefined),
  settleFrames: () => Promise.resolve(),
}))

const { useStore, pickedSelectors } = await import('../src/lib/store')
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

const shape = (text: string) =>
  page(`<div data-doop-drawing="rect" style="position:absolute">${text}</div>`).replace(
    '<body>',
    '<body data-doop-canvas-element="true">',
  )

const PA = 'body:nth-of-type(1) > p:nth-of-type(1)'
const IT = 'body:nth-of-type(1) > i:nth-of-type(1)'
const PB = 'body:nth-of-type(1) > p:nth-of-type(2)'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const html = (id: string) => useStore.getState().canvas?.frames.find((f) => f.id === id)?.html
const frameIds = () => useStore.getState().canvas?.frames.map((f) => f.id)

const row = (key: string) => {
  const el = [...container.querySelectorAll<HTMLElement>('[data-row-key]')].find((r) =>
    r.dataset.rowKey!.startsWith(key),
  )
  if (!el) throw new Error(`row ${key} not rendered`)
  return el
}

/* happy-dom has no layout: the row under the pointer is whichever one the
   test names, and every row is 28px tall at y 0 */
function dragRow(from: string, to: string, atY = 14) {
  const target = row(to)
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

const flush = () => act(async () => {})

describe('LayersPanel multi-selection drag', () => {
  beforeEach(() => {
    restackFrames.mockClear()
    updateFrame.mockClear()
    deleteFrame.mockClear()
    const canvas: Canvas = {
      id: 'c1',
      name: 'Canvas',
      frames: [
        frameWith('f1', 1, page('<p>a</p><i>b</i><p>c</p>')),
        frameWith('f2', 2),
        { ...frameWith('s1', 3, shape('x')), name: 'A' },
        { ...frameWith('s2', 4, shape('y')), name: 'B' },
      ],
    } as Canvas
    useStore.getState().setCanvas(canvas)
    useStore.setState({ selectedId: null, selectedIds: [], selectedElement: null, selectedElements: [] })
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

  it('moves the picked layers together, both still picked', async () => {
    act(() => useStore.getState().pickElements('f1', [PA, PB]))
    dragRow(`f1|${PA}`, `f1|${IT}`, 2)
    await flush()
    /* the two paragraphs land before the i, as one run */
    expect(html('f1')).toContain('<p>a</p><p>c</p><i>b</i>')
    expect(updateFrame).toHaveBeenCalledTimes(1)
    const picked = pickedSelectors(useStore.getState())
    expect(picked).toHaveLength(2)
    const doc = new DOMParser().parseFromString(html('f1')!, 'text/html')
    for (const sel of picked) {
      expect(doc.querySelector(sel)).not.toBeNull()
      expect(row(`f1|${sel}`).getAttribute('aria-selected')).toBe('true')
    }
  })

  it('restacks the selected top-level rows as one run', () => {
    act(() => useStore.getState().selectMany(['f1', 'f2']))
    /* drag f1 to the line above s1: both selected rows go in front of it */
    dragRow('f1', 's1', 2)
    expect(restackFrames).toHaveBeenCalledTimes(1)
    expect(restackFrames.mock.calls[0]![1].map((w) => w.id).sort()).toEqual(['f1', 'f2'])
  })

  it('moves the picked set into another frame', async () => {
    act(() => useStore.getState().pickElements('f1', [PA, PB]))
    dragRow(`f1|${PA}`, 'f2')
    await flush()
    /* the paragraphs land in f2 ahead of its own layer, as one run; the
       destination is saved first, then the emptied source */
    expect(html('f2')).toMatch(/<p[^>]*>a<\/p><p[^>]*>c<\/p><p[^>]*>x<\/p>/)
    expect(html('f1')).toContain('<i>b</i>')
    expect(updateFrame.mock.calls.map(([id]) => id)).toEqual(['f2', 'f1'])
    expect(useStore.getState().selectedElement?.frameId).toBe('f2')
    expect(pickedSelectors(useStore.getState())).toHaveLength(2)
  })

  it('moves the selected canvas shapes into a frame, shells and all', async () => {
    act(() => useStore.getState().selectMany(['s1', 's2']))
    dragRow('s1', 'f1')
    await flush()
    /* both shells are gone and their shapes sit in the frame, the
       front-most last in the markup as on the canvas */
    expect(frameIds()).toEqual(['f1', 'f2'])
    const f1 = html('f1')!
    expect(f1.match(/data-doop-drawing="rect"/g)).toHaveLength(2)
    expect(f1.indexOf('>x</div>')).toBeGreaterThan(-1)
    expect(f1.indexOf('>x</div>')).toBeLessThan(f1.indexOf('>y</div>'))
    expect(updateFrame.mock.calls.map(([id]) => id)).toEqual(['f1'])
    expect(deleteFrame.mock.calls.map(([id]) => id).sort()).toEqual(['s1', 's2'])
  })

  it('restacks when a group holding a real frame lands on a frame row', async () => {
    act(() => useStore.getState().selectMany(['f2', 's1']))
    dragRow('s1', 'f1')
    await flush()
    /* a set that is not all shapes only restacks: no transfer, no html edit */
    expect(updateFrame).not.toHaveBeenCalled()
    expect(restackFrames).toHaveBeenCalledTimes(1)
    expect(restackFrames.mock.calls[0]![1].map((w) => w.id).sort()).toEqual(['f2', 's1'])
  })
})
