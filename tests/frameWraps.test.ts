// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ElementComment, Frame } from '../shared/types'

let nextId = 0
let version = 100
const updateFrame = vi.fn((id: string, patch: Partial<Frame>, _expected?: number) =>
  Promise.resolve({ ...frameWith(id, ''), ...patch, updatedAt: ++version } as Frame),
)
const deleteFrame = vi.fn((_id: string, _expected?: number) => Promise.resolve())
const createFrame = vi.fn((canvasId: string, input: Partial<Frame> & { name: string }) =>
  Promise.resolve({ ...frameWith(`new${++nextId}`, ''), canvasId, ...input, updatedAt: ++version } as Frame),
)
vi.mock('../src/lib/api', () => ({
  api: {
    updateFrame: (id: string, patch: Partial<Frame>, expected?: number) => updateFrame(id, patch, expected),
    deleteFrame: (id: string, expected?: number) => deleteFrame(id, expected),
    createFrame: (canvasId: string, input: Partial<Frame> & { name: string }) => createFrame(canvasId, input),
    getCanvas: () => new Promise(() => {}),
  },
  errorMessage: (_err: unknown, fallback: string) => fallback,
  ApiError: class extends Error {
    status: number
    body: Record<string, unknown>
    constructor(status: number, text: string) {
      super('api')
      this.status = status
      this.body = JSON.parse(text) as Record<string, unknown>
    }
  },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: () => Promise.resolve(null),
  bodyPlacementOrigin: () => ({ x: 0, y: 0 }),
  settleFrames: () => Promise.resolve([]),
  inspectElement: () => Promise.resolve(null),
}))

const { useStore } = await import('../src/lib/store')
const { ApiError } = await import('../src/lib/api')
const { clearHistory, undo } = await import('../src/lib/history')
const { framedShapesDocument, htmlVerdict, shapeVerdict, shapesInside } = await import('../src/lib/canvasGroups')
const { saveDrawing } = await import('../src/lib/drawing')

const shell = (inner: string) =>
  `<!doctype html>\n<html><head></head><body style="width:100%;height:100%;margin:0" data-doop-canvas-element="true">${inner}</body></html>`
const rect = (attrs = '', style = 'position:absolute;left:0;top:0;width:100%;height:100%') =>
  shell(`<div data-doop-drawing="rect" data-name="Rectangle" ${attrs} style="${style}"></div>`)

function frameWith(id: string, html: string, extra: Partial<Frame> = {}): Frame {
  return {
    id,
    canvasId: 'c1',
    pageId: 'p1',
    name: 'Rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'me',
    ...extra,
  }
}

function hold(...frames: Frame[]) {
  const canvas: Canvas = { id: 'c1', name: 'Canvas', frames, pages: [{ id: 'p1', name: 'Page 1' }] } as Canvas
  useStore.setState({
    canvas,
    activePageId: 'p1',
    selectedId: null,
    selectedIds: [],
    selectedElement: null,
    comments: [],
    notice: null,
  })
}

const live = (id: string) => useStore.getState().canvas!.frames.find((f) => f.id === id)
const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const target = { canvasId: 'c1', pageId: 'p1' }
const around = { tool: 'frame' as const, x: 0, y: 0, width: 400, height: 400 }

beforeEach(() => {
  updateFrame.mockClear()
  deleteFrame.mockClear()
  createFrame.mockClear()
  updateFrame.mockImplementation((id, patch) =>
    Promise.resolve({ ...frameWith(id, ''), ...patch, updatedAt: ++version } as Frame),
  )
  deleteFrame.mockImplementation(() => Promise.resolve())
  createFrame.mockImplementation((canvasId, input) =>
    Promise.resolve({ ...frameWith(`new${++nextId}`, ''), canvasId, ...input, updatedAt: ++version } as Frame),
  )
  clearHistory()
})

