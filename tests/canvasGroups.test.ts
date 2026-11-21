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
  settleFrames: () => Promise.resolve([]),
  inspectElement: () => Promise.resolve(null),
}))

const { useStore } = await import('../src/lib/store')
const { ApiError } = await import('../src/lib/api')
const { clearHistory, recordUpdate, undo, redo } = await import('../src/lib/history')
const { noteTheirSave } = await import('../src/lib/theirSaves')
const { groupableCanvasShapes, groupCanvasShapes, selectedCanvasGroup, ungroupCanvasGroup } =
  await import('../src/lib/canvasGroups')

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
  })
}

const live = (id: string) => useStore.getState().canvas!.frames.find((f) => f.id === id)
const ids = () => useStore.getState().canvas!.frames.map((f) => f.id)
const groupOf = (html: string) => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.body.firstElementChild as HTMLElement
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  updateFrame.mockClear()
  deleteFrame.mockClear()
  createFrame.mockClear()
  updateFrame.mockImplementation((id, patch) =>
    Promise.resolve({ ...frameWith(id, ''), ...patch, updatedAt: ++version } as Frame),
  )
  deleteFrame.mockImplementation(() => Promise.resolve())
  clearHistory()
})

describe('groupableCanvasShapes', () => {
  it('takes two or more shapes of one page, back to front, none locked or turned', () => {
    const a = frameWith('a', rect(), { z: 1 })
    const b = frameWith('b', rect(), { z: 2 })
    const box = frameWith('f', '<!doctype html><html><head></head><body><section></section></body></html>')
    hold(a, b, box)
    expect(groupableCanvasShapes([b, a])?.map((f) => f.id)).toEqual(['a', 'b'])
    expect(groupableCanvasShapes([a])).toBeNull()
    expect(groupableCanvasShapes([a, box])).toBeNull()
    expect(groupableCanvasShapes([a, { ...b, locked: true }])).toBeNull()
    /* the shape's own lock (⇧⌘L) counts as much as its frame's */
    expect(groupableCanvasShapes([a, { ...b, html: rect('data-doop-locked=""') }])).toBeNull()
    expect(groupableCanvasShapes([a, { ...b, rotation: 15 }])).toBeNull()
    expect(groupableCanvasShapes([a, { ...b, pageId: 'p2' }])).toBeNull()
  })
})

