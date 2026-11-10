import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { ResourceCopyEntry } from '../shared/resourceCopies'

/* the clipboard module creates frames through the API and records them in
   history — stub the network and analytics so the copy/paste bookkeeping can
   be exercised on its own */
let nextId = 0
const api = {
  copyResources: vi.fn(async (canvasId: string, entries: ResourceCopyEntry[]) => ({
    canvasId,
    entries: entries.map((entry) => ({ html: entry.html.replaceAll('/a/source.png', '/a/owned.png') })),
    assets: [{ from: 'source', to: 'owned', url: '/a/owned.png' }],
  })),
  createFrame: vi.fn(async (canvasId: string, rest: Partial<Frame>) => ({
    ...frame('x'),
    ...rest,
    canvasId,
    id: `new${++nextId}`,
  })),
  updateFrame: vi.fn(async () => ({})),
  deleteFrame: vi.fn(async () => ({})),
}
vi.mock('../src/lib/api', () => ({
  api,
  errorMessage: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

/* the module keeps the clip in localStorage, which the node test runtime
   lacks; a tiny in-memory stand-in is all it needs */
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})
vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 })
vi.stubGlobal('document', { querySelector: () => null })

const { useStore } = await import('../src/lib/store')
const history = await import('../src/lib/history')
const clipboard = await import('../src/lib/frameClipboard')

function frame(id: string, x = 0, y = 0, width = 100, height = 100): Frame {
  return {
    id,
    canvasId: 'c1',
    name: id,
    html: `<p>${id}</p>`,
    x,
    y,
    width,
    height,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: 'Tester',
  }
}

function seed(...frames: Frame[]) {
  useStore.getState().setCanvas({ id: 'c1', name: 'c', frames } as unknown as Canvas)
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  store.clear()
  nextId = 0
  seed(frame('a', 100, 100), frame('b', 300, 150, 50, 50))
  useStore.getState().setViewport({ x: 0, y: 0, zoom: 1 })
  useStore.getState().select(null)
  history.clearHistory()
  vi.clearAllMocks()
  api.copyResources.mockImplementation(async (canvasId, entries) => ({
    canvasId,
    entries: entries.map((entry) => ({ html: entry.html.replaceAll('/a/source.png', '/a/owned.png') })),
    assets: [{ from: 'source', to: 'owned', url: '/a/owned.png' }],
  }))
})

describe('explicit cross-canvas frame clipboard', () => {
  function prepare() {
    clipboard.copyFrames([{ ...frame('source'), html: '<img src="/a/source.png">', updatedAt: 7 }])
    useStore.getState().setCanvas({ id: 'destination', name: 'Destination', frames: [], createdAt: 1, updatedAt: 1 })
  }

  it('uses frozen source provenance and server-rewritten carriers before creating the pasted frame', async () => {
    prepare()
    clipboard.pasteFrameCentered('destination')
    await flush()
    expect(api.copyResources).toHaveBeenCalledWith('destination', [
      { sourceFrameId: 'source', sourceVersion: 7, html: '<img src="/a/source.png">' },
    ])
    expect(api.createFrame).toHaveBeenCalledTimes(1)
    expect(api.createFrame.mock.calls[0]![1].html).toBe('<img src="/a/owned.png">')
    expect(useStore.getState().selectedIds).toEqual(['new1'])
  })

  it('surfaces source refusal without creating a frame or retrying the copy', async () => {
    prepare()
    api.copyResources.mockRejectedValueOnce(new Error('Source access was removed'))
    clipboard.pasteFrameCentered('destination')
    await flush()
    expect(api.copyResources).toHaveBeenCalledTimes(1)
    expect(api.createFrame).not.toHaveBeenCalled()
    expect(useStore.getState().notice?.text).toBe('Source access was removed')
  })

  it('preserves the new canvas selection when the copy response arrives after navigation', async () => {
    prepare()
    let release!: (value: Awaited<ReturnType<typeof api.copyResources>>) => void
    api.copyResources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    clipboard.pasteFrameCentered('destination')
    useStore.getState().setCanvas({
      id: 'next',
      name: 'Next',
      frames: [{ ...frame('keep'), canvasId: 'next' }],
      createdAt: 1,
      updatedAt: 1,
    })
    useStore.getState().select('keep')
    release({ canvasId: 'destination', entries: [{ html: '<img src="/a/owned.png">' }], assets: [] })
    await flush()
    expect(api.createFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas?.id).toBe('next')
    expect(useStore.getState().selectedIds).toEqual(['keep'])
    expect(useStore.getState().notice?.text).toContain('destination changed')
  })

  it('does not record a late successful create into another canvas’s selection or undo history', async () => {
    clipboard.copyFrames([frame('source')])
    let release!: (value: Frame) => void
    api.createFrame.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    clipboard.pasteFrameCentered('c1')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    useStore.getState().setCanvas({
      id: 'next',
      name: 'Next',
      frames: [{ ...frame('keep'), canvasId: 'next' }],
      createdAt: 1,
      updatedAt: 1,
    })
    useStore.getState().select('keep')
    release({ ...frame('landed'), canvasId: 'c1' })
    await flush()
    expect(useStore.getState().selectedIds).toEqual(['keep'])
    await history.undo()
    expect(api.deleteFrame).not.toHaveBeenCalled()
  })
})

