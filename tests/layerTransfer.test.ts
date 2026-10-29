// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const updateFrame = vi.fn((id: string, _patch: unknown, _expected?: number) =>
  Promise.resolve({ ...frameWith(id, ''), updatedAt: 7 } as Frame),
)
const deleteFrame = vi.fn((_id: string, _expected?: number) => Promise.resolve())
const createFrame = vi.fn((canvasId: string, input: Partial<Frame> & { name: string }) =>
  Promise.resolve({ ...frameWith('new', ''), canvasId, ...input } as Frame),
)
vi.mock('../src/lib/api', () => ({
  api: {
    updateFrame: (id: string, patch: unknown, expected?: number) => updateFrame(id, patch, expected),
    deleteFrame: (id: string, expected?: number) => deleteFrame(id, expected),
    createFrame: (canvasId: string, input: Partial<Frame> & { name: string }) => createFrame(canvasId, input),
  },
  errorMessage: (_err: unknown, fallback: string) => fallback,
  ApiError: class extends Error {},
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
const inspect = vi.fn(() => Promise.resolve({ rect: { x: 10, y: 20, width: 50, height: 30 } }))
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: () => Promise.resolve(null),
  inspectElement: () => inspect(),
}))

const { useStore } = await import('../src/lib/store')
const { ApiError } = await import('../src/lib/api')
const { placeElement } = await import('../src/lib/layers')
const { detachLayer, standaloneSelector, transferLayer } = await import('../src/lib/layerEdits')
const { clearHistory, undo, redo } = await import('../src/lib/history')

const page = (body: string) => `<!doctype html>\n<html><head></head><body>${body}</body></html>`

function frameWith(id: string, html: string, extra: Partial<Frame> = {}): Frame {
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
    ...extra,
  }
}

function holdCanvas(...frames: Frame[]) {
  const canvas: Canvas = { id: 'c1', name: 'Canvas', frames } as Canvas
  useStore.setState({ canvas, selectedId: null, selectedIds: [], selectedElement: null })
}

const html = (id: string) => useStore.getState().canvas?.frames.find((f) => f.id === id)?.html

const P_B = 'body:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(2)'
const SECTION = 'body:nth-of-type(1) > section:nth-of-type(1)'

describe('placeElement', () => {
  it('puts the markup into, before or after the target', () => {
    const dest = page('<section><em>x</em></section>')
    expect(placeElement(dest, { selector: SECTION, place: 'inside' }, '<p>B</p>')?.html).toContain(
      '<section><p>B</p><em>x</em></section>',
    )
    expect(placeElement(dest, { selector: SECTION, place: 'before' }, '<p>B</p>')?.html).toContain('<p>B</p><section>')
    const after = placeElement(dest, { selector: SECTION, place: 'after' }, '<p>B</p>')
    expect(after?.html).toContain('</section><p>B</p>')
    expect(after?.selector).toBe('body:nth-of-type(1) > p:nth-of-type(1)')
  })

  it('keeps the element id unless the destination already uses it', () => {
    const dest = page('<section></section><p id="hero"></p>')
    const kept = placeElement(
      dest,
      { selector: SECTION, place: 'inside' },
      '<div id="card"><a href="#card">x</a></div>',
    )
    expect(kept?.html).toContain('<div id="card"><a href="#card">x</a></div>')
    const renamed = placeElement(
      dest,
      { selector: SECTION, place: 'inside' },
      '<div id="hero"><a href="#hero">x</a></div>',
    )
    expect(renamed?.html).toContain('<div id="hero-copy"><a href="#hero-copy">x</a></div>')
    expect(renamed?.html).toContain('<p id="hero"></p>')
  })

  it('refuses a target that cannot hold it, sits under a lock, or is gone', () => {
    expect(placeElement(page('<input>'), { selector: 'input', place: 'inside' }, '<p>B</p>')).toBeNull()
    expect(
      placeElement(page('<div data-doop-locked="true"><i></i></div>'), { selector: 'i', place: 'after' }, '<p>B</p>'),
    ).toBeNull()
    expect(placeElement(page('<section></section>'), { selector: 'nav', place: 'inside' }, '<p>B</p>')).toBeNull()
  })

  it('refuses a drop the saved markup would not keep', () => {
    expect(placeElement(page('<p>outer</p>'), { selector: 'p', place: 'inside' }, '<p>B</p>')).toBeNull()
  })
})

