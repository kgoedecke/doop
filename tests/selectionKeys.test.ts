// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

type StackWrite = { id: string; z: number }
const restackFrames = vi.fn((_canvasId: string, _frames: StackWrite[]) => Promise.resolve([]))
const updateFrame = vi.fn((_id: string, _patch: unknown) => Promise.resolve())
vi.mock('../src/lib/api', () => ({
  api: {
    restackFrames: (canvasId: string, frames: StackWrite[]) => restackFrames(canvasId, frames),
    updateFrame: (id: string, patch: unknown) => updateFrame(id, patch),
    deleteFrame: () => Promise.resolve(),
  },
  ApiError: class extends Error {},
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: () => Promise.resolve(null),
  inspectElement: () => Promise.resolve(null),
  settleFrames: () => Promise.resolve(),
}))

const { useStore } = await import('../src/lib/store')
const { buildLayerTree } = await import('../src/lib/layers')
const { isControlTarget, isSelectAllShortcut, reorderShortcut } = await import('../src/lib/keys')
const {
  enterTarget,
  exitTarget,
  siblingTarget,
  allSiblings,
  enterSelection,
  exitSelection,
  selectSibling,
  selectAll,
  reorderSelection,
} = await import('../src/lib/selectionKeys')

const page = (body: string) => `<!doctype html>\n<html><head></head><body>${body}</body></html>`
const BODY = page('<header><h1>Hi</h1><nav>n</nav></header><main><p>a</p><p data-doop-locked="">b</p><p>c</p></main>')
const HEADER = 'body:nth-of-type(1) > header:nth-of-type(1)'
const H1 = `${HEADER} > h1:nth-of-type(1)`
const NAV = `${HEADER} > nav:nth-of-type(1)`
const MAIN = 'body:nth-of-type(1) > main:nth-of-type(1)'
const P = (n: number) => `${MAIN} > p:nth-of-type(${n})`

function frameWith(id: string, createdAt: number, html = BODY, extra: Partial<Frame> = {}): Frame {
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
    ...extra,
  }
}

const shape = page('<div data-doop-drawing="rect" style="position:absolute">x</div>').replace(
  '<body>',
  '<body data-doop-canvas-element="true">',
)
const SHAPE = 'body:nth-of-type(1) > div:nth-of-type(1)'
const lockedShape = shape.replace('<div ', '<div data-doop-locked="" ')

const picked = () => useStore.getState().selectedElement?.selector ?? null
const selected = () => useStore.getState().selectedIds
const stack = () => useStore.getState().canvas?.frames.map((f) => f.id)
const html = (id: string) => useStore.getState().canvas?.frames.find((f) => f.id === id)?.html ?? ''

describe('tree targets', () => {
  const tree = buildLayerTree(BODY)
  it('enters the first child, of the frame or of a layer', () => {
    expect(enterTarget(tree, null)).toBe(HEADER)
    expect(enterTarget(tree, HEADER)).toBe(H1)
    expect(enterTarget(tree, H1)).toBeNull()
  })
  it('exits to the parent, and from a root to the frame', () => {
    expect(exitTarget(tree, H1)).toBe(HEADER)
    expect(exitTarget(tree, HEADER)).toBeNull()
    expect(exitTarget(tree, 'p:nth-of-type(9)')).toBeUndefined()
  })
  it('walks siblings and wraps at the ends', () => {
    expect(siblingTarget(tree, H1, 1)).toBe(NAV)
    expect(siblingTarget(tree, NAV, 1)).toBe(H1)
    expect(siblingTarget(tree, HEADER, -1)).toBe(MAIN)
    expect(siblingTarget(buildLayerTree(page('<p>x</p>')), 'body:nth-of-type(1) > p:nth-of-type(1)', 1)).toBeNull()
  })
  it('selects every unlocked sibling, the picked one last', () => {
    expect(allSiblings(tree, P(1))).toEqual([P(3), P(1)])
    expect(allSiblings(tree, P(2))).toEqual([P(1), P(3), P(2)])
  })
})

