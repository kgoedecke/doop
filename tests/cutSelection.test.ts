// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: { createFrame: vi.fn(), updateFrame: vi.fn(), deleteFrame: vi.fn(), getCanvas: vi.fn() },
}))
const { api } = await import('../src/lib/api')
const { useStore } = await import('../src/lib/store')
const { clearHistory, undo } = await import('../src/lib/history')
const { hasFrameClip } = await import('../src/lib/frameClipboard')
const { hasElementClip, cutSelection } = await import('../src/lib/elementClipboard')
const { isCanvasClipboard } = await import('../src/lib/canvasClipboard')

const frame = (id: string, extra: Partial<Frame> = {}): Frame => ({
  id,
  canvasId: 'c',
  pageId: 'p',
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: `<p>${id}</p><span>keep</span>`,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Me',
  ...extra,
})

let db: Map<string, Frame>

function open(frames: Frame[], role: 'edit' | 'view' = 'edit') {
  db = new Map(frames.map((f) => [f.id, f]))
  const s = useStore.getState()
  s.setCanvas({ id: 'c', name: 'T', frames, pages: [{ id: 'p', name: 'P' }], role } as unknown as Canvas)
}

beforeEach(() => {
  vi.resetAllMocks()
  clearHistory()
  localStorage.clear()
  useStore.getState().select(null)
  vi.mocked(api.deleteFrame).mockImplementation(async (id) => void db.delete(id))
  let n = 0
  vi.mocked(api.createFrame).mockImplementation(async (canvasId, input) => {
    const made = { ...frame(`restored-${++n}`), ...input, canvasId } as Frame
    db.set(made.id, made)
    return made
  })
  vi.mocked(api.updateFrame).mockImplementation(async (id, patch) => {
    const next = { ...db.get(id)!, ...patch } as Frame
    db.set(id, next)
    return next
  })
})

describe('cut', () => {
  it('puts the selected frames on the clipboard and removes them as one undo step', async () => {
    open([frame('a'), frame('b'), frame('c')])
    useStore.getState().selectMany(['a', 'b'])
    const data = new DataTransfer()

    expect(cutSelection(data)).toBe(true)

    expect(isCanvasClipboard(data)).toBe(true)
    expect(hasFrameClip()).toBe(true)
    await vi.waitFor(() => expect([...db.keys()]).toEqual(['c']))
    await undo()
    await vi.waitFor(() => expect(db.size).toBe(3))
  })

  it('keeps a locked frame while still copying it', async () => {
    open([frame('a', { locked: true })])
    useStore.getState().select('a')

    expect(cutSelection(new DataTransfer())).toBe(true)

    expect(hasFrameClip()).toBe(true)
    expect(api.deleteFrame).not.toHaveBeenCalled()
  })

  it('cuts a picked element out of its frame, not the frame', async () => {
    open([frame('a')])
    useStore.getState().select('a')
    useStore.getState().pickElement({ frameId: 'a', selector: 'body > p:nth-of-type(1)' })

    expect(cutSelection(new DataTransfer())).toBe(true)

    expect(hasElementClip()).toBe(true)
    expect(api.deleteFrame).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(db.get('a')?.html).not.toContain('<p>a</p>'))
    expect(db.get('a')?.html).toContain('keep')
  })

  it('leaves a viewer’s selection alone', () => {
    open([frame('a')], 'view')
    useStore.getState().select('a')

    expect(cutSelection(new DataTransfer())).toBe(false)

    expect(hasFrameClip()).toBe(false)
    expect(api.deleteFrame).not.toHaveBeenCalled()
  })

  it('does nothing with nothing selected', () => {
    open([frame('a')])
    expect(cutSelection(new DataTransfer())).toBe(false)
    expect(api.deleteFrame).not.toHaveBeenCalled()
  })
})
