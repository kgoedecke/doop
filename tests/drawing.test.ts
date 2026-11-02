// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', () => ({
  api: { createFrame: vi.fn(), updateFrame: vi.fn(), deleteFrame: vi.fn(), getCanvas: vi.fn() },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
const { api } = await import('../src/lib/api')
const { buildLayerTree, layerName } = await import('../src/lib/layers')
const { useStore } = await import('../src/lib/store')
const { undo, redo, clearHistory } = await import('../src/lib/history')
const { drawingBounds, drawingDocument, drawingTarget, isCanvasElement, pathData, pathDrawing, saveDrawing } =
  await import('../src/lib/drawing')
const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  pageId: 'first',
  name: 'Design',
  html: '<h1>Original</h1>',
  x: 100,
  y: 50,
  width: 600,
  height: 400,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'User',
}
const box = { tool: 'rectangle' as const, x: 120, y: 80, width: 100, height: 60 }
const target = { canvasId: 'c', pageId: 'first' }

beforeEach(() => {
  vi.resetAllMocks()
  clearHistory()
  useStore.getState().setCanvas({
    id: 'c',
    name: 'Test',
    frames: [frame],
    pages: [
      { id: 'first', name: 'Main' },
      { id: 'second', name: 'Other' },
    ],
  } as Canvas)
  useStore.getState().setActivePage('first')
  useStore.getState().select(null)
  useStore.setState({ notice: null })
  let next = 0
  vi.mocked(api.createFrame).mockImplementation(async (canvasId, input) => ({
    ...frame,
    ...input,
    canvasId,
    id: `created-${++next}`,
  }))
  vi.mocked(api.updateFrame).mockImplementation(async (id, input) => ({
    ...useStore.getState().canvas!.frames.find((f) => f.id === id)!,
    ...input,
  }))
})

describe('drawing geometry and markup', () => {
  it('normalizes reverse drags and constrains circles and Shift rectangles', () => {
    expect(drawingBounds('rectangle', { x: 100, y: 80 }, { x: 20, y: 30 })).toMatchObject({
      x: 20,
      y: 30,
      width: 80,
      height: 50,
    })
    for (const tool of ['rectangle', 'circle'] as const) {
      expect(drawingBounds(tool, { x: 100, y: 80 }, { x: 20, y: 30 }, true)).toMatchObject({
        x: 20,
        y: 0,
        width: 80,
        height: 80,
      })
    }
  })

  it('keeps axis-aligned paths visible, and serializes closed vectors as SVG', () => {
    const path = pathDrawing(
      [
        { x: -10, y: 20 },
        { x: 90, y: 20 },
      ],
      true,
    )
    expect(path).toMatchObject({ x: -12, y: 18, width: 104, height: 4 })
    expect(pathData(path)).toBe('M 2 2 L 102 2 Z')
    const svg = doc(drawingDocument(path)).querySelector('svg')!
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(svg.querySelector('path')?.getAttribute('d')).toBe('M 2 2 L 102 2 Z')
  })

  it('escapes text and marks only standalone elements as transparent', () => {
    const html = drawingDocument({ ...box, tool: 'text', text: '<img src=x onerror=alert(1)>\n& hello' })
    expect(doc(html).querySelector('img')).toBeNull()
    expect(doc(html).querySelector('p')?.textContent).toBe('<img src=x onerror=alert(1)>\n& hello')
    expect(isCanvasElement(html)).toBe(true)
    expect(isCanvasElement(drawingDocument({ ...box, tool: 'frame' }))).toBe(false)
  })

  it('bounds cubic curves by their extrema and includes curved closing segments', () => {
    const curve = pathDrawing([
      { x: 100, y: 100, handle: { x: 0, y: -100 } },
      { x: 200, y: 100, handle: { x: 0, y: 100 } },
    ])
    expect(curve).toMatchObject({ x: 98, y: 23, width: 104, height: 79 })
    expect(pathData(curve)).toBe('M 2 77 C 2 -23 102 -23 102 77')
    const closed = pathDrawing(curve.points!, true)
    expect(closed).toMatchObject({ x: 98, y: 23, width: 104, height: 154 })
    expect(pathData(closed)).toBe('M 2 77 C 2 -23 102 -23 102 77 C 102 177 2 177 2 77 Z')
    expect(doc(drawingDocument(curve)).querySelector('path')!.getAttribute('d')).toBe(pathData(curve))
  })
})