describe('shapesInside', () => {
  const box = { x: 0, y: 0, width: 400, height: 400 }

  it('takes the standalone shapes the box covers, back to front', () => {
    const a = frameWith('a', rect(), { x: 10, y: 10, z: 1 })
    const b = frameWith('b', rect(), { x: 50, y: 50, z: 2 })
    expect(shapesInside([b, a], box, 'p1').shapes.map((f) => f.id)).toEqual(['a', 'b'])
  })

  it('takes a shape whose own area is half or more inside, cut-off edge and all', () => {
    const half = frameWith('half', rect(), { x: 350, y: 10, width: 100, height: 100 })
    const sixty = frameWith('sixty', rect(), { x: 340, y: 140, width: 100, height: 100 })
    const forty = frameWith('forty', rect(), { x: 360, y: 270, width: 100, height: 100 })
    const { shapes, skipped } = shapesInside([half, sixty, forty], box, 'p1')
    expect(shapes.map((f) => f.id).sort()).toEqual(['half', 'sixty'])
    /* a shape left out of the frame is not one that had to stay */
    expect(skipped).toEqual([])
  })

  it('leaves out what is not a visible, straight, loose standalone shape inside', () => {
    const partial = frameWith('partial', rect(), { x: 300, y: 300, width: 200, height: 200 })
    const other = frameWith('other', rect(), { x: 10, y: 10, pageId: 'p2' })
    const hidden = { ...frameWith('hidden', rect(), { x: 10, y: 10 }), hidden: true }
    const locked = { ...frameWith('locked', rect(), { x: 10, y: 10 }), locked: true }
    const shapeLocked = frameWith('shapeLocked', rect('data-doop-locked=""'), { x: 10, y: 10 })
    const turned = { ...frameWith('turned', rect(), { x: 10, y: 10 }), rotation: 15 }
    const real = frameWith('real', '<!doctype html><html><head></head><body><section></section></body></html>', {
      x: 10,
      y: 10,
    })
    const { shapes, skipped } = shapesInside([partial, other, hidden, locked, shapeLocked, turned, real], box, 'p1')
    expect(shapes).toEqual([])
    /* none of them is reported: only a shape that could not come along is */
    expect(skipped).toEqual([])
  })

  it('skips a shape with comments or a component main, or one placed unreadably', () => {
    const commented = frameWith('a', rect(), { x: 10, y: 10, name: 'Pinned' })
    const main = frameWith('b', rect('data-doop-component="cmp"'), { x: 50, y: 50, name: 'Main' })
    const unreadable = frameWith('c', rect('', 'left:0;top:0;width:100%;height:100%'), {
      x: 90,
      y: 90,
      name: 'Flexed',
    })
    const fine = frameWith('d', rect(), { x: 130, y: 130 })
    hold(commented, main, unreadable, fine)
    useStore.setState({ comments: [{ id: 'k', frameId: 'a', x: 1, y: 1 } as unknown as ElementComment] })
    const { shapes, skipped } = shapesInside([commented, main, unreadable, fine], box, 'p1')
    expect(shapes.map((f) => f.id)).toEqual(['d'])
    expect(skipped.map((s) => s.frame.id)).toEqual(['a', 'b', 'c'])
    expect(skipped[0]!.reason).toContain('comments or a component main')
    expect(skipped[2]!.reason).toContain('a way a frame can’t keep yet')
  })

  it('sees a comment left after the shape’s html verdict was cached', () => {
    const a = frameWith('a', rect(), { x: 10, y: 10, name: 'Pinned' })
    hold(a)
    /* the drag probe caches this much by the frame's html… */
    expect(htmlVerdict(a)).toBe('shape')
    useStore.setState({ comments: [{ id: 'k', frameId: 'a', x: 1, y: 1 } as unknown as ElementComment] })
    /* …and the comment half of the check runs fresh over it */
    expect(shapeVerdict(a)).toEqual({
      reason: '“Pinned” has comments or a component main, so it stayed on the canvas',
    })
  })
})

