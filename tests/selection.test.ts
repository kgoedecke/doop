import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

/* the history module talks to the server and analytics — stub both so the
   undo stack can be exercised as pure bookkeeping */
const api = {
  updateFrame: vi.fn(async () => ({})),
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

  it('removing a frame drops it from the selection', () => {
    useStore.getState().selectMany(['a', 'b'])
    useStore.getState().removeFrame('b')
    expect(useStore.getState().selectedIds).toEqual(['a'])
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