describe('saving and targeting drawings', () => {
  it('targets the topmost visible unlocked frame on the active page; frames are always standalone', () => {
    expect(drawingTarget({ x: 130, y: 90 }, 'rectangle')).toMatchObject({ frameId: 'f' })
    expect(drawingTarget({ x: 130, y: 90 }, 'frame')?.frameId).toBeUndefined()
    for (const patch of [{ locked: true }, { hidden: true }, { pageId: 'second' }, { html: drawingDocument(box) }]) {
      useStore.getState().patchFrameLocal('f', { ...frame, ...patch })
      expect(drawingTarget({ x: 130, y: 90 }, 'rectangle')?.frameId).toBeUndefined()
    }
  })

  it('persists and selects a standalone element on the current page, with undo/redo', async () => {
    await saveDrawing(box, target)
    expect(api.createFrame).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ pageId: 'first', x: 120, y: 80, width: 100, height: 60 }),
    )
    expect(useStore.getState().selectedId).toBe('created-1')
    await undo()
    expect(api.deleteFrame).toHaveBeenCalledWith('created-1')
    await redo()
    expect(useStore.getState().canvas?.frames.find((f) => f.id === 'created-2')?.html).toContain(
      'data-doop-drawing="rectangle"',
    )
  })

  it('appends to the latest HTML at frame-local coordinates and undoes each gesture separately', async () => {
    useStore.getState().patchFrameLocal('f', { html: '<h1>Collaborator edit</h1>' })
    await Promise.all([
      saveDrawing(box, { ...target, frameId: 'f' }),
      saveDrawing({ ...box, tool: 'circle' }, { ...target, frameId: 'f' }),
    ])
    const current = () => doc(useStore.getState().canvas!.frames[0]!.html)
    expect(current().querySelector('h1')?.textContent).toBe('Collaborator edit')
    expect(current().querySelectorAll('[data-doop-drawing]')).toHaveLength(2)
    const rect = current().querySelector<HTMLElement>('[data-doop-drawing="rectangle"]')!
    expect(rect.style.left).toBe('20px')
    expect(rect.style.top).toBe('30px')
    expect(buildLayerTree(useStore.getState().canvas!.frames[0]!.html).map(layerName)).toEqual([
      'Collaborator edit',
      'Rectangle',
      'Circle',
    ])
    await undo()
    expect(current().querySelectorAll('[data-doop-drawing]')).toHaveLength(1)
    await undo()
    expect(current().querySelectorAll('[data-doop-drawing]')).toHaveLength(0)
    expect(current().querySelector('h1')?.textContent).toBe('Collaborator edit')
  })

  it('reports drawings that cannot be inserted into a locked/deleted frame', async () => {
    useStore.getState().patchFrameLocal('f', { locked: true })
    await saveDrawing(box, { ...target, frameId: 'f' })
    useStore.getState().removeFrame('f')
    await saveDrawing(box, { ...target, frameId: 'f' })
    expect(api.updateFrame).not.toHaveBeenCalled()
    expect(api.createFrame).not.toHaveBeenCalled()
    expect(useStore.getState().notice?.text).toContain('deleted, locked, or hidden')
  })

  it('keeps Bézier tangents unchanged when translating a path into a frame', async () => {
    const curve = pathDrawing([
      { x: 120, y: 80, handle: { x: 40, y: -60 } },
      { x: 280, y: 160, handle: { x: 20, y: 40 } },
    ])
    await saveDrawing(curve, { ...target, frameId: 'f' })
    const saved = doc(useStore.getState().canvas!.frames[0]!.html)
    expect(saved.querySelector('path')!.getAttribute('d')).toBe(pathData(curve))
    expect(saved.querySelector<SVGSVGElement>('svg')!.style.left).toBe(`${curve.x - frame.x}px`)
  })

  it('saves completed queued drawings on their original page after navigation without stealing selection', async () => {
    let resolve!: (frame: Frame) => void
    vi.mocked(api.createFrame).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const first = saveDrawing(box, target)
    const second = saveDrawing({ ...box, tool: 'circle' }, target)
    const layer = saveDrawing(box, { ...target, frameId: 'f' })
    await Promise.resolve()
    useStore.getState().setActivePage('second')
    resolve({ ...frame, id: 'pending', html: drawingDocument(box) })
    await Promise.all([first, second, layer])
    expect(api.createFrame).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(api.createFrame).mock.calls) {
      expect(call).toEqual(['c', expect.objectContaining({ pageId: 'first' })])
    }
    expect(api.updateFrame).toHaveBeenCalledWith('f', {
      html: expect.stringContaining('data-doop-drawing="rectangle"'),
    })
    expect(useStore.getState().canvas?.frames).toHaveLength(3)
    expect(useStore.getState()).toMatchObject({ activePageId: 'second', selectedId: null, selectedElement: null })
    await undo()
    expect(useStore.getState().canvas?.frames.find((f) => f.id === 'f')?.html).toBe(frame.html)
  })

  it('finishes queued saves after leaving the canvas, without affecting the newly opened canvas or history', async () => {
    let resolve!: (frame: Frame) => void
    vi.mocked(api.createFrame).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const originalCanvas = useStore.getState().canvas!
    vi.mocked(api.getCanvas).mockResolvedValue({
      ...originalCanvas,
      frames: [{ ...frame, html: '<p>Latest remote edit</p>' }],
    })
    vi.mocked(api.updateFrame).mockImplementation(async (_id, patch) => ({ ...frame, ...patch }))
    const first = saveDrawing(box, target)
    const layer = saveDrawing(box, { ...target, frameId: 'f' })
    const second = saveDrawing({ ...box, tool: 'circle' }, target)
    await Promise.resolve()
    const otherFrame = { ...frame, id: 'other-frame', canvasId: 'other' }
    useStore.getState().setCanvas({ ...originalCanvas, id: 'other', frames: [otherFrame] })
    useStore.getState().select(otherFrame.id)
    clearHistory()
    resolve({ ...frame, id: 'pending' })
    await Promise.all([first, layer, second])
    expect(api.getCanvas).toHaveBeenCalledWith('c')
    const html = vi.mocked(api.updateFrame).mock.calls[0]![1].html!
    expect(html).toContain('Latest remote edit')
    expect(html).toContain('data-doop-drawing="rectangle"')
    expect(api.createFrame).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.createFrame).mock.calls[1]).toEqual(['c', expect.objectContaining({ pageId: 'first' })])
    expect(useStore.getState().canvas?.frames).toEqual([otherFrame])
    expect(useStore.getState().selectedId).toBe(otherFrame.id)
    await undo()
    expect(api.deleteFrame).not.toHaveBeenCalled()
    expect(api.updateFrame).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight creation before undoing it', async () => {
    let resolve!: (frame: Frame) => void
    vi.mocked(api.createFrame).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const saving = saveDrawing(box, target)
    const undoing = undo()
    await Promise.resolve()
    resolve({ ...frame, id: 'pending', html: drawingDocument(box) })
    await Promise.all([saving, undoing])
    expect(api.deleteFrame).toHaveBeenCalledWith('pending')
  })

  it('reports failures without adding a local frame or an undo entry', async () => {
    vi.mocked(api.createFrame).mockRejectedValueOnce(new Error('Offline'))
    await saveDrawing(box, target)
    expect(useStore.getState().notice?.text).toContain('Couldn’t save')
    expect(useStore.getState().canvas?.frames).toHaveLength(1)
    await undo()
    expect(api.deleteFrame).not.toHaveBeenCalled()
  })
})
