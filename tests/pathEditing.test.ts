// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: { updateFrame: vi.fn(), getCanvas: vi.fn() },
  errorMessage: (e: Error) => e.message,
}))
const { api, ApiError } = await import('../src/lib/api')
const { useStore } = await import('../src/lib/store')
const { undo, redo, clearHistory } = await import('../src/lib/history')
const { nearestPathAnchor } = await import('../src/lib/drawing')
const { parseEditablePath, editablePathData, mapPathPoint, unmapPathPoint, updatePathFrame, savePathEdit } =
  await import('../src/lib/pathEditing')
import type { PathEditSource, PathMatrix } from '../src/lib/pathEditing'

const data = 'M 10 40 C 20 10 70 70 90 40'
const markup = `<svg id="pen" data-doop-drawing="path" viewBox="0 0 100 80"><path d="${data}" fill="none" stroke="black"></path></svg>`
const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Path',
  pageId: 'p',
  x: 100,
  y: 200,
  width: 100,
  height: 80,
  html: `<html><body data-doop-canvas-element="true">${markup}</body></html>`,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'User',
}
const source: PathEditSource = {
  ...parseEditablePath(data)!,
  selector: '#pen',
  markup,
  matrix: [1, 0, 0, 1, 0, 0],
  layoutMatrix: [1, 0, 0, 1, 0, 0],
  paint: { fill: 'none', stroke: 'black', strokeWidth: '2px' },
}

beforeEach(() => {
  vi.resetAllMocks()
  clearHistory()
  useStore.getState().setCanvas({
    id: 'c',
    name: 'Canvas',
    pages: [{ id: 'p', name: 'Page' }],
    frames: [frame],
    createdAt: 0,
    updatedAt: 0,
  } as Canvas)
  vi.mocked(api.updateFrame).mockImplementation(async (id, patch) => ({
    ...useStore.getState().canvas!.frames.find((f) => f.id === id)!,
    ...patch,
  }))
})

describe('pen anchor snapping', () => {
  it.each([0.25, 1, 2, 3])('uses eight screen pixels at zoom %s and chooses the nearest anchor', (zoom) => {
    const points = [
      { x: 10, y: 20 },
      { x: 100, y: 20 },
    ]
    expect(nearestPathAnchor(points, { x: 10 + 7.9 / zoom, y: 20 }, zoom)).toBe(0)
    expect(nearestPathAnchor(points, { x: 10 + 8.1 / zoom, y: 20 }, zoom)).toBeNull()
    expect(nearestPathAnchor(points, { x: 100, y: 20 }, zoom, 1)).toBeNull()
  })
})