describe('multi-frame copy and paste', () => {
  it('pastes every copied frame, keeping their layout, centred as a group', async () => {
    clipboard.copyFrames([frame('a', 100, 100), frame('b', 300, 150, 50, 50)])
    clipboard.pasteFrameCentered('c1')
    await flush()

    expect(api.createFrame).toHaveBeenCalledTimes(2)
    const [, a] = api.createFrame.mock.calls[0]!
    const [, b] = api.createFrame.mock.calls[1]!
    /* the group spans 250×100 (a at 0,0 and b at 200,50 relative), so its
       top-left sits at the view centre minus half of that */
    expect(a).toMatchObject({ name: 'a', html: '<p>a</p>', x: 375, y: 350, width: 100, height: 100 })
    expect(b).toMatchObject({ name: 'b', html: '<p>b</p>', x: 575, y: 400, width: 50, height: 50 })
  })

  it('selects all pasted frames and undoes the paste as one step', async () => {
    clipboard.copyFrames([frame('a', 100, 100), frame('b', 300, 150)])
    clipboard.pasteFrameCentered('c1')
    await flush()

    expect(useStore.getState().selectedIds).toEqual(['new1', 'new2'])
    await history.undo()
    await flush()
    expect(api.deleteFrame).toHaveBeenCalledTimes(2)
  })

  it('pastes at a screen point with the group top-left there', async () => {
    clipboard.copyFrames([frame('a', 100, 100), frame('b', 300, 150)])
    clipboard.pasteFrameAtScreen('c1', 10, 20)
    await flush()

    expect(api.createFrame.mock.calls[0]![1]).toMatchObject({ x: 10, y: 20 })
    expect(api.createFrame.mock.calls[1]![1]).toMatchObject({ x: 210, y: 70 })
  })

  it('rejects a clipboard shape without frozen source provenance', async () => {
    store.set('doop:frame-clipboard', JSON.stringify({ name: 'old', html: '<p>old</p>', width: 200, height: 100 }))
    expect(clipboard.hasFrameClip()).toBe(false)
    clipboard.pasteFrameCentered('c1')
    await flush()

    expect(api.createFrame).not.toHaveBeenCalled()
  })

  it('keeps the frames that landed when one create fails', async () => {
    api.createFrame.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    clipboard.copyFrames([frame('a', 100, 100), frame('b', 300, 150)])
    clipboard.pasteFrameCentered('c1')
    await flush()

    /* the first request failed, the second landed as new1 */
    expect(useStore.getState().selectedIds).toEqual(['new1'])
    await history.undo()
    await flush()
    expect(api.deleteFrame).toHaveBeenCalledTimes(1)
    expect(api.deleteFrame).toHaveBeenCalledWith('new1')
    error.mockRestore()
  })

  it('reselects the whole group after undo and redo', async () => {
    clipboard.copyFrames([frame('a', 100, 100), frame('b', 300, 150)])
    clipboard.pasteFrameCentered('c1')
    await flush()
    await history.undo()
    await flush()
    await history.redo()
    await flush()

    expect(useStore.getState().selectedIds).toEqual(['new3', 'new4'])
  })

  it('duplicates a selection as a group offset by 40px', async () => {
    clipboard.duplicateFrames([frame('a', 100, 100), frame('b', 300, 150)])
    await flush()

    expect(api.createFrame.mock.calls[0]![1]).toMatchObject({ name: 'a copy', x: 140, y: 140 })
    expect(api.createFrame.mock.calls[1]![1]).toMatchObject({ name: 'b copy', x: 340, y: 190 })
    expect(useStore.getState().selectedIds).toEqual(['new1', 'new2'])
  })
})

describe('private resources in the new frame replacement action', () => {
  function prepareReplacement() {
    clipboard.copyFrames([{ ...frame('replacement-source'), html: '<img src="/a/source.png">', updatedAt: 7 }])
    const target = { ...frame('replacement-target'), canvasId: 'destination' }
    useStore
      .getState()
      .setCanvas({ id: 'destination', name: 'Destination', frames: [target], createdAt: 1, updatedAt: 1 })
    return target
  }

  it('uses the authorized destination-owned resource carrier before creating a cross-canvas replacement', async () => {
    const target = prepareReplacement()
    expect(clipboard.replaceFramesWithClip('destination', [target])).toBe(true)
    await vi.waitFor(() => expect(api.createFrame).toHaveBeenCalledTimes(1))
    expect(api.copyResources).toHaveBeenCalledExactlyOnceWith('destination', [
      { sourceFrameId: 'replacement-source', sourceVersion: 7, html: '<img src="/a/source.png">' },
    ])
    expect(api.createFrame.mock.calls[0]![0]).toBe('destination')
    expect(api.createFrame.mock.calls[0]![1].html).toBe('<img src="/a/owned.png">')
    await flush()
  })

  it('preserves the target when its copied source is no longer available', async () => {
    const target = prepareReplacement()
    api.copyResources.mockRejectedValueOnce(new Error('Source access was removed'))
    expect(clipboard.replaceFramesWithClip('destination', [target])).toBe(true)
    await vi.waitFor(() => expect(useStore.getState().notice?.text).toBe('Source access was removed'))
    expect(api.createFrame).not.toHaveBeenCalled()
    expect(api.deleteFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas?.frames).toEqual([target])
  })

  it('does not create or remove frames after navigation while the private copy is pending', async () => {
    const target = prepareReplacement()
    let release!: (value: Awaited<ReturnType<typeof api.copyResources>>) => void
    api.copyResources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    expect(clipboard.replaceFramesWithClip('destination', [target])).toBe(true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    useStore.getState().setCanvas({ id: 'next', name: 'Next', frames: [], createdAt: 1, updatedAt: 1 })
    release({ canvasId: 'destination', entries: [{ html: '<img src="/a/owned.png">' }], assets: [] })
    await flush()
    expect(api.createFrame).not.toHaveBeenCalled()
    expect(api.deleteFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas?.id).toBe('next')
  })
})
