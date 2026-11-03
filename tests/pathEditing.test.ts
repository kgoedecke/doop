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
import type { EditablePath, PathEditSource, PathMatrix } from '../src/lib/pathEditing'
import type { Point } from '../src/lib/drawing'

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

/** The path with one anchor of its first stroke changed. */
function moved<T extends EditablePath>(path: T, index: number, patch: Partial<Point>): T {
  return {
    ...path,
    subpaths: path.subpaths.map((subpath, s) =>
      s ? subpath : { ...subpath, points: subpath.points.map((p, i) => (i === index ? { ...p, ...patch } : p)) },
    ),
  }
}
const anchor = (path: EditablePath, index: number) => path.subpaths[0]!.points[index]!

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
  it.each(['M 0 0 L NaN 2', 'M 0 0 C 10 20', 'M 0 0 M 2 2', 'M 0 0 L 2 2 X', 'M 0 0 Z 2 2'])(
    'rejects malformed or empty paths without rewriting them: %s',
    (data) => {
      expect(parseEditablePath(data)).toBeNull()
    },
  )
  it('reads what a file or an agent wrote: relative commands, shorthands, quadratics and arcs', () => {
    expect(editablePathData(parseEditablePath('m 10 10 h 20 v 20 h -20 z')!)).toBe('M 10 10 L 30 10 L 30 30 L 10 30 Z')
    expect(editablePathData(parseEditablePath('M 0 0 Q 10 20 30 40')!)).toBe('M 0 0 C 6.67 13.33 16.67 26.67 30 40')
    /* a half circle: two quarter-turn cubics, bulging upward */
    const arc = parseEditablePath('M 0 10 A 10 10 0 0 1 20 10')!
    expect(arc.subpaths[0]!.points).toHaveLength(3)
    expect(arc.subpaths[0]!.points[1]!.x).toBeCloseTo(10)
    expect(arc.subpaths[0]!.points[1]!.y).toBeCloseTo(0)
  })
  it('keeps a compound path, a letter with its hole, as one editable path of several strokes', () => {
    const compound = 'M 0 0 L 30 0 L 30 30 L 0 30 Z M 10 10 L 20 10 L 20 20 L 10 20 Z'
    const path = parseEditablePath(compound)!
    expect(path.subpaths).toHaveLength(2)
    expect(editablePathData(path)).toBe(compound)
  })
  it('maps anchors through rotated/scaled matrices and back without moving handles relative to them', () => {
    const matrix: PathMatrix = [1.5, 0.5, -0.5, 1.5, 40, 60]
    const at = { x: -20, y: 70 }
    expect(unmapPathPoint(mapPathPoint(at, matrix), matrix)).toEqual(at)
  })
  it('rebounds standalone paths while keeping untouched anchors at the same canvas position', () => {
    const changed = moved(source, 0, { x: -40, y: -10 })
    const patch = updatePathFrame(frame, source, changed)!
    const doc = new DOMParser().parseFromString(patch.html!, 'text/html')
    const svg = doc.querySelector('svg')!
    const viewBox = svg.getAttribute('viewBox')!.split(' ').map(Number)
    /* an unrotated standalone has no transform: its shell is its box */
    const matrix: PathMatrix = [patch.width! / viewBox[2]!, 0, 0, patch.height! / viewBox[3]!, 0, 0]
    const unchanged = anchor(source, 1)
    const local = mapPathPoint({ x: unchanged.x - viewBox[0]!, y: unchanged.y - viewBox[1]! }, matrix)
    expect({ x: patch.x! + local.x, y: patch.y! + local.y }).toEqual({
      x: frame.x + unchanged.x,
      y: frame.y + unchanged.y,
    })
    expect(patch.width).toBeGreaterThan(frame.width)
  })
  it('keeps an unrotated standalone path filling its shell, so the shell grips still size it', () => {
    /* the drawing tool makes a standalone's root 100% of its shell and the
       shell's grips are the only ones it wears: an edit must leave it that
       way, or the shell would grow around a path that stays put */
    const scaled: PathEditSource = { ...source, matrix: [2, 0, 0, 2, 0, 0], layoutMatrix: [2, 0, 0, 2, 0, 0] }
    const changed = moved(scaled, 0, { x: -40, y: -10 })
    const patch = updatePathFrame(frame, scaled, changed)!
    const svg = new DOMParser().parseFromString(patch.html!, 'text/html').querySelector('svg')!
    expect({ width: svg.style.width, height: svg.style.height, transform: svg.style.transform }).toEqual({
      width: '100%',
      height: '100%',
      transform: 'none',
    })
    const viewBox = svg.getAttribute('viewBox')!.split(' ').map(Number)
    expect(patch.width).toBeCloseTo(viewBox[2]! * 2)
    expect(patch.height).toBeCloseTo(viewBox[3]! * 2)
  })
  it('gives a rotated standalone path its own box and transform', () => {
    const rotated: PathEditSource = {
      ...source,
      matrix: [0.8, 0.6, -0.6, 0.8, 50, 0],
      layoutMatrix: [0.8, 0.6, -0.6, 0.8, 50, 0],
    }
    const patch = updatePathFrame(frame, rotated, rotated)!
    const svg = new DOMParser().parseFromString(patch.html!, 'text/html').querySelector('svg')!
    expect(svg.style.width).toMatch(/px$/)
    expect(svg.style.transform).toMatch(/^matrix\(/)
  })
  it('saves each edit as one undo step, including a standalone bounding-box change', async () => {
    const changed = moved(source, 0, { x: -40 })
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
    await savePathEdit(frame, source, moved(source, 0, { x: 20 }))
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
      await savePathEdit(frame, source, {
        ...source,
        subpaths: source.subpaths.map((sp) => ({ ...sp, points: sp.points.map((p) => ({ ...p, x: p.x + 20 })) })),
      }),
    ).toBeNull()
    expect(useStore.getState().canvas!.frames[0]).toMatchObject(frame)
    await undo()
    expect(api.updateFrame).toHaveBeenCalledTimes(1)
  })

  /* an imported file's shape sits in a group, placed in percentages of it */
  const shapeMarkup = `<svg id="shape" data-doop-drawing="path" data-name="Vector" viewBox="20 20 40 40" preserveAspectRatio="none" style="position:absolute;left:20%;top:20%;width:40%;height:40%;overflow:visible;"><path d="M 22 22 L 58 22 L 58 58 Z" fill="red"></path></svg>`
  const siblingMarkup = `<svg id="other" data-doop-drawing="path" data-name="Other" viewBox="0 0 10 10" preserveAspectRatio="none" style="position:absolute;left:0%;top:0%;width:10%;height:10%;overflow:visible;"><path d="M 0 0 L 10 0 L 10 10 Z"></path></svg>`
  const grouped: Frame = {
    ...frame,
    width: 100,
    height: 100,
    html: `<html><body data-doop-canvas-element="true"><div data-doop-drawing="group" data-name="Icon" style="position:absolute;left:0;top:0;width:100%;height:100%;">${siblingMarkup}${shapeMarkup}</div></body></html>`,
  }
  const shapeSource: PathEditSource = {
    ...parseEditablePath('M 22 22 L 58 22 L 58 58 Z')!,
    selector: '#shape',
    markup: shapeMarkup,
    matrix: [1, 0, 0, 1, 0, 0],
    layoutMatrix: [1, 0, 0, 1, 0, 0],
    parentBox: { x: 0, y: 0, width: 100, height: 100 },
    paint: { fill: 'red', stroke: 'none', strokeWidth: '1px' },
  }
  it('keeps an imported shape laid out in percentages of its group after an edit', () => {
    const patch = updatePathFrame(grouped, shapeSource, moved(shapeSource, 2, { x: 40, y: 58 }))!
    const svg = new DOMParser().parseFromString(patch.html!, 'text/html').querySelector('#shape')! as HTMLElement
    expect(svg.getAttribute('viewBox')).toBe('20 20 40 40')
    expect([svg.style.left, svg.style.top, svg.style.width, svg.style.height]).toEqual(['20%', '20%', '40%', '40%'])
    expect(svg.style.transform).toBe('none')
    expect(patch.width).toBeUndefined()
  })
  it('grows the group around a point dragged past its edge and keeps the other shapes in place', () => {
    const patch = updatePathFrame(grouped, shapeSource, moved(shapeSource, 1, { x: 108, y: 22 }))!
    /* the shell grows 50px to the right (the new anchor plus the 2px pad) and moves nowhere */
    expect({ x: patch.x, y: patch.y, width: patch.width, height: patch.height }).toEqual({
      x: frame.x,
      y: frame.y,
      width: 110,
      height: 100,
    })
    const doc = new DOMParser().parseFromString(patch.html!, 'text/html')
    const other = doc.querySelector('#other')! as HTMLElement
    /* 10px wide at the shell's left: a tenth of 100 became a tenth of 110 */
    expect([other.style.left, other.style.width, other.style.top, other.style.height]).toEqual([
      '0%',
      '9.091%',
      '0%',
      '10%',
    ])
    const shape = doc.querySelector('#shape')! as HTMLElement
    expect(shape.getAttribute('viewBox')).toBe('20 20 90 40')
    expect([shape.style.left, shape.style.width]).toEqual(['18.182%', '81.818%'])
  })
  it('resizes an imported group inside a frame the same way, through its pixel box', () => {
    const inFrame: Frame = {
      ...grouped,
      html: grouped.html
        .replace('data-doop-canvas-element="true"', '')
        .replace('left:0;top:0;width:100%;height:100%;', 'position:fixed;left:50px;top:60px;width:100px;height:100px;'),
    }
    const patch = updatePathFrame(
      inFrame,
      { ...shapeSource, layoutMatrix: [1, 0, 0, 1, 50, 60], parentBox: { x: 50, y: 60, width: 100, height: 100 } },
      moved(shapeSource, 1, { x: 108, y: 22 }),
    )!
    expect(patch.width).toBeUndefined()
    const root = new DOMParser()
      .parseFromString(patch.html!, 'text/html')
      .querySelector('[data-doop-drawing="group"]')! as HTMLElement
    expect([root.style.left, root.style.top, root.style.width, root.style.height]).toEqual([
      '50px',
      '60px',
      '110px',
      '100px',
    ])
  })
})