const STANDALONE = (inner: string) =>
  page(inner).replace('<body>', '<body style="width:100%;height:100%;margin:0" data-doop-canvas-element="true">')
const SHAPE = 'body:nth-of-type(1) > div:nth-of-type(1)'

describe('transferLayer', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    deleteFrame.mockClear()
    clearHistory()
  })

  it('takes a standalone element into a frame and removes its shell, undone together', async () => {
    const shape = frameWith('f1', STANDALONE('<div data-doop-drawing="rect" style="position:absolute">x</div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(shape, dest)
    expect(standaloneSelector(shape)).toBe(SHAPE)
    expect(transferLayer(shape, SHAPE, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    expect(html('f2')).toMatch(
      /<section><div data-doop-drawing="rect" style="position: ?absolute" data-doop-carried-scope="\w+">x<\/div><\/section>/,
    )
    expect(useStore.getState().canvas?.frames.map((f) => f.id)).toEqual(['f2'])
    await Promise.resolve()
    await Promise.resolve()
    expect(deleteFrame).toHaveBeenCalledWith('f1', 0)
  })

  it('moves the element from one frame into another, as one undo step', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    expect(html('f1')).toContain('<div><p>A</p></div>')
    expect(html('f2')).toMatch(/<section><p[^>]*>B<\/p><\/section>/)
    expect(useStore.getState().selectedElement).toEqual({
      frameId: 'f2',
      selector: 'body:nth-of-type(1) > section:nth-of-type(1) > p:nth-of-type(1)',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(updateFrame.mock.calls.map(([id]) => id)).toEqual(['f2', 'f1'])
    /* each write is conditional on the version the drag started from */
    expect(updateFrame.mock.calls.map(([, , expected]) => expected)).toEqual([0, 0])

    await undo()
    expect(html('f1')).toBe(source.html)
    expect(html('f2')).toBe(dest.html)
    await redo()
    expect(html('f1')).toContain('<div><p>A</p></div>')
    expect(html('f2')).toMatch(/<section><p[^>]*>B<\/p><\/section>/)
  })

  it('carries the CSS the element relies on into the destination', () => {
    const source = frameWith(
      'f1',
      page('<div><p>A</p><p class="hi">B</p></div>').replace(
        '<head>',
        '<head><style>.hi{color:red} .no{color:blue}</style>',
      ),
    )
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    expect(html('f2')).toMatch(
      /<style data-doop-carried="">:is\(\[data-doop-carried-scope="(\w+)"\], \[data-doop-carried-scope="\1"\] \*\):is\(\.hi\) \{ color: red; \}<\/style>/,
    )
    expect(html('f2')).toMatch(/<p class="hi" data-doop-carried-scope="\w+">B<\/p>/)
    expect(html('f2')).not.toContain('.no')
  })

  it('moves nothing when either frame changed during the drag', () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    useStore.getState().patchFrameLocal('f2', { html: page('<section><b></b></section>') })
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(false)
    expect(html('f1')).toBe(source.html)
    expect(updateFrame).not.toHaveBeenCalled()
  })

  it('refuses a locked element, a locked destination and a standalone drawing', () => {
    const locked = frameWith('f1', page('<div><p>A</p><p data-doop-locked="true">B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(locked, dest)
    expect(transferLayer(locked, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(false)

    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    holdCanvas(source, frameWith('f2', page('<section></section>'), { locked: true }))
    expect(transferLayer(source, P_B, { ...dest, locked: true }, { selector: SECTION, place: 'inside' })).toBe(false)

    const drawing = frameWith(
      'f2',
      page('<section></section>').replace('<body>', '<body data-doop-canvas-element="true">'),
    )
    holdCanvas(source, drawing)
    expect(transferLayer(source, P_B, drawing, { selector: SECTION, place: 'inside' })).toBe(false)
    expect(updateFrame).not.toHaveBeenCalled()
  })

  it('takes a layer back into a standalone drawing left behind empty', () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const emptied = frameWith('f2', page('').replace('<body>', '<body data-doop-canvas-element="true">'))
    holdCanvas(source, emptied)
    expect(transferLayer(source, P_B, emptied, { selector: 'body', place: 'inside' })).toBe(true)
    expect(html('f2')).toMatch(/<body data-doop-canvas-element="true"><p[^>]*>B<\/p><\/body>/)
  })

  it('sizes a standalone shape to its shell when it enters a frame', () => {
    const shape = frameWith(
      'f1',
      STANDALONE('<div data-doop-drawing="rect" style="position:absolute;left:0;top:0;width:100%;height:100%">x</div>'),
      { width: 40, height: 20 },
    )
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(shape, dest)
    expect(transferLayer(shape, SHAPE, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    expect(html('f2')).toMatch(/width: 40px; height: 20px/)
  })

  it('keeps ids unique inside the moved markup when one of them clashes', () => {
    const source = frameWith('f1', page('<div><p>A</p><p id="a"><i id="a-copy"></i>B</p></div>'))
    const dest = frameWith('f2', page('<section></section><b id="a"></b>'))
    holdCanvas(source, dest)
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    const ids = [...html('f2')!.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('renames carried id rules along with the markup', () => {
    const source = frameWith(
      'f1',
      page('<div><p>A</p><p id="hero">B</p></div>').replace('<head>', '<head><style>#hero{color:red}</style>'),
    )
    const dest = frameWith('f2', page('<section></section><b id="hero"></b>'))
    holdCanvas(source, dest)
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    expect(html('f2')).toContain('#hero-copy) { color: red; }')
    expect(html('f2')).not.toContain(':is(#hero)')
  })

  it('puts the destination back on the server too when only the source save fails', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    updateFrame
      .mockImplementationOnce(() => Promise.resolve({ ...frameWith('f2', ''), updatedAt: 7 } as Frame))
      .mockImplementationOnce(() => Promise.reject(new Error('nope')))
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(html('f1')).toBe(source.html)
    expect(html('f2')).toBe(dest.html)
    expect(updateFrame.mock.calls.map(([id]) => id)).toEqual(['f2', 'f1', 'f2'])
    expect(updateFrame.mock.calls[2]![1]).toEqual({ html: dest.html })
    /* the restore is conditional on the version the move wrote */
    expect(updateFrame.mock.calls[2]![2]).toBe(7)
  })

  it('shows the copy the server keeps when the cleanup of a cancelled detach fails', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    holdCanvas(source)
    createFrame.mockImplementationOnce(async (canvasId, input) => {
      useStore.getState().patchFrameLocal('f1', { html: page('<div><p>Z</p><p>A</p><p>B</p></div>') })
      return { ...frameWith('new', ''), canvasId, ...input } as Frame
    })
    deleteFrame.mockImplementationOnce(() => Promise.reject(new Error('nope')))
    expect(await detachLayer(source, P_B)).toBe(false)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(useStore.getState().canvas?.frames.some((f) => f.id === 'new')).toBe(true)
  })

  it('lets the move stand when a quick edit saved the source without the element meanwhile', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    /* the quick edit's save carried the element's removal along */
    const remote = { ...source, html: page('<div><p>A</p></div><footer>edited</footer>'), updatedAt: 9 }
    updateFrame
      .mockImplementationOnce(() => Promise.resolve({ ...frameWith('f2', ''), updatedAt: 7 } as Frame))
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new ApiError(409, '{}'), { status: 409, body: { frame: remote } })),
      )
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    /* the element lives in the destination; nothing is rolled back */
    expect(html('f2')).toMatch(/<section><p[^>]*>B<\/p><\/section>/)
    expect(html('f1')).toBe(remote.html)
    expect(updateFrame.mock.calls.map(([id]) => id)).toEqual(['f2', 'f1'])
  })

  it('rolls back when the element is still in the saved source, even if a sibling’s deletion moved it', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    /* another editor deleted A: B is now the first paragraph, its old selector resolves to nothing */
    const remote = { ...source, html: page('<div><p>B</p></div>'), updatedAt: 9 }
    updateFrame
      .mockImplementationOnce(() => Promise.resolve({ ...frameWith('f2', ''), updatedAt: 7 } as Frame))
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new ApiError(409, '{}'), { status: 409, body: { frame: remote } })),
      )
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(html('f2')).toBe(dest.html)
    expect(html('f1')).toBe(remote.html)
    expect(updateFrame.mock.calls.map(([id]) => id)).toEqual(['f2', 'f1', 'f2'])
  })

  it('keeps the move in its place among the edits made while it saved', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    /* an edit to the destination while the move's saves are still out */
    const { recordUpdate } = await import('../src/lib/history')
    recordUpdate('f2', { html: 'before-edit' }, { html: 'after-edit' }, true)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    updateFrame.mockClear()
    await undo()
    /* the first undo is that later edit, not the move underneath it */
    expect(updateFrame.mock.calls[0]?.[0]).toBe('f2')
    expect(updateFrame.mock.calls[0]?.[1]).toEqual({ html: 'before-edit' })
  })

  it('records nothing to undo for a move that was rolled back', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    updateFrame.mockImplementationOnce(() => Promise.reject(new Error('nope')))
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(html('f1')).toBe(source.html)
    const calls = updateFrame.mock.calls.length
    await undo()
    expect(updateFrame.mock.calls.length).toBe(calls)
    expect(html('f2')).toBe(dest.html)
  })

  it('shows a collaborator’s newer destination when the save conflicts', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    const remote = { ...dest, html: page('<section>theirs</section>'), updatedAt: 9 }
    updateFrame.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new ApiError(409, '{}'), { status: 409, body: { frame: remote } })),
    )
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(html('f1')).toBe(source.html)
    expect(html('f2')).toBe(remote.html)
  })

  it('puts both frames back when a save fails', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    const dest = frameWith('f2', page('<section></section>'))
    holdCanvas(source, dest)
    updateFrame.mockImplementationOnce(() => Promise.reject(new Error('nope')))
    expect(transferLayer(source, P_B, dest, { selector: SECTION, place: 'inside' })).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(html('f1')).toBe(source.html)
    expect(html('f2')).toBe(dest.html)
    expect(updateFrame).toHaveBeenCalledTimes(1)
  })
})

