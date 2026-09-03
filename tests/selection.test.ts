import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

/* the history module talks to the server and analytics — stub both so the
   undo stack can be exercised as pure bookkeeping */
const api = {
  updateFrame: vi.fn(async (_id: string, _patch: object) => ({})),
  deleteFrame: vi.fn(async () => ({})),
  createFrame: vi.fn(async (_canvasId: string, rest: Partial<Frame>) => ({ ...frame('new'), ...rest, id: 'new' })),
}
vi.mock('../src/lib/api', () => ({ api }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const history = await import('../src/lib/history')

function frame(id: string, x = 0, y = 0): Frame {
  return {
    id,
    canvasId: 'c1',
    name: id,
    html: '',
    x,
    y,
    width: 100,
    height: 100,
  } as Frame
}

function seed(...frames: Frame[]) {
  useStore.getState().setCanvas({ id: 'c1', name: 'c', frames } as unknown as Canvas)
}

beforeEach(() => {
  seed(frame('a'), frame('b'), frame('c'))
  useStore.getState().select(null)
  history.clearHistory()
  vi.clearAllMocks()
})

describe('multi-selection in the store', () => {
  it('a plain select collapses to one frame and makes it primary', () => {
    useStore.getState().selectMany(['a', 'b'])
    useStore.getState().select('c')
    expect(useStore.getState().selectedIds).toEqual(['c'])
    expect(useStore.getState().selectedId).toBe('c')
  })

  it('toggleSelect adds, then drops, keeping the last-added frame primary', () => {
    const s = useStore.getState()
    s.select('a')
    s.toggleSelect('b')
    expect(useStore.getState().selectedIds).toEqual(['a', 'b'])
    expect(useStore.getState().selectedId).toBe('b')
    useStore.getState().toggleSelect('b')
    expect(useStore.getState().selectedIds).toEqual(['a'])
    expect(useStore.getState().selectedId).toBe('a')
    useStore.getState().toggleSelect('a')
    expect(useStore.getState().selectedId).toBeNull()
  })

  it('removing a frame drops it from the selection and promotes a survivor', () => {
    useStore.getState().selectMany(['a', 'b'])
    useStore.getState().removeFrame('b')
    expect(useStore.getState().selectedIds).toEqual(['a'])
    expect(useStore.getState().selectedId).toBe('a')
    useStore.getState().removeFrame('a')
    expect(useStore.getState().selectedId).toBeNull()
  })

  it('changing the primary frame closes the inspector, re-selecting keeps it', () => {
    useStore.getState().select('a')
    useStore.getState().setInspectorOpen(true)
    useStore.getState().selectMany(['b', 'a'])
    expect(useStore.getState().inspectorOpen).toBe(true)
    useStore.getState().toggleSelect('c')
    expect(useStore.getState().inspectorOpen).toBe(false)
  })
})

describe('grouped history', () => {
  it('a group move undoes and redoes as one step', async () => {
    history.recordUpdates([
      { frameId: 'a', before: { x: 0, y: 0 }, after: { x: 10, y: 10 } },
      { frameId: 'b', before: { x: 0, y: 0 }, after: { x: 10, y: 10 } },
    ])
    await history.undo()
    expect(api.updateFrame).toHaveBeenCalledTimes(2)
    expect(api.updateFrame).toHaveBeenCalledWith('a', { x: 0, y: 0 })
    expect(api.updateFrame).toHaveBeenCalledWith('b', { x: 0, y: 0 })
    await history.undo()
    expect(api.updateFrame).toHaveBeenCalledTimes(2)
    await history.redo()
    expect(api.updateFrame).toHaveBeenCalledTimes(4)
    expect(api.updateFrame).toHaveBeenLastCalledWith('b', { x: 10, y: 10 })
  })

  it('a group delete removes every frame and one undo brings them all back', async () => {
    const frames = useStore.getState().canvas!.frames
    history.deleteFramesTracked(frames.slice(0, 2))
    expect(api.deleteFrame).toHaveBeenCalledTimes(2)
    await history.undo()
    expect(api.createFrame).toHaveBeenCalledTimes(2)
    expect(api.createFrame).toHaveBeenCalledWith('c1', expect.objectContaining({ name: 'a' }))
    expect(api.createFrame).toHaveBeenCalledWith('c1', expect.objectContaining({ name: 'b' }))
  })
})

describe('review follow-ups', () => {
  it('deleting the primary frame promotes the last surviving member', () => {
    useStore.getState().selectMany(['a', 'b', 'c'])
    useStore.getState().removeFrame('c')
    expect(useStore.getState().selectedIds).toEqual(['a', 'b'])
    expect(useStore.getState().selectedId).toBe('b')
  })

  it('undo waits for in-flight drag saves before writing the inverse', async () => {
    const order: string[] = []
    let release!: () => void
    const pending = new Promise<void>((r) => (release = r)).then(() => order.push('save'))
    history.trackSave(pending)
    history.recordUpdate('a', { x: 0 }, { x: 10 })
    api.updateFrame.mockImplementationOnce(async () => {
      order.push('undo')
      return {}
    })
    const undone = history.undo()
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await undone
    expect(order).toEqual(['save', 'undo'])
  })

  it('a failing member of a group does not stop the others, and the survivors stay redoable', async () => {
    history.recordUpdates([
      { frameId: 'a', before: { x: 0 }, after: { x: 1 } },
      { frameId: 'b', before: { x: 0 }, after: { x: 1 } },
    ])
    api.updateFrame.mockImplementationOnce(async (id: string) => {
      if (id === 'a') throw new Error('boom')
      return {}
    })
    await history.undo()
    expect(api.updateFrame).toHaveBeenCalledTimes(2)
    /* only b was undone, so only b comes back on redo */
    await history.redo()
    expect(api.updateFrame).toHaveBeenCalledTimes(3)
    expect(api.updateFrame).toHaveBeenLastCalledWith('b', { x: 1 })
    /* and that redo is itself undoable */
    await history.undo()
    expect(api.updateFrame).toHaveBeenLastCalledWith('b', { x: 0 })
  })
})