describe('key chords', () => {
  const chord = (over: Partial<KeyboardEvent>) => ({
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  })
  it('reads ⌘] and ⌘[ with their ⌥ forms, by key or by code', () => {
    expect(reorderShortcut(chord({ key: ']', metaKey: true }))).toBe('forward')
    expect(reorderShortcut(chord({ key: '[', ctrlKey: true }))).toBe('backward')
    expect(reorderShortcut(chord({ key: '‘', code: 'BracketRight', metaKey: true, altKey: true }))).toBe('front')
    expect(reorderShortcut(chord({ key: '“', code: 'BracketLeft', metaKey: true, altKey: true }))).toBe('back')
    expect(reorderShortcut(chord({ key: ']' }))).toBeNull()
    expect(reorderShortcut(chord({ key: ']', metaKey: true, shiftKey: true }))).toBeNull()
  })
  it('reads ⌘A and nothing shifted or alted', () => {
    expect(isSelectAllShortcut(chord({ key: 'a', metaKey: true }))).toBe(true)
    expect(isSelectAllShortcut(chord({ key: 'A', ctrlKey: true }))).toBe(true)
    expect(isSelectAllShortcut(chord({ key: 'a', metaKey: true, shiftKey: true }))).toBe(false)
    expect(isSelectAllShortcut(chord({ key: 'a' }))).toBe(false)
  })
  it('leaves ↩ and Tab to a control that has the keyboard', () => {
    document.body.innerHTML =
      '<button><span id="in-button">x</span></button><div role="tree"><div id="row"></div></div><div id="plain"></div>'
    expect(isControlTarget(document.getElementById('in-button'))).toBe(true)
    expect(isControlTarget(document.getElementById('row'))).toBe(true)
    expect(isControlTarget(document.getElementById('plain'))).toBe(false)
    expect(isControlTarget(document.body)).toBe(false)
    expect(isControlTarget(null)).toBe(false)
  })
})

