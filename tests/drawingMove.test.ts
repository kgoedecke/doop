// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: { createFrame: vi.fn(), updateFrame: vi.fn(), deleteFrame: vi.fn(), getCanvas: vi.fn() },
  errorMessage: (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback),
}))
const { api, ApiError } = await import('../src/lib/api')
const { useStore } = await import('../src/lib/store')
const { clearHistory, undo, redo } = await import('../src/lib/history')
const { drawingDocument, pathDrawing, saveDrawing } = await import('../src/lib/drawing')
const { drawingDropFrame, movableDrawing, moveDrawing } = await import('../src/lib/drawingMove')
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const rect = { x: 230, y: 160, width: 80, height: 80 }
const base: Frame = {
  id: 'target',
  canvasId: 'c',
  pageId: 'first',
  name: 'Target',
  x: 200,
  y: 100,
  width: 400,
  height: 300,
  html: '<h1>Keep me</h1>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Me',
}
const shape: Frame = {
  ...base,
  id: 'shape',
  name: 'Circle',
  x: 0,
  y: 0,
  width: 80,
  height: 80,
  html: drawingDocument({ tool: 'circle', x: 0, y: 0, width: 80, height: 80 }),
}
let db: Map<string, Frame>
const frames = () => useStore.getState().canvas!.frames

function checkVersion(id: string, expectedUpdatedAt?: number) {
  const current = db.get(id)
  if (!current) throw new Error('Not found')
  if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt)
    throw new ApiError(409, JSON.stringify({ error: 'The frame changed.', frame: current }))
  return current
}

beforeEach(() => {
  vi.resetAllMocks()
  clearHistory()
  db = new Map([base, shape].map((f) => [f.id, { ...f }]))
  useStore.getState().setCanvas({
    id: 'c',
    name: 'Test',
    frames: [...db.values()],
    pages: [
      { id: 'first', name: 'Main' },
      { id: 'second', name: 'Other' },
    ],
  } as Canvas)
  useStore.getState().setActivePage('first')
  useStore.getState().select(null)
  useStore.setState({ notice: null })
  let id = 0
  vi.mocked(api.createFrame).mockImplementation(async (canvasId, input) => {
    const frame = { ...base, ...input, canvasId, id: `new-${++id}` }
    db.set(frame.id, frame)
    return frame
  })
  vi.mocked(api.updateFrame).mockImplementation(async (id, patch, expectedUpdatedAt) => {
    const current = checkVersion(id, expectedUpdatedAt)
    const frame = { ...current, ...patch, updatedAt: current.updatedAt + 1 }
    db.set(id, frame)
    return frame
  })
  vi.mocked(api.deleteFrame).mockImplementation(async (id, expectedUpdatedAt) => {
    checkVersion(id, expectedUpdatedAt)
    db.delete(id)
  })
})