describe('framedShapesDocument', () => {
  const frameDoc =
    '<!doctype html>\n<html><head></head><body style="width:100%;height:100%;margin:0;background:#ffffff"></body></html>'

  it('places each shape by pixels where it showed, back to front', () => {
    const a = frameWith('a', rect(), { x: 10, y: 20, width: 100, height: 50, z: 1 })
    /* the shape's own box inside its shell offsets the frame's corner */
    const b = frameWith('b', rect('', 'position:absolute;left:5px;top:10px;width:40px;height:20px'), {
      x: 100,
      y: 200,
      width: 50,
      height: 50,
      z: 2,
    })
    const built = framedShapesDocument(frameDoc, { x: 0, y: 0, width: 400, height: 400 }, [a, b])
    expect(built).not.toBeNull()
    const [first, second] = [...doc(built!.html).body.children] as HTMLElement[]
    expect(first!.getAttribute('data-doop-drawing')).toBe('rect')
    expect([first!.style.left, first!.style.top, first!.style.width, first!.style.height]).toEqual([
      '10px',
      '20px',
      '100px',
      '50px',
    ])
    expect([second!.style.left, second!.style.top, second!.style.width, second!.style.height]).toEqual([
      '105px',
      '210px',
      '40px',
      '20px',
    ])
    /* front-most last */
    expect(built!.scopes.get('a')).toBeTruthy()
    expect(built!.scopes.get('b')).toBeTruthy()
  })

  it('paints the run in DOM order, not by a z-index a shape carried in', () => {
    /* z-index 5 meant nothing alone in the back shell; shared in the frame
       it would lift the back shape over the front one */
    const back = frameWith('a', rect('', 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:5'), {
      x: 10,
      y: 10,
      name: 'Back',
      z: 1,
    })
    const front = frameWith('b', rect(), { x: 50, y: 50, name: 'Front', z: 2 })
    const built = framedShapesDocument(frameDoc, { x: 0, y: 0, width: 400, height: 400 }, [back, front])
    const [first, second] = [...doc(built!.html).body.children] as HTMLElement[]
    /* back to front as inserted, each root its own stacking context */
    expect(first!.getAttribute('data-doop-name')).toBe('Back')
    expect(first!.style.getPropertyValue('isolation')).toBe('isolate')
    expect(first!.style.getPropertyValue('z-index')).toBe('auto')
    expect(second!.getAttribute('data-doop-name')).toBe('Front')
    expect(second!.style.getPropertyValue('isolation')).toBe('isolate')
    expect(second!.style.getPropertyValue('z-index')).toBe('auto')
  })

  it('carries each shape’s own CSS and keeps the shell’s name as the layer’s', () => {
    const a = frameWith('a', rect('class="dot"', 'position:absolute;left:0;top:0;width:100%;height:100%'), {
      x: 10,
      y: 10,
      name: 'Dot',
    })
    const withCss = {
      ...a,
      html: a.html.replace('<head>', '<head><style>.dot{fill:red}</style>'),
    }
    const built = framedShapesDocument(frameDoc, { x: 0, y: 0, width: 400, height: 400 }, [withCss])
    const layer = doc(built!.html).body.firstElementChild as HTMLElement
    expect(layer.getAttribute('data-doop-name')).toBe('Dot')
    expect(built!.html).toContain('.dot')
  })
})

