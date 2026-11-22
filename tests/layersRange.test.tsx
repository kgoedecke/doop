// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/api', () => ({
  api: {
    /* the Components tab's dot asks; nothing waits in these tests */
    canvasLibrary: () => new Promise(() => {}),
    updateFrame: () => Promise.resolve(),
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

const { pickedSelectors, useStore } = await import('../src/lib/store')
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

const DIV = 'body:nth-of-type(1) > div:nth-of-type(1)'
const PA = `${DIV} > p:nth-of-type(1)`
const PB = `${DIV} > p:nth-of-type(2)`
const SPAN = 'body:nth-of-type(1) > span:nth-of-type(1)'
const P2 = 'body:nth-of-type(1) > p:nth-of-type(1)'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const row = (key: string) => {
  const el = [...container.querySelectorAll<HTMLElement>('[data-row-key]')].find((r) =>
    r.dataset.rowKey!.startsWith(key),
  )
  if (!el) throw new Error(`row ${key} not rendered`)
  return el
}
/* a frame's caret opens its layer rows without activating the row */
const caret = (key: string) => {
  const el = row(key).querySelector<HTMLElement>('[data-icon]')
  if (!el) throw new Error(`caret ${key} not rendered`)
  return el
}
const click = (el: HTMLElement, init: MouseEventInit = {}) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
const ids = () => useStore.getState().selectedIds

describe('LayersPanel ⇧-click ranges', () => {
  beforeEach(() => {
    const canvas: Canvas = {
      id: 'c1',
      name: 'Canvas',
      frames: [
        frameWith('f1', 1, page('<div><p>A</p><p>B</p></div><span>c</span>')),
        frameWith('f2', 2),
        { ...frameWith('s1', 3, shape), name: 'Rectangle' },
      ],
    } as Canvas
    useStore.getState().setCanvas(canvas)
    useStore.setState({ selectedId: null, selectedIds: [], selectedElement: null, selectedElements: [] })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    /* the list runs front to back: s1, f2, f1 */
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

  it('selects the root rows from the anchor to the ⇧-clicked row, and shrinks back', () => {
    click(row('s1'))
    click(row('f1'), { shiftKey: true })
    expect(ids()).toEqual(['s1', 'f2', 'f1'])
    expect(useStore.getState().selectedId).toBe('f1')
    expect(row('f2').getAttribute('aria-selected')).toBe('true')
    /* the anchor stayed on s1: the next ⇧-click ranges to it again */
    click(row('f2'), { shiftKey: true })
    expect(ids()).toEqual(['s1', 'f2'])
    expect(useStore.getState().selectedId).toBe('f2')
  })

  it('skips the layers of an expanded frame between two root rows', () => {
    click(row('s1'))
    click(caret('f2'))
    expect(row('f2|' + P2)).toBeTruthy()
    click(row('f1'), { shiftKey: true })
    expect(ids()).toEqual(['s1', 'f2', 'f1'])
  })

  it('selects the layers between two node rows of one frame, clicked last', () => {
    click(row('f1')) /* a frame's rows open when it is selected */
    click(caret(`f1|${DIV}`))
    click(row(`f1|${PA}`))
    click(row(`f1|${SPAN}`), { shiftKey: true })
    expect(pickedSelectors(useStore.getState())).toEqual([PA, PB, SPAN])
    for (const sel of [PA, PB, SPAN]) expect(row(`f1|${sel}`).getAttribute('aria-selected')).toBe('true')
    expect(row(`f1|${DIV}`).getAttribute('aria-selected')).toBe('false')
  })

  it('does what ⌘-click does when a root row and a layer are the pair', () => {
    click(caret('f1'))
    click(row('s1'))
    click(row(`f1|${DIV}`), { shiftKey: true })
    /* the fallback is the ⌘-click path: a layer of another frame is a plain pick */
    expect(useStore.getState().selectedElement).toEqual({ frameId: 'f1', selector: DIV })
    expect(ids()).toEqual(['f1'])
  })

  it('does what ⌘-click does for layers of two different frames', () => {
    click(row('f1'))
    click(row(`f1|${DIV}`))
    click(caret('f2'))
    click(row(`f2|${P2}`), { shiftKey: true })
    expect(useStore.getState().selectedElement).toEqual({ frameId: 'f2', selector: P2 })
    expect(ids()).toEqual(['f2'])
  })

  it('ranges from the current row when nothing was clicked yet', () => {
    act(() => useStore.getState().select('s1'))
    click(row('f1'), { shiftKey: true })
    expect(ids()).toEqual(['s1', 'f2', 'f1'])
    expect(useStore.getState().selectedId).toBe('f1')
  })

  it('keeps ranging from the current row the anchor fell back to', () => {
    act(() => useStore.getState().select('s1'))
    click(row('f1'), { shiftKey: true })
    expect(ids()).toEqual(['s1', 'f2', 'f1'])
    /* the fallback landed the anchor on s1: the next ⇧-click ranges
       from it again rather than from f1 */
    click(row('f2'), { shiftKey: true })
    expect(ids()).toEqual(['s1', 'f2'])
    expect(useStore.getState().selectedId).toBe('f2')
  })

  it('scrolls only the ⇧-clicked row of a range into view', () => {
    const previous = Element.prototype.scrollIntoView
    const seen: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this)
    }
    try {
      click(row('s1'))
      seen.length = 0
      click(row('f1'), { shiftKey: true })
      /* s1..f1 selects three rows; only the clicked one is revealed */
      expect(ids()).toEqual(['s1', 'f2', 'f1'])
      expect(seen).toEqual([row('f1')])
    } finally {
      Element.prototype.scrollIntoView = previous
    }
  })
})