describe('editable vector paths', () => {
  it.each(['M 2 2 L 102 2 L 102 82 Z', data, `${data} C 110 10 0 70 10 40 Z`])(
    'round trips native pen paths: %s',
    (data) => {
      expect(editablePathData(parseEditablePath(data)!)).toBe(data)
    },
  )
  it.each(['M 0 0 Q 10 20 30 40', 'M 0 0 L NaN 2', 'M 0 0 C 10 20', 'M 0 0 M 2 2', 'M 0 0 Z L 2 2'])(
    'rejects unsupported or malformed paths without rewriting them: %s',
    (data) => {
      expect(parseEditablePath(data)).toBeNull()
    },
  )
  it('maps anchors through rotated/scaled matrices and back without moving handles relative to them', () => {
    const matrix: PathMatrix = [1.5, 0.5, -0.5, 1.5, 40, 60]
    const at = { x: -20, y: 70 }
    expect(unmapPathPoint(mapPathPoint(at, matrix), matrix)).toEqual(at)
  })
  it('rebounds standalone paths while keeping untouched anchors at the same canvas position', () => {
    const changed = { ...source, points: source.points.map((p, i) => (i ? p : { ...p, x: -40, y: -10 })) }
    const patch = updatePathFrame(frame, source, changed)!
    const doc = new DOMParser().parseFromString(patch.html!, 'text/html')
    const svg = doc.querySelector('svg')!
    const matrix = svg.style.transform.match(/[-+]?\d*\.?\d+/g)!.map(Number) as PathMatrix
    const viewBox = svg.getAttribute('viewBox')!.split(' ').map(Number)
    const unchanged = source.points[1]!
    const local = mapPathPoint({ x: unchanged.x - viewBox[0]!, y: unchanged.y - viewBox[1]! }, matrix)
    expect({ x: patch.x! + local.x, y: patch.y! + local.y }).toEqual({
      x: frame.x + unchanged.x,
      y: frame.y + unchanged.y,
    })
    expect(patch.width).toBeGreaterThan(frame.width)
  })
  it('saves each edit as one undo step, including a standalone bounding-box change', async () => {
    const changed = { ...source, points: source.points.map((p, i) => (i ? p : { ...p, x: -40 })) }
    const saved = await savePathEdit(frame, source, changed)
    expect(saved?.x).toBeLessThan(frame.x)
    expect(api.updateFrame).toHaveBeenCalledWith(frame.id, expect.any(Object), frame.updatedAt)
    await undo()
    expect(useStore.getState().canvas!.frames[0]).toMatchObject(frame)
    await redo()
    expect(useStore.getState().canvas!.frames[0]).toMatchObject(saved!)
  })
  it('keeps other layers added since editing started', async () => {
    useStore
      .getState()
      .patchFrameLocal(frame.id, { html: frame.html.replace('</body>', '<p>Remote addition</p></body>') })
    await savePathEdit(frame, source, { ...source, points: source.points.map((p, i) => (i ? p : { ...p, x: 20 })) })
    expect(useStore.getState().canvas!.frames[0]!.html).toContain('Remote addition')
  })
  it('refuses to overwrite a path changed by another editor', async () => {
    const html = frame.html.replace(data, 'M 0 0 L 50 50')
    useStore.getState().patchFrameLocal(frame.id, { html })
    expect(await savePathEdit(frame, source, source)).toBeNull()
    expect(api.updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas!.frames[0]!.html).toBe(html)
  })
  it('does not save into a frame locked during editing', async () => {
    useStore.getState().patchFrameLocal(frame.id, { locked: true })
    expect(await savePathEdit(frame, source, source)).toBeNull()
    expect(api.updateFrame).not.toHaveBeenCalled()
  })
  it('loads the winning server version after a conflicting save without recording an undo step', async () => {
    const remote = { ...frame, updatedAt: 1, html: frame.html.replace('</body>', '<p>Remote addition</p></body>') }
    vi.mocked(api.updateFrame).mockRejectedValueOnce(new ApiError(409, JSON.stringify({ frame: remote })))
    expect(await savePathEdit(frame, source, source)).toBeNull()
    expect(useStore.getState().canvas!.frames[0]).toEqual(remote)
    await undo()
    expect(api.updateFrame).toHaveBeenCalledTimes(1)
  })
  it('does not replace a newer room update with a delayed successful save response', async () => {
    const remote = { ...frame, updatedAt: 2, html: frame.html.replace('</body>', '<p>Newer edit</p></body>') }
    vi.mocked(api.updateFrame).mockImplementationOnce(async (_id, patch) => {
      useStore.getState().upsertFrame(remote)
      return { ...frame, ...patch, updatedAt: 1 }
    })
    expect(await savePathEdit(frame, source, source)).not.toBeNull()
    expect(useStore.getState().canvas!.frames[0]).toEqual(remote)
  })
  it('leaves the saved path and undo history intact after a failed save', async () => {
    vi.mocked(api.updateFrame).mockRejectedValueOnce(new Error('Offline'))
    expect(
      await savePathEdit(frame, source, { ...source, points: source.points.map((p) => ({ ...p, x: p.x + 20 })) }),
    ).toBeNull()
    expect(useStore.getState().canvas!.frames[0]).toMatchObject(frame)
    await undo()
    expect(api.updateFrame).toHaveBeenCalledTimes(1)
  })
})