describe('saveDrawing wrap', () => {
  it('makes one frame with the enclosed shapes inside and their shells gone, one undo step', async () => {
    const a = frameWith('a', rect(), { x: 10, y: 10, width: 100, height: 50, z: 1, updatedAt: 3 })
    const b = frameWith('b', rect(), {
      x: 200,
      y: 100,
      width: 60,
      height: 60,
      z: 2,
      updatedAt: 4,
      name: 'Dot',
    })
    hold(a, b)
    await saveDrawing(around, target, { wrap: true })
    expect(createFrame).toHaveBeenCalledTimes(1)
    const [canvasId, input] = createFrame.mock.calls[0]!
    expect(canvasId).toBe('c1')
    expect(input).toMatchObject({ name: 'Frame', x: 0, y: 0, width: 400, height: 400, pageId: 'p1' })
    const body = doc(input.html!).body
    expect(body.children).toHaveLength(2)
    /* the shell's name became the layer's, as on the canvas */
    expect((body.children[1] as HTMLElement).getAttribute('data-doop-name')).toBe('Dot')
    /* the created frame is up, the shells are gone locally */
    const created = useStore.getState().canvas!.frames.find((f) => f.name === 'Frame')!
    expect(useStore.getState().canvas!.frames).toHaveLength(1)
    expect(useStore.getState().selectedIds).toEqual([created.id])
    await settle()
    expect(deleteFrame.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b'])

    await undo()
    /* the shells are back, the frame is gone — in one step */
    const frames = useStore.getState().canvas!.frames
    expect(frames).toHaveLength(2)
    expect(frames.map((f) => f.x).sort()).toEqual([10, 200])
    expect(frames.find((f) => f.name === 'Frame')).toBeUndefined()
  })

  it('draws a plain frame on a click — wrap is only for a dragged-out frame', async () => {
    const a = frameWith('a', rect(), { x: 10, y: 10, z: 1 })
    hold(a)
    await saveDrawing(around, target)
    const [, input] = createFrame.mock.calls[0]!
    expect(doc(input.html!).body.children).toHaveLength(0)
    expect(live('a')).toBeTruthy()
    await settle()
    expect(deleteFrame).not.toHaveBeenCalled()
  })

  it('says why a shape it could not take stayed on the canvas', async () => {
    const a = frameWith('a', rect(), { x: 10, y: 10, name: 'Pinned', z: 1 })
    hold(a)
    useStore.setState({ comments: [{ id: 'k', frameId: 'a', x: 1, y: 1 } as unknown as ElementComment] })
    await saveDrawing(around, target, { wrap: true })
    expect(doc(createFrame.mock.calls[0]![1].html!).body.children).toHaveLength(0)
    expect(live('a')).toBeTruthy()
    expect(useStore.getState().notice?.text).toBe(
      '“Pinned” has comments or a component main, so it stayed on the canvas',
    )
  })

  it('puts a shell a teammate saved back on the canvas and strips its copy', async () => {
    const a = frameWith('a', rect(), { x: 10, y: 10, z: 1, updatedAt: 3 })
    const b = frameWith('b', rect(), { x: 50, y: 50, z: 2, updatedAt: 4 })
    hold(a, b)
    const theirs = { ...a, x: 40, updatedAt: 9 }
    deleteFrame.mockImplementationOnce(() => Promise.reject(new ApiError(409, JSON.stringify({ frame: theirs }))))
    await saveDrawing(around, target, { wrap: true })
    await settle()
    await settle()
    /* the shell is back as the teammate left it, its copy out of the frame */
    expect(live('a')).toMatchObject({ x: 40, updatedAt: 9 })
    const resaved = updateFrame.mock.calls.at(-1)!
    expect(groupChildren(resaved[1].html!)).toHaveLength(1)
    const frame = useStore.getState().canvas!.frames.find((f) => f.name === 'Frame')!
    expect(groupChildren(live(frame.id)!.html)).toHaveLength(1)
    expect(useStore.getState().notice?.text).toContain('stayed on the canvas')
    /* undo recreates the shell that went, not the one that stayed — a's
       copy would be a second one */
    createFrame.mockClear()
    await undo()
    expect(createFrame.mock.calls.map(([, input]) => [input.x, input.y])).toEqual([[50, 50]])
    expect(live('a')).toBeTruthy()
    expect(useStore.getState().canvas!.frames.find((f) => f.name === 'Frame')).toBeUndefined()
  })

  it('still finishes the transfer on the server when the canvas was left mid-save', async () => {
    const a = frameWith('a', rect(), { x: 10, y: 10, z: 1, updatedAt: 3 })
    hold(a)
    createFrame.mockImplementationOnce(async (canvasId, input) => {
      /* the person opened another canvas while the frame was being created */
      useStore.setState({
        canvas: { id: 'c2', name: 'Other', frames: [], pages: [], createdAt: 0, updatedAt: 0 } as Canvas,
        activePageId: null,
      })
      return { ...frameWith('new-mid', ''), canvasId, ...input, updatedAt: ++version } as Frame
    })
    await saveDrawing(around, target, { wrap: true })
    /* the resolve came after the deletes: the shells went on the server */
    expect(deleteFrame.mock.calls.map(([id]) => id)).toEqual(['a'])
    /* nothing changed on the canvas now open, and no step was recorded */
    expect(useStore.getState().canvas!.id).toBe('c2')
    expect(useStore.getState().canvas!.frames).toHaveLength(0)
    expect(useStore.getState().notice).toBeNull()
    updateFrame.mockClear()
    deleteFrame.mockClear()
    await undo()
    expect(updateFrame).not.toHaveBeenCalled()
    expect(deleteFrame).not.toHaveBeenCalled()
  })

  it('keeps the next drawing queued until a kept shell’s copy is stripped', async () => {
    const a = frameWith('a', rect(), { x: 10, y: 10, z: 1, updatedAt: 3 })
    const b = frameWith('b', rect(), { x: 50, y: 50, z: 2, updatedAt: 4 })
    hold(a, b)
    /* a's delete loses to a teammate save: the copy comes out of the frame next */
    deleteFrame.mockImplementationOnce(() =>
      Promise.reject(new ApiError(409, JSON.stringify({ frame: { ...a, updatedAt: 9 } }))),
    )
    const order: string[] = []
    createFrame.mockImplementation((canvasId, input) => {
      order.push('create')
      return Promise.resolve({ ...frameWith(`new${++nextId}`, ''), canvasId, ...input, updatedAt: ++version } as Frame)
    })
    updateFrame.mockImplementation((id, patch) => {
      order.push('update')
      return Promise.resolve({ ...frameWith(id, ''), ...patch, updatedAt: ++version } as Frame)
    })
    const first = saveDrawing(around, target, { wrap: true })
    /* a drawing queued behind it sees only the stripped frame */
    const second = saveDrawing({ tool: 'frame', x: 500, y: 500, width: 100, height: 100 }, target)
    await Promise.all([first, second])
    expect(order).toEqual(['create', 'update', 'create'])
  })
})

const groupChildren = (html: string) => doc(html).body.children