describe('detachLayer', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    createFrame.mockClear()
  })

  it('lifts the element onto the canvas where it was rendered, with its CSS, as one undo step', async () => {
    const source = frameWith(
      'f1',
      page('<div><p>A</p><p class="hi">B</p></div>').replace('<head>', '<head><style>.hi{color:red}</style>'),
      { x: 100, y: 200, pageId: 'p2' },
    )
    holdCanvas(source)
    expect(await detachLayer(source, P_B)).toBe(true)
    const [canvasId, input] = createFrame.mock.calls[0]!
    expect(canvasId).toBe('c1')
    /* on the source's page, whatever page is active */
    expect(input).toMatchObject({ name: 'B', x: 110, y: 220, width: 50, height: 30, pageId: 'p2' })
    /* a transform, inline or carried, would apply a second time on the measured box */
    expect(input.html).toContain('transform: none !important')
    expect(input.html).toContain('data-doop-canvas-element="true"')
    expect(input.html).toMatch(/<style data-doop-carried="">:is\(\[data-doop-carried-scope="\w+"\]/)
    expect(input.html).toMatch(
      /<p class="hi" data-doop-carried-scope="\w+" style="[^"]*position: absolute[^"]*width: 100%[^"]*">B<\/p>/,
    )
    expect(html('f1')).toContain('<div><p>A</p></div>')
    const created = useStore.getState().canvas?.frames.find((f) => f.id === 'new')
    expect(created && standaloneSelector(created)).toBe('body:nth-of-type(1) > p:nth-of-type(1)')
    expect(useStore.getState().selectedElement).toEqual({
      frameId: 'new',
      selector: 'body:nth-of-type(1) > p:nth-of-type(1)',
    })
  })

  it('drops the created frame again when the source changed while it was being created', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    holdCanvas(source)
    createFrame.mockImplementationOnce(async (canvasId, input) => {
      useStore.getState().patchFrameLocal('f1', { html: page('<div><p>Z</p><p>A</p><p>B</p></div>') })
      return { ...frameWith('new', ''), canvasId, ...input } as Frame
    })
    expect(await detachLayer(source, P_B)).toBe(false)
    expect(deleteFrame).toHaveBeenCalledWith('new', 0)
    expect(updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas?.frames.some((f) => f.id === 'new')).toBe(false)
  })

  it('keeps the lifted copy when the source was saved without the element meanwhile', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    holdCanvas(source)
    /* a quick edit beside the lift saved the source with the element already gone */
    const remote = { ...source, html: page('<div><p>theirs</p></div>'), updatedAt: 9 }
    updateFrame.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new ApiError(409, '{}'), { status: 409, body: { frame: remote } })),
    )
    expect(await detachLayer(source, P_B)).toBe(true)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(html('f1')).toBe(remote.html)
    expect(useStore.getState().canvas?.frames.some((f) => f.id === 'new')).toBe(true)
    expect(deleteFrame).not.toHaveBeenCalled()
  })

  it('drops the created frame again when the source save conflicts', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    holdCanvas(source)
    const remote = { ...source, html: page('<div><p>theirs</p><p>B</p></div>'), updatedAt: 9 }
    updateFrame.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new ApiError(409, '{}'), { status: 409, body: { frame: remote } })),
    )
    expect(await detachLayer(source, P_B)).toBe(true)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(html('f1')).toBe(remote.html)
    expect(useStore.getState().canvas?.frames.some((f) => f.id === 'new')).toBe(false)
    /* the cleanup is conditional on the created frame's version */
    expect(deleteFrame).toHaveBeenCalledWith('new', 0)
  })

  it('keeps a collaborator’s edit to the created frame when the cleanup conflicts', async () => {
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    holdCanvas(source)
    updateFrame.mockImplementationOnce(() => Promise.reject(new Error('nope')))
    const theirs = { ...frameWith('new', page('<p>theirs</p>')), updatedAt: 9 }
    deleteFrame.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new ApiError(409, '{}'), { status: 409, body: { frame: theirs } })),
    )
    expect(await detachLayer(source, P_B)).toBe(true)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(html('f1')).toBe(source.html)
    expect(html('new')).toBe(theirs.html)
  })

  it('refuses a layer that is standalone already, or a frame that changed', async () => {
    const shape = frameWith('f1', STANDALONE('<div>x</div>'))
    holdCanvas(shape)
    expect(await detachLayer(shape, SHAPE)).toBe(false)
    const source = frameWith('f1', page('<div><p>A</p><p>B</p></div>'))
    holdCanvas(source)
    useStore.getState().patchFrameLocal('f1', { html: page('<div><p>Z</p><p>A</p><p>B</p></div>') })
    expect(await detachLayer(source, P_B)).toBe(false)
    expect(createFrame).not.toHaveBeenCalled()
  })
})