describe('moving drawings between frames and canvas', () => {
  it('converts a standalone circle to a frame layer at the drop coordinates, as one undo step', async () => {
    await moveDrawing(shape, undefined, rect, base.id)
    expect(frames()).toHaveLength(1)
    const el = parse(frames()[0]!.html).querySelector<HTMLElement>('[data-doop-drawing]')!
    expect(el.style.left).toBe('30px')
    expect(el.style.top).toBe('60px')
    expect(el.style.width).toBe('80px')
    expect(el.style.borderRadius).toBe('50%')
    expect(frames()[0]!.html).toContain('Keep me')
    await undo()
    expect(frames()).toHaveLength(2)
    expect(frames()[0]!.html).toBe(base.html)
    expect(frames()[1]).toMatchObject({ x: 0, y: 0, width: 80, height: 80, html: shape.html })
    await redo()
    expect(frames()).toHaveLength(1)
    expect(frames()[0]!.html).toContain('data-doop-drawing="circle"')
    expect([...db.values()]).toHaveLength(1)
  })

  it('takes a lifted element into a frame with its carried CSS and its own id', async () => {
    const lifted: Frame = {
      ...shape,
      id: 'lifted',
      name: 'h1',
      html: '<!doctype html>\n<html style="width:100%;height:100%"><head><style data-doop-carried="">[data-doop-carried-scope="old"] { --ink: red; }\n:is([data-doop-carried-scope="old"], [data-doop-carried-scope="old"] *):is(#title) { color: var(--ink); }</style></head><body data-doop-canvas-element="true" style="margin:0"><h1 id="title" data-doop-carried-scope="old" style="position:absolute;left:0;top:0;width:100%;height:100%;margin:0">Hi</h1></body></html>',
    }
    db.set(lifted.id, { ...lifted })
    useStore.getState().upsertFrame({ ...lifted })
    await moveDrawing(lifted, undefined, rect, base.id)
    const dest = frames().find((f) => f.id === base.id)!
    const doc = parse(dest.html)
    const el = doc.querySelector<HTMLElement>('#title')!
    expect(el.style.position).toBe('fixed')
    expect(el.style.left).toBe('30px')
    expect(el.style.width).toBe('80px')
    const scope = el.getAttribute('data-doop-carried-scope')!
    expect(scope).not.toBe('old')
    const carried = doc.querySelector('style[data-doop-carried]')!.textContent!
    expect(carried).toContain(`[data-doop-carried-scope="${scope}"] {\n  --ink: red;`)
    expect(carried).toContain(
      `:is([data-doop-carried-scope="${scope}"], [data-doop-carried-scope="${scope}"] *):is(#title) {`,
    )
    expect(carried).not.toContain('old')
    expect(frames().some((f) => f.id === 'lifted')).toBe(false)
  })

  it('renames a lifted element’s id, and its carried rules, when the frame already uses it', async () => {
    const lifted: Frame = {
      ...shape,
      id: 'lifted',
      name: 'h1',
      html: '<!doctype html>\n<html><head><style data-doop-carried="">:is([data-doop-carried-scope="old"], [data-doop-carried-scope="old"] *):is(#title) { color: red; }</style></head><body data-doop-canvas-element="true" style="margin:0"><h1 id="title" data-doop-carried-scope="old" style="position:absolute;left:0;top:0;width:100%;height:100%;margin:0">Hi</h1></body></html>',
    }
    const taken: Frame = {
      ...base,
      id: 'taken',
      name: 'Taken',
      html: '<b id="title"></b><h1>Keep me</h1>',
    }
    db.set(lifted.id, { ...lifted })
    db.set(taken.id, { ...taken })
    useStore.getState().upsertFrame({ ...lifted })
    useStore.getState().upsertFrame({ ...taken })
    await moveDrawing(lifted, undefined, rect, taken.id)
    const doc = parse(frames().find((f) => f.id === taken.id)!.html)
    expect(doc.querySelectorAll('#title')).toHaveLength(1)
    expect(doc.querySelector('b#title')).not.toBeNull()
    expect(doc.querySelector('h1#title-copy')).not.toBeNull()
    expect(doc.querySelector('style[data-doop-carried]')!.textContent).toContain(':is(#title-copy) {')
  })

  it('preserves SVG curves and edited styles through frame-to-frame moves and detaching', async () => {
    const curve = {
      ...shape,
      html: drawingDocument(
        pathDrawing([
          { x: 10, y: 10, handle: { x: 30, y: -50 } },
          { x: 100, y: 100 },
        ]),
      ),
    }
    db.set(shape.id, curve)
    useStore.getState().upsertFrame(curve)
    await moveDrawing(curve, undefined, rect, base.id)
    const first = frames()[0]!
    const el = parse(first.html).querySelector<SVGSVGElement>('svg')!
    const path = el.querySelector('path')!.getAttribute('d')
    const other = { ...base, id: 'other', x: 700 }
    db.set(other.id, other)
    useStore.getState().upsertFrame(other)
    await moveDrawing(first, `#${el.id}`, { ...rect, x: 750 }, other.id)
    expect(frames()[0]!.html).not.toContain('<svg')
    const second = frames().find((f) => f.id === other.id)!
    const moved = parse(second.html).querySelector<SVGSVGElement>('svg')!
    expect(moved.style.left).toBe('50px')
    expect(moved.querySelector('path')!.getAttribute('d')).toBe(path)
    await moveDrawing(second, `#${moved.id}`, { ...rect, x: -100 })
    const detached = frames().at(-1)!
    expect(detached).toMatchObject({ x: -100, y: 160, width: 80, height: 80, pageId: 'first' })
    expect(parse(detached.html).querySelector('path')!.getAttribute('d')).toBe(path)
    await undo()
    expect(frames().find((f) => f.id === other.id)!.html).toBe(second.html)
    await undo()
    expect(frames()[0]!.html).toBe(first.html)
    expect(frames().find((f) => f.id === other.id)!.html).toBe(other.html)
  })

  it('repositions an existing layer within its own frame without duplicating it', async () => {
    await moveDrawing(shape, undefined, rect, base.id)
    const source = frames()[0]!
    const id = parse(source.html).querySelector('[data-doop-drawing]')!.id
    await moveDrawing(source, `#${id}`, { ...rect, x: 260 }, source.id)
    const doc = parse(frames()[0]!.html)
    expect(doc.querySelectorAll('[data-doop-drawing]')).toHaveLength(1)
    expect(doc.querySelector<HTMLElement>(`#${id}`)!.style.left).toBe('60px')
    await undo()
    expect(frames()[0]!.html).toBe(source.html)
  })

  it('rejects locked, hidden, stale, and cross-page targets without removing the source', async () => {
    for (const patch of [{ locked: true }, { hidden: true }, { pageId: 'second' }]) {
      useStore.getState().upsertFrame({ ...base, ...patch })
      await moveDrawing(shape, undefined, rect, base.id)
    }
    useStore.getState().upsertFrame({ ...shape, html: shape.html + '<!-- changed -->' })
    await moveDrawing(shape, undefined, rect, base.id)
    expect(api.updateFrame).not.toHaveBeenCalled()
    expect(api.deleteFrame).not.toHaveBeenCalled()
    expect(movableDrawing({ ...shape, locked: true })).toBeNull()
    expect(
      movableDrawing({
        ...shape,
        html: shape.html.replace('data-doop-drawing=', 'data-doop-locked="true" data-doop-drawing='),
      }),
    ).toBeNull()
  })

  it('highlights the topmost regular frame on the active page while ignoring the dragged shape', () => {
    expect(drawingDropFrame({ x: 300, y: 200 }, shape.id)?.id).toBe(base.id)
    useStore.getState().upsertFrame({ ...base, id: 'front', locked: true })
    expect(drawingDropFrame({ x: 300, y: 200 }, shape.id)).toBeNull()
    useStore.getState().patchFrameLocal('front', { hidden: true })
    expect(drawingDropFrame({ x: 300, y: 200 }, shape.id)?.id).toBe(base.id)
    useStore.getState().setActivePage('second')
    expect(drawingDropFrame({ x: 300, y: 200 }, shape.id)).toBeNull()
  })

  it('keeps the original on a failed destination save, and rolls back a failed source removal', async () => {
    vi.mocked(api.updateFrame).mockRejectedValueOnce(new Error('Offline'))
    await moveDrawing(shape, undefined, rect, base.id)
    expect(api.deleteFrame).not.toHaveBeenCalled()
    expect(frames()).toHaveLength(2)
    vi.mocked(api.deleteFrame).mockRejectedValueOnce(new Error('Offline'))
    await moveDrawing(shape, undefined, rect, base.id)
    expect(frames()[0]!.html).toBe(base.html)
    expect(frames()).toHaveLength(2)
    expect(db.get(base.id)!.html).toBe(base.html)
    await undo()
    expect(frames()).toHaveLength(2)
  })

  it('does not remove the destination when undo cannot recreate the original, and permits retry', async () => {
    await moveDrawing(shape, undefined, rect, base.id)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(api.createFrame).mockRejectedValueOnce(new Error('Offline'))
    await undo()
    expect(frames()).toHaveLength(1)
    expect(frames()[0]!.html).toContain('data-doop-drawing')
    await undo()
    expect(frames()).toHaveLength(2)
    expect(frames()[0]!.html).toBe(base.html)
    log.mockRestore()
  })

  it('preserves a collaborator’s destination edit when rolling back a failed move', async () => {
    vi.mocked(api.deleteFrame).mockImplementationOnce(async () => {
      useStore
        .getState()
        .patchFrameLocal(base.id, { html: frames()[0]!.html.replace('</body>', '<p>Remote edit</p></body>') })
      throw new Error('Offline')
    })
    await moveDrawing(shape, undefined, rect, base.id)
    expect(frames()[0]!.html).toContain('Remote edit')
    expect(frames()[0]!.html).not.toContain('data-doop-drawing')
    expect(frames()).toHaveLength(2)
  })

  it('serializes a move with an in-flight drawing creation in the same destination', async () => {
    let release!: () => void
    vi.mocked(api.updateFrame).mockImplementationOnce(async (id, patch) => {
      await new Promise<void>((done) => {
        release = done
      })
      const saved = { ...db.get(id)!, ...patch }
      db.set(id, saved)
      return saved
    })
    const creating = saveDrawing({ tool: 'rectangle', ...rect }, { canvasId: 'c', pageId: 'first', frameId: base.id })
    const moving = moveDrawing(shape, undefined, rect, base.id)
    await Promise.resolve()
    expect(api.updateFrame).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([creating, moving])
    expect(parse(frames()[0]!.html).querySelectorAll('[data-doop-drawing]')).toHaveLength(2)
    await undo()
    expect(frames()[0]!.html).toContain('data-doop-drawing="rectangle"')
    expect(frames()[0]!.html).not.toContain('data-doop-drawing="circle"')
  })

  it.each([{ html: '<p>Later work</p>' }, { name: 'Renamed copy' }, { x: 999, width: 160 }, { pageId: 'second' }])(
    'keeps an edited detached copy when its source save fails: %j',
    async (patch) => {
      await moveDrawing(shape, undefined, rect, base.id)
      const source = frames()[0]!
      const selector = `#${parse(source.html).querySelector('[data-doop-drawing]')!.id}`
      vi.mocked(api.deleteFrame).mockClear()
      vi.mocked(api.updateFrame).mockImplementationOnce(async () => {
        const copy = frames().find((f) => f.id !== source.id)!
        const edited = { ...copy, ...patch }
        db.set(copy.id, edited)
        useStore.getState().upsertFrame(edited)
        throw new Error('Source save failed')
      })
      await moveDrawing(source, selector, { ...rect, x: -100 })
      expect(api.deleteFrame).not.toHaveBeenCalled()
      expect(frames()).toHaveLength(2)
      expect(frames()[0]!.html).toBe(source.html)
      expect(frames()[1]).toMatchObject(patch)
      expect(useStore.getState().notice?.text).toContain('kept because it was edited')
    },
  )

  it('checks the original canvas before rolling back a detached copy after navigation', async () => {
    await moveDrawing(shape, undefined, rect, base.id)
    const source = frames()[0]!
    const selector = `#${parse(source.html).querySelector('[data-doop-drawing]')!.id}`
    const canvas = useStore.getState().canvas!
    vi.mocked(api.deleteFrame).mockClear()
    vi.mocked(api.getCanvas).mockImplementation(async () => ({ ...canvas, frames: [...db.values()] }))
    vi.mocked(api.updateFrame).mockImplementationOnce(async () => {
      const copy = frames().find((f) => f.id !== source.id)!
      db.set(copy.id, { ...copy, html: '<p>Remote edit after navigation</p>' })
      useStore.getState().setCanvas({ ...canvas, id: 'other', frames: [] })
      throw new Error('Source save failed')
    })
    await moveDrawing(source, selector, { ...rect, x: -100 })
    expect(api.getCanvas).toHaveBeenCalledWith('c')
    expect(api.deleteFrame).not.toHaveBeenCalled()
    expect([...db.values()].some((f) => f.html.includes('Remote edit after navigation'))).toBe(true)
    expect(useStore.getState().canvas).toMatchObject({ id: 'other', frames: [] })
  })

  it('still removes an unchanged detached copy when its source save fails', async () => {
    await moveDrawing(shape, undefined, rect, base.id)
    const source = frames()[0]!
    const selector = `#${parse(source.html).querySelector('[data-doop-drawing]')!.id}`
    vi.mocked(api.deleteFrame).mockClear()
    vi.mocked(api.updateFrame).mockRejectedValueOnce(new Error('Source save failed'))
    await moveDrawing(source, selector, { ...rect, x: -100 })
    expect(api.deleteFrame).toHaveBeenCalledTimes(1)
    expect(frames()).toHaveLength(1)
    expect(frames()[0]).toMatchObject({ id: source.id, html: source.html })
  })
  it('rejects an unseen destination edit instead of replacing it with the drawing', async () => {
    const remote = { ...base, html: '<h1>Remote work</h1>', updatedAt: 1 }
    db.set(base.id, remote)
    await moveDrawing(shape, undefined, rect, base.id)
    expect(db.get(base.id)).toEqual(remote)
    expect(db.get(shape.id)).toEqual(shape)
    expect(api.deleteFrame).not.toHaveBeenCalled()
    expect(frames().find((f) => f.id === base.id)).toEqual(remote)
  })

  it('does not bring back a destination deleted while its conflict response was in flight', async () => {
    const update = vi.mocked(api.updateFrame).getMockImplementation()!
    db.set(base.id, { ...base, html: '<h1>Remote work</h1>', updatedAt: 1 })
    vi.mocked(api.updateFrame).mockImplementationOnce(async (...args) => {
      useStore.getState().removeFrame(base.id)
      return update(...args)
    })
    await moveDrawing(shape, undefined, rect, base.id)
    expect(frames().find((f) => f.id === base.id)).toBeUndefined()
    expect(db.get(shape.id)).toEqual(shape)
  })

  it('keeps a standalone source edited on the server just before deletion', async () => {
    const remove = vi.mocked(api.deleteFrame).getMockImplementation()!
    const remote = { ...shape, html: shape.html + '<p>Remote work</p>', updatedAt: 1 }
    vi.mocked(api.deleteFrame).mockImplementationOnce(async (...args) => {
      db.set(shape.id, remote)
      return remove(...args)
    })
    await moveDrawing(shape, undefined, rect, base.id)
    expect(db.get(shape.id)).toEqual(remote)
    expect(db.get(base.id)?.html).toBe(base.html)
    expect(frames().find((f) => f.id === shape.id)).toEqual(remote)
  })

  it('keeps unseen edits to an embedded source when its removal conflicts', async () => {
    await moveDrawing(shape, undefined, rect, base.id)
    const source = frames()[0]!
    const selector = `#${parse(source.html).querySelector('[data-doop-drawing]')!.id}`
    const remote = { ...source, html: source.html + '<p>Remote work</p>', updatedAt: source.updatedAt + 1 }
    db.set(source.id, remote)
    await moveDrawing(source, selector, { ...rect, x: -100 })
    expect([...db.values()]).toEqual([remote])
    expect(frames()).toEqual([remote])
  })

  it('does not overwrite an unseen destination edit during rollback, including on undo', async () => {
    const remove = vi.mocked(api.deleteFrame).getMockImplementation()!
    let remote!: Frame
    vi.mocked(api.deleteFrame).mockImplementationOnce(async (...args) => {
      const destination = db.get(base.id)!
      remote = { ...destination, html: destination.html + '<p>Remote work</p>', updatedAt: destination.updatedAt + 1 }
      db.set(base.id, remote)
      db.set(shape.id, { ...shape, updatedAt: 1 })
      return remove(...args)
    })
    await moveDrawing(shape, undefined, rect, base.id)
    expect(db.get(base.id)).toEqual(remote)
    expect(db.has(shape.id)).toBe(true)
    expect(useStore.getState().notice?.text).toContain('Both copies were kept')
    expect(frames().find((f) => f.id === base.id)).toEqual(remote)
    await undo()
    expect(db.get(base.id)).toEqual(remote)
  })

  it('does not delete a detached copy edited on the server before rollback', async () => {
    await moveDrawing(shape, undefined, rect, base.id)
    clearHistory()
    const source = frames()[0]!
    const selector = `#${parse(source.html).querySelector('[data-doop-drawing]')!.id}`
    const update = vi.mocked(api.updateFrame).getMockImplementation()!
    let remote!: Frame
    vi.mocked(api.updateFrame).mockImplementationOnce(async (...args) => {
      const copy = [...db.values()].find((f) => f.id !== source.id)!
      remote = { ...copy, html: copy.html + '<p>Remote copy edit</p>', updatedAt: copy.updatedAt + 1 }
      db.set(copy.id, remote)
      db.set(source.id, { ...source, updatedAt: source.updatedAt + 1 })
      return update(...args)
    })
    await moveDrawing(source, selector, { ...rect, x: -100 })
    expect(db.get(remote.id)).toEqual(remote)
    expect(db.get(source.id)?.html).toBe(source.html)
    await undo()
    expect(db.get(remote.id)).toEqual(remote)
  })

  it('rejects a stale same-frame drawing move', async () => {
    await moveDrawing(shape, undefined, rect, base.id)
    const source = frames()[0]!
    const selector = `#${parse(source.html).querySelector('[data-doop-drawing]')!.id}`
    const remote = { ...source, html: source.html + '<p>Remote work</p>', updatedAt: source.updatedAt + 1 }
    db.set(source.id, remote)
    await moveDrawing(source, selector, { ...rect, x: 260 }, source.id)
    expect(db.get(source.id)).toEqual(remote)
  })
})
