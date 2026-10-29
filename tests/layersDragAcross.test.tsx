// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

const updateFrame = vi.fn(() => Promise.resolve())
const deleteFrame = vi.fn(() => Promise.resolve())
const createFrame = vi.fn((canvasId: string, input: Partial<Frame> & { name: string }) =>
  Promise.resolve({ ...frameWith('new', ''), canvasId, ...input } as Frame),
)
vi.mock('../src/lib/api', () => ({
  api: {
    updateFrame: () => updateFrame(),
    deleteFrame: () => deleteFrame(),
    createFrame: (canvasId: string, input: Partial<Frame> & { name: string }) => createFrame(canvasId, input),
  },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: () => Promise.resolve(null),
  inspectElement: () => Promise.resolve({ rect: { x: 5, y: 5, width: 40, height: 20 } }),
}))

const { useStore } = await import('../src/lib/store')
const { LayersPanel } = await import('../src/components/LayersPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

const page = (body: string) => `<!doctype html>\n<html><head></head><body>${body}</body></html>`

function frameWith(id: string, html: string): Frame {
  return {
    id,
    canvasId: 'c1',
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'me',
  }
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const html = (id: string) => useStore.getState().canvas?.frames.find((f) => f.id === id)?.html

const row = (key: string) => {
  const el = container.querySelector<HTMLElement>(`[data-row-key="${key}"]`)
  if (!el) throw new Error(`row ${key} not rendered`)
  return el
}
/* the "empty frame" caption under an opened, emptied frame row carries the
   frame's key too */
const caption = (frameId: string) => {
  const el = [...container.querySelectorAll<HTMLElement>(`[data-row-key="${frameId}"]`)].find((r) =>
    r.textContent?.includes('empty frame'),
  )
  if (!el) throw new Error(`empty caption of ${frameId} not rendered`)
  return el
}

/* happy-dom has no layout: the row under the pointer is whichever one the
   test names, and every row is 28px tall at y 0 */
function dragRow(from: string, to: string | HTMLElement, atY = 14) {
  const target = typeof to === 'string' ? row(to) : to
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

describe('LayersPanel drag between frames', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    const canvas: Canvas = {
      id: 'c1',
      name: 'Canvas',
      frames: [
        frameWith('f1', page('<p>only</p>')),
        frameWith('f2', page('<section></section>')),
        {
          ...frameWith(
            's1',
            page('<div data-doop-drawing="rect" style="position:absolute">x</div>').replace(
              '<body>',
              '<body data-doop-canvas-element="true">',
            ),
          ),
          name: 'Rectangle',
        },
      ],
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

  it('carries a frame’s only element over and back onto the emptied frame row', () => {
    const P = 'body:nth-of-type(1) > p:nth-of-type(1)'
    /* open both frames */
    act(() => row('f1').querySelector<HTMLElement>('[data-icon]')!.click())
    act(() => row('f2').querySelector<HTMLElement>('[data-icon]')!.click())
    dragRow(`f1|${P}`, 'f2')
    expect(html('f1')).not.toContain('<p>')
    expect(html('f2')).toMatch(/<p[^>]*>only<\/p>/)
    expect(useStore.getState().selectedElement).toEqual({ frameId: 'f2', selector: P })

    dragRow(`f2|${P}`, caption('f1'))
    expect(html('f1')).toMatch(/<p[^>]*>only<\/p>/)
    expect(html('f2')).not.toContain('<p>')
    expect(useStore.getState().selectedElement).toEqual({ frameId: 'f1', selector: P })

    /* and onto the frame row itself */
    dragRow(`f1|${P}`, 'f2')
    expect(html('f2')).toMatch(/<p[^>]*>only<\/p>/)
    dragRow(`f2|${P}`, 'f1')
    expect(html('f1')).toMatch(/<p[^>]*>only<\/p>/)
    expect(html('f2')).not.toContain('<p>')
  })

  it('lists a standalone element as one layer at the root, and takes it into a frame without its shell', async () => {
    const SHAPE = 'body:nth-of-type(1) > div:nth-of-type(1)'
    const shape = row(`s1|${SHAPE}`)
    expect(shape.textContent).toContain('Rectangle')
    expect(container.querySelector('[data-row-key="s1"]')).toBeNull()
    act(() => row('f2').querySelector<HTMLElement>('[data-icon]')!.click())
    dragRow(`s1|${SHAPE}`, 'f2')
    expect(html('f2')).toMatch(/<div data-doop-drawing="rect" style="position: ?absolute"[^>]*>x<\/div>/)
    expect(useStore.getState().canvas?.frames.some((f) => f.id === 's1')).toBe(false)
    await flush()
    expect(deleteFrame).toHaveBeenCalledTimes(1)
  })

  it('keeps a standalone element whose own element is locked, and lets the eye clear its own hidden mark', () => {
    const SHAPE = 'body:nth-of-type(1) > div:nth-of-type(1)'
    act(() =>
      useStore.getState().patchFrameLocal('s1', {
        html: page(
          '<div data-doop-drawing="rect" data-doop-locked="true" data-doop-hidden="true" style="position:absolute">x</div>',
        ).replace('<body>', '<body data-doop-canvas-element="true">'),
      }),
    )
    act(() => row(`s1|${SHAPE}`).click())
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!
    act(() => {
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    expect(deleteFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas?.frames.some((f) => f.id === 's1')).toBe(true)
    const eye = row(`s1|${SHAPE}`).querySelector<HTMLButtonElement>('button[aria-label="Show"]')!
    expect(eye.getAttribute('aria-pressed')).toBe('true')
    act(() => eye.click())
    expect(html('s1')).not.toContain('data-doop-hidden')
  })

  it('lifts a layer onto the canvas when dropped at the root', async () => {
    const P = 'body:nth-of-type(1) > p:nth-of-type(1)'
    act(() => row('f1').querySelector<HTMLElement>('[data-icon]')!.click())
    /* the band above another frame's row is the root */
    dragRow(`f1|${P}`, 'f2', 2)
    await flush()
    await flush()
    expect(createFrame).toHaveBeenCalledTimes(1)
    expect(createFrame.mock.calls[0]![1]).toMatchObject({ name: 'only', x: 5, y: 5, width: 40, height: 20 })
    expect(html('f1')).not.toContain('<p>')
    expect(row(`new|${P}`).textContent).toContain('only')
  })
})