describe('groupCanvasShapes', () => {
  const back = () => frameWith('a', rect(), { x: 0, y: 0, width: 100, height: 50, z: 1, updatedAt: 3 })
  const front = () => frameWith('b', rect(), { x: 300, y: 150, width: 100, height: 50, z: 2, updatedAt: 4 })

  it('keeps the frontmost frame as the group, the others’ shapes inside it, as one undo step', async () => {
    const a = back()
    const b = front()
    hold(a, b)
    expect(groupCanvasShapes([a, b], 'Group')).toBe(true)
    /* the frame, its id and its place in the stack are the front shape's */
    expect(ids()).toEqual(['b'])
    const host = live('b')!
    expect(host).toMatchObject({ name: 'Group', x: 0, y: 0, width: 400, height: 200, z: 2 })
    const group = groupOf(host.html)
    expect(group.getAttribute('data-doop-drawing')).toBe('group')
    const [first, second] = [...group.children] as HTMLElement[]
    expect([first!.style.left, first!.style.top, first!.style.width, first!.style.height]).toEqual([
      '0%',
      '0%',
      '25%',
      '25%',
    ])
    expect([second!.style.left, second!.style.top]).toEqual(['75%', '75%'])
    expect(useStore.getState().selectedIds).toEqual(['b'])
    await settle()
    /* the group is saved first, both writes conditional on what was seen */
    expect(updateFrame.mock.calls[0]?.[0]).toBe('b')
    expect(updateFrame.mock.calls[0]?.[2]).toBe(4)
    expect(deleteFrame.mock.calls).toEqual([['a', 3]])

    await undo()
    expect(ids()).toHaveLength(2)
    const restored = useStore.getState().canvas!.frames.find((f) => f.id !== 'b')!
    expect(restored).toMatchObject({ x: 0, y: 0, width: 100, height: 50, html: a.html })
    expect(live('b')).toMatchObject({ name: 'Rectangle', x: 300, y: 150, width: 100, height: 50, html: b.html })

    await redo()
    expect(ids()).toEqual(['b'])
    expect(live('b')).toMatchObject({ name: 'Group', width: 400, height: 200 })
  })

  it('refuses when a shape that would lose its frame has comments or a component main', () => {
    const a = back()
    const b = front()
    hold(a, b)
    useStore.setState({ comments: [{ id: 'k', frameId: 'a', x: 1, y: 1 } as unknown as ElementComment] })
    expect(groupCanvasShapes([a, b], 'Group')).toBe(false)
    expect(ids()).toEqual(['a', 'b'])
    useStore.setState({ comments: [] })
    const main = { ...a, html: rect('data-doop-component="cmp1"') }
    hold(main, b)
    expect(groupCanvasShapes([main, b], 'Group')).toBe(false)
    expect(ids()).toEqual(['a', 'b'])
  })

  it('lets the frontmost shape keep its comments, since its frame stays', () => {
    const a = back()
    const b = front()
    hold(a, b)
    useStore.setState({ comments: [{ id: 'k', frameId: 'b', elementId: 'el1' } as unknown as ElementComment] })
    expect(groupCanvasShapes([a, b], 'Group')).toBe(true)
  })

  it('refuses to move the frame’s corner under comments pinned to the frame', () => {
    const a = back()
    const b = front()
    hold(a, b)
    useStore.setState({ comments: [{ id: 'k', frameId: 'b', x: 10, y: 10 } as unknown as ElementComment] })
    expect(groupCanvasShapes([a, b], 'Group')).toBe(false)
    expect(ids()).toEqual(['a', 'b'])
  })

  it('will not redo over a shape a teammate edited after the undo', async () => {
    const a = back()
    const b = front()
    hold(a, b)
    groupCanvasShapes([a, b], 'Group')
    await settle()
    await undo()
    const restored = useStore.getState().canvas!.frames.find((f) => f.id !== 'b')!
    /* a teammate's save reaches the restored shape */
    useStore.getState().upsertFrame({ ...restored, html: rect('data-edited=""'), updatedAt: 10_000 })
    noteTheirSave(restored.id, 10_000)
    deleteFrame.mockClear()
    await redo()
    expect(deleteFrame).not.toHaveBeenCalled()
    expect(ids()).toHaveLength(2)
    expect(live('b')).toMatchObject({ name: 'Rectangle', x: 300 })
  })

  it('will not redo over a shape a teammate saves while the redo runs', async () => {
    const a = back()
    const b = front()
    hold(a, b)
    groupCanvasShapes([a, b], 'Group')
    await settle()
    await undo()
    const restored = useStore.getState().canvas!.frames.find((f) => f.id !== 'b')!
    /* the teammate's save lands while the redo writes the group */
    updateFrame.mockImplementationOnce((id, patch) => {
      useStore.getState().upsertFrame({ ...restored, html: rect('data-edited=""'), updatedAt: 20_000 })
      noteTheirSave(restored.id, 20_000)
      return Promise.resolve({ ...frameWith(id, ''), ...patch, updatedAt: ++version } as Frame)
    })
    deleteFrame.mockClear()
    await redo()
    expect(deleteFrame).not.toHaveBeenCalled()
    expect(live(restored.id)!.html).toContain('data-edited')
  })

  it('shows the teammate’s save, not the old copy, when the server refuses the redo', async () => {
    const a = back()
    const b = front()
    hold(a, b)
    groupCanvasShapes([a, b], 'Group')
    await settle()
    await undo()
    const host = live('b')!
    const theirs = { ...host, html: rect('data-theirs=""'), updatedAt: 30_000 }
    /* their save reaches this browser, then the server refuses the redo's write */
    updateFrame.mockImplementationOnce(() => {
      useStore.getState().upsertFrame(theirs)
      return Promise.reject(new ApiError(409, JSON.stringify({ frame: theirs })))
    })
    await redo()
    expect(live('b')).toMatchObject({ updatedAt: 30_000 })
    expect(live('b')!.html).toContain('data-theirs')
  })

  it('makes the redo’s writes conditional on the versions it knows', async () => {
    const a = back()
    const b = front()
    hold(a, b)
    groupCanvasShapes([a, b], 'Group')
    await settle()
    await undo()
    const restored = useStore.getState().canvas!.frames.find((f) => f.id !== 'b')!
    deleteFrame.mockClear()
    updateFrame.mockClear()
    await redo()
    /* the version the undo's own save of the group left */
    expect(updateFrame.mock.calls.at(-1)![2]).toEqual(expect.any(Number))
    expect(deleteFrame).toHaveBeenCalledWith(restored.id, restored.updatedAt)
  })

  it('undoes the grouping after the person’s own move of the group, and its undo', async () => {
    const a = back()
    const b = front()
    hold(a, b)
    groupCanvasShapes([a, b], 'Group')
    await settle()
    const host = live('b')!
    /* the person moves the group, then takes the move back */
    const moved = await updateFrame('b', { x: host.x + 40 })
    useStore.getState().upsertFrame(moved)
    recordUpdate('b', { x: host.x }, { x: host.x + 40 }, true)
    await undo()
    /* the undo's own save comes back through the room */
    const echo = (await updateFrame.mock.results.at(-1)!.value) as Frame
    useStore.getState().upsertFrame(echo)
    expect(echo.updatedAt).toBeGreaterThan(moved.updatedAt)
    await undo()
    expect(ids()).toHaveLength(2)
    expect(groupOf(live('b')!.html).getAttribute('data-doop-drawing')).toBe('rect')
  })

  it('keeps a hidden shape hidden and a renamed one named, as layers', () => {
    const a = { ...back(), hidden: true, name: 'Backdrop' }
    const b = front()
    hold(a, b)
    groupCanvasShapes([a, b], 'Group')
    const host = live('b')!
    expect(host.hidden).toBe(false)
    const [first, second] = [...groupOf(host.html).children] as HTMLElement[]
    expect(first!.getAttribute('data-doop-hidden')).toBe('true')
    expect(first!.getAttribute('data-doop-name')).toBe('Backdrop')
    expect(second!.hasAttribute('data-doop-hidden')).toBe(false)
    expect(second!.hasAttribute('data-doop-name')).toBe(false)
  })

  it('gives a clashing id up and keeps each shape’s own CSS apart', () => {
    const a = { ...back(), html: rect('id="hero"').replace('<head>', '<head><style>#hero{color:red}</style>') }
    const b = { ...front(), html: rect('id="hero"').replace('<head>', '<head><style>#hero{color:blue}</style>') }
    hold(a, b)
    groupCanvasShapes([a, b], 'Group')
    const html = live('b')!.html
    const [first, second] = [...groupOf(html).children] as HTMLElement[]
    expect(second!.id).toBe('hero')
    expect(first!.id).toBe('hero-copy')
    expect(html).toContain('#hero-copy')
    expect(html).toMatch(/#hero\b[^-][^{]*\{\s*color:\s*blue/)
  })

  it('keeps a turned path’s own box and transform, moved by where its frame sat', () => {
    const path = frameWith(
      'a',
      shell(
        '<svg data-doop-drawing="path" style="position:absolute;left:10px;top:20px;width:80px;height:40px;transform:matrix(0.8,0.6,-0.6,0.8,5,0)"></svg>',
      ),
      { x: 100, y: 100, width: 100, height: 100, z: 1 },
    )
    const b = frameWith('b', rect(), { x: 0, y: 0, width: 100, height: 100, z: 2 })
    hold(path, b)
    groupCanvasShapes([path, b], 'Group')
    const [first] = [...groupOf(live('b')!.html).children] as SVGElement[]
    /* the group is 200 × 200 from (0, 0): the path's box sits at 110, 120 */
    expect([first!.style.left, first!.style.top, first!.style.width, first!.style.height]).toEqual([
      '55%',
      '60%',
      '40%',
      '20%',
    ])
    expect(first!.style.transform).toContain('matrix(0.8')
  })

  it('takes a shape edited by a teammate meanwhile back out of the group, and keeps it', async () => {
    const a = back()
    const b = front()
    hold(a, b)
    const theirs = { ...a, x: 40, updatedAt: 9 }
    deleteFrame.mockImplementation(() => Promise.reject(new ApiError(409, JSON.stringify({ frame: theirs }))))
    groupCanvasShapes([a, b], 'Group')
    await settle()
    await settle()
    expect(live('a')).toMatchObject({ x: 40 })
    /* the group was saved again without the copy */
    const resaved = updateFrame.mock.calls.at(-1)!
    expect(resaved[0]).toBe('b')
    expect(groupOf(resaved[1].html!).children).toHaveLength(1)
    expect(groupOf(live('b')!.html).children).toHaveLength(1)
    /* undo no longer brings a second copy of it back */
    createFrame.mockClear()
    await undo()
    expect(createFrame).not.toHaveBeenCalled()
  })

  it('keeps a teammate’s newer save of a shape when the group cannot be saved', async () => {
    const a = back()
    const b = front()
    hold(a, b)
    let fail!: (err: Error) => void
    updateFrame.mockImplementationOnce(() => new Promise<Frame>((_, reject) => (fail = reject)))
    groupCanvasShapes([a, b], 'Group')
    /* a teammate's save of the back shape reaches the canvas meanwhile */
    useStore.getState().upsertFrame({ ...a, html: rect('data-edited=""'), updatedAt: 9_000 })
    fail(new Error('offline'))
    await settle()
    expect(live('a')).toMatchObject({ updatedAt: 9_000 })
    expect(live('a')!.html).toContain('data-edited')
  })

  it('puts every shape back when the group cannot be saved', async () => {
    const a = back()
    const b = front()
    hold(a, b)
    updateFrame.mockImplementation(() => Promise.reject(new Error('down')))
    groupCanvasShapes([a, b], 'Group')
    await settle()
    expect(ids().sort()).toEqual(['a', 'b'])
    expect(live('b')!.html).toBe(b.html)
    expect(deleteFrame).not.toHaveBeenCalled()
  })
})

describe('ungroupCanvasGroup', () => {
  const grouped = async () => {
    const a = frameWith('a', rect(), { x: 0, y: 0, width: 100, height: 50, z: 1, name: 'Back' })
    const b = frameWith('b', rect(), { x: 300, y: 150, width: 100, height: 50, z: 5 })
    const under = frameWith('u', rect(), { x: 900, y: 900, z: 0 })
    hold(under, a, b)
    groupCanvasShapes([a, b], 'Group')
    await settle()
    clearHistory()
    return live('b')!
  }

  it('is offered for a selected canvas group only', async () => {
    const host = await grouped()
    useStore.setState({ selectedIds: ['b'], selectedId: 'b', selectedElement: null })
    expect(selectedCanvasGroup()?.id).toBe(host.id)
    useStore.setState({ selectedIds: ['u'], selectedId: 'u' })
    expect(selectedCanvasGroup()).toBeNull()
  })

  it('splits the group back into shapes where they show, the frame keeping the front one', async () => {
    const host = await grouped()
    expect(await ungroupCanvasGroup(host)).toBe(true)
    const [, input] = createFrame.mock.calls.at(-1)!
    expect(input).toMatchObject({ name: 'Back', x: 0, y: 0, width: 100, height: 50 })
    /* behind the frame, in front of what was under it */
    expect(input.z).toBeGreaterThan(0)
    expect(input.z).toBeLessThan(5)
    const shape = groupOf(input.html!)
    expect([shape.style.left, shape.style.width]).toEqual(['0px', '100%'])
    expect(shape.hasAttribute('data-doop-name')).toBe(false)
    expect(live('b')).toMatchObject({ name: 'Rectangle', x: 300, y: 150, width: 100, height: 50 })
    expect(groupOf(live('b')!.html).getAttribute('data-doop-drawing')).toBe('rect')

    await undo()
    expect(ids().sort()).toEqual(['b', 'u'])
    expect(live('b')).toMatchObject({ name: 'Group', width: 400, height: 200 })
  })

  it('makes an undo pressed while the shapes are being made wait for the split, and undo it', async () => {
    const host = await grouped()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    createFrame.mockImplementationOnce(async (canvasId, input) => {
      await gate
      return { ...frameWith(`new${++nextId}`, ''), canvasId, ...input, updatedAt: ++version } as Frame
    })
    const split = ungroupCanvasGroup(host)
    const undone = undo()
    release()
    expect(await split).toBe(true)
    await undone
    expect(ids().sort()).toEqual(['b', 'u'])
    expect(live('b')).toMatchObject({ name: 'Group' })
  })

  it('leaves a selection made while the split was pending alone', async () => {
    const host = await grouped()
    useStore.setState({ selectedIds: ['b'], selectedId: 'b', selectedElement: null })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    createFrame.mockImplementationOnce(async (canvasId, input) => {
      await gate
      return { ...frameWith(`new${++nextId}`, ''), canvasId, ...input, updatedAt: ++version } as Frame
    })
    const split = ungroupCanvasGroup(host)
    useStore.getState().select('u')
    release()
    expect(await split).toBe(true)
    expect(useStore.getState().selectedIds).toEqual(['u'])
  })

  it('refuses a group turned or flipped as a whole', async () => {
    const host = await grouped()
    const flipped = host.html.replace(
      'data-doop-drawing="group"',
      'data-doop-drawing="group" style="transform: scaleX(-1)"',
    )
    useStore.getState().patchFrameLocal('b', { html: flipped })
    expect(await ungroupCanvasGroup(live('b')!)).toBe(false)
    expect(createFrame).not.toHaveBeenCalled()
  })

  it('refuses to move the frame’s corner under comments pinned to the frame', async () => {
    const host = await grouped()
    useStore.setState({ comments: [{ id: 'k', frameId: 'b', x: 10, y: 10 } as unknown as ElementComment] })
    expect(await ungroupCanvasGroup(host)).toBe(false)
  })

  it('refuses when the group itself has comments, since the split removes it', async () => {
    const host = await grouped()
    const stamped = host.html.replace('data-doop-drawing="group"', 'data-doop-drawing="group" data-doop-id="g1"')
    useStore.getState().patchFrameLocal('b', { html: stamped })
    useStore.setState({
      comments: [{ id: 'k', frameId: 'b', elementId: 'g1' } as unknown as ElementComment],
    })
    expect(await ungroupCanvasGroup(live('b')!)).toBe(false)
    expect(createFrame).not.toHaveBeenCalled()
  })

  it('splits a hidden group into hidden shapes', async () => {
    const host = await grouped()
    const hidden = host.html.replace('data-doop-drawing="group"', 'data-doop-drawing="group" data-doop-hidden="true"')
    useStore.getState().patchFrameLocal('b', { html: hidden })
    expect(await ungroupCanvasGroup(live('b')!)).toBe(true)
    expect(createFrame.mock.calls.at(-1)![1]).toMatchObject({ hidden: true })
    expect(live('b')).toMatchObject({ hidden: true })
  })

  it('refuses when a layer that would leave the frame has comments on it', async () => {
    const host = await grouped()
    const stamped = host.html.replace('data-doop-drawing="rect"', 'data-doop-drawing="rect" data-doop-id="el1"')
    useStore.getState().patchFrameLocal('b', { html: stamped })
    useStore.setState({
      comments: [{ id: 'k', frameId: 'b', elementId: 'el1' } as unknown as ElementComment],
    })
    expect(await ungroupCanvasGroup(live('b')!)).toBe(false)
    expect(createFrame.mock.calls.filter(([, i]) => i.name === 'Back')).toHaveLength(0)
  })
})