describe('against the store', () => {
  beforeEach(() => {
    restackFrames.mockClear()
    updateFrame.mockClear()
    const canvas: Canvas = {
      id: 'c1',
      name: 'Canvas',
      frames: [
        frameWith('f1', 1),
        frameWith('f2', 2),
        frameWith('f3', 3, BODY, { locked: true }),
        frameWith('s1', 4, shape),
        frameWith('s2', 5, lockedShape),
      ],
    } as Canvas
    useStore.getState().setCanvas(canvas)
    useStore.setState({ selectedId: null, selectedIds: [], selectedElement: null, selectedElements: [] })
  })

  it('↩ goes into the frame, then into the layer; ⇧↩ comes back out', () => {
    useStore.getState().select('f1')
    expect(enterSelection()).toBe(true)
    expect(picked()).toBe(HEADER)
    expect(enterSelection()).toBe(true)
    expect(picked()).toBe(H1)
    expect(enterSelection()).toBe(false)
    expect(exitSelection()).toBe(true)
    expect(picked()).toBe(HEADER)
    expect(exitSelection()).toBe(true)
    expect(picked()).toBeNull()
    expect(selected()).toEqual(['f1'])
    expect(exitSelection()).toBe(false)
  })

  it('does nothing with several frames or nothing selected', () => {
    expect(enterSelection()).toBe(false)
    useStore.getState().selectMany(['f1', 'f2'])
    expect(enterSelection()).toBe(false)
    expect(selectSibling(1)).toBe(false)
  })

  it('a standalone shape has no frame to come out to', () => {
    useStore.getState().select('s1')
    useStore.getState().pickElement({ frameId: 's1', selector: SHAPE })
    expect(exitSelection()).toBe(false)
    expect(picked()).toBe(SHAPE)
  })

  it('Tab walks the siblings of a layer and the frames of the page', () => {
    useStore.getState().select('f1')
    useStore.getState().pickElement({ frameId: 'f1', selector: H1 })
    expect(selectSibling(1)).toBe(true)
    expect(picked()).toBe(NAV)
    expect(selectSibling(-1)).toBe(true)
    expect(picked()).toBe(H1)
    /* frames: the next row down the Layers list is the frame behind */
    useStore.getState().select('f2')
    expect(selectSibling(1)).toBe(true)
    expect(selected()).toEqual(['f1'])
    /* the bottom row wraps to the top: the shape in front, selected as its
       one layer, which walks the page from there */
    expect(selectSibling(1)).toBe(true)
    expect(selected()).toEqual(['s2'])
    expect(picked()).toBe(SHAPE)
    expect(selectSibling(1)).toBe(true)
    expect(selected()).toEqual(['s1'])
    expect(selectSibling(1)).toBe(true)
    expect(selected()).toEqual(['f3'])
    expect(picked()).toBeNull()
  })

  it('⌘A selects the unlocked frames of the page, or the siblings of the pick', () => {
    expect(selectAll()).toBe(true)
    expect(selected()).toEqual(['f1', 'f2', 's1'])
    expect(selectAll()).toBe(false)
    /* from a picked shape too: the page, not the shape's frame */
    useStore.getState().select('s1')
    useStore.getState().pickElement({ frameId: 's1', selector: SHAPE })
    expect(selectAll()).toBe(true)
    expect(selected()).toEqual(['f1', 'f2', 's1'])
    /* and the shape's own pick goes, even though it stays the primary frame */
    expect(picked()).toBeNull()
    expect(selectAll()).toBe(false)
    useStore.getState().select('f1')
    useStore.getState().pickElement({ frameId: 'f1', selector: P(1) })
    expect(selectAll()).toBe(true)
    expect(useStore.getState().selectedElements).toEqual([P(3), P(1)])
    expect(picked()).toBe(P(1))
    expect(selectAll()).toBe(false)
  })

  it('⌘] / ⌘[ step a layer among its siblings, ⌥ takes it to the ends', () => {
    useStore.getState().select('f1')
    useStore.getState().pickElement({ frameId: 'f1', selector: P(1) })
    expect(reorderSelection('forward')).toBe(true)
    expect(html('f1')).toContain('<main><p data-doop-locked="">b</p><p>a</p><p>c</p></main>')
    expect(picked()).toBe(P(2))
    expect(reorderSelection('front')).toBe(true)
    expect(html('f1')).toContain('<main><p data-doop-locked="">b</p><p>c</p><p>a</p></main>')
    expect(reorderSelection('front')).toBe(false)
    expect(reorderSelection('back')).toBe(true)
    expect(html('f1')).toContain('<main><p>a</p><p data-doop-locked="">b</p><p>c</p></main>')
    expect(reorderSelection('backward')).toBe(false)
    expect(updateFrame).toHaveBeenCalledTimes(3)
  })

  it('moves a picked set together and keeps it picked', () => {
    useStore.getState().select('f1')
    useStore.getState().pickElements('f1', [P(1), P(3)])
    expect(reorderSelection('backward')).toBe(true)
    expect(html('f1')).toContain('<main><p>a</p><p>c</p><p data-doop-locked="">b</p></main>')
    expect(useStore.getState().selectedElements).toEqual([P(1), P(2)])
    expect(picked()).toBe(P(2))
    expect(reorderSelection('backward')).toBe(false)
    expect(reorderSelection('front')).toBe(true)
    expect(html('f1')).toContain('<main><p data-doop-locked="">b</p><p>a</p><p>c</p></main>')
    expect(useStore.getState().selectedElements).toEqual([P(2), P(3)])
    expect(reorderSelection('front')).toBe(false)
    expect(reorderSelection('back')).toBe(true)
    expect(html('f1')).toContain('<main><p>a</p><p>c</p><p data-doop-locked="">b</p></main>')
    expect(updateFrame).toHaveBeenCalledTimes(3)
  })

  it('a pick with a gap keeps its order at the front and the back', () => {
    useStore.getState().select('f1')
    useStore.getState().pickElement({ frameId: 'f1', selector: P(1) })
    useStore.getState().toggleElement({ frameId: 'f1', selector: P(3) })
    expect(reorderSelection('front')).toBe(true)
    expect(html('f1')).toContain('<main><p data-doop-locked="">b</p><p>a</p><p>c</p></main>')
    expect(useStore.getState().selectedElements).toEqual([P(2), P(3)])
    expect(reorderSelection('front')).toBe(false)
    /* a and c again (b, in front of them now, is locked) */
    useStore.getState().pickElements('f1', [P(2), P(3)])
    expect(reorderSelection('back')).toBe(true)
    expect(html('f1')).toContain('<main><p>a</p><p>c</p><p data-doop-locked="">b</p></main>')
    expect(useStore.getState().selectedElements).toEqual([P(1), P(2)])
    expect(reorderSelection('back')).toBe(false)
  })

  it('a picked standalone shape restacks as a frame of the page', () => {
    useStore.getState().select('s1')
    useStore.getState().pickElement({ frameId: 's1', selector: SHAPE })
    expect(reorderSelection('back')).toBe(true)
    expect(stack()).toEqual(['s1', 'f1', 'f2', 'f3', 's2'])
    expect(updateFrame).not.toHaveBeenCalled()
    useStore.getState().select('s2')
    useStore.getState().pickElement({ frameId: 's2', selector: SHAPE })
    expect(reorderSelection('back')).toBe(false)
  })

  it('a locked layer stays put', () => {
    useStore.getState().select('f1')
    useStore.getState().pickElement({ frameId: 'f1', selector: P(2) })
    expect(reorderSelection('forward')).toBe(false)
    expect(updateFrame).not.toHaveBeenCalled()
  })

  it('⌘] / ⌘[ restack a frame in its page, ⌥ to the front or back', () => {
    useStore.getState().select('f1')
    expect(reorderSelection('forward')).toBe(true)
    expect(stack()).toEqual(['f2', 'f1', 'f3', 's1', 's2'])
    expect(reorderSelection('front')).toBe(true)
    expect(stack()).toEqual(['f2', 'f3', 's1', 's2', 'f1'])
    expect(reorderSelection('forward')).toBe(false)
    expect(reorderSelection('back')).toBe(true)
    expect(stack()).toEqual(['f1', 'f2', 'f3', 's1', 's2'])
    expect(reorderSelection('backward')).toBe(false)
    expect(restackFrames).toHaveBeenCalledTimes(3)
    useStore.getState().select('f3')
    expect(reorderSelection('forward')).toBe(false)
  })
})
