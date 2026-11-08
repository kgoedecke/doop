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
const { copyFrames, replaceFramesWithClip } = await import('../src/lib/frameClipboard')

const frame = (id: string, x: number): Frame => ({
  id,
  canvasId: 'c',
  pageId: 'p',
  name: id,
  x,
  y: 0,
  width: 100,
  height: 100,
  html: `<p>${id}</p>`,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Me',
})
let db: Map<string, Frame>
let failCreates = 0

beforeEach(() => {
  vi.resetAllMocks()
  clearHistory()
  localStorage.clear()
  failCreates = 0
  db = new Map(['copied', 'a', 'b'].map((id, i) => [id, frame(id, i * 200)]))
  useStore
    .getState()
    .setCanvas({ id: 'c', name: 'T', frames: [...db.values()], pages: [{ id: 'p', name: 'P' }] } as Canvas)
  let n = 0
  vi.mocked(api.createFrame).mockImplementation(async (canvasId, input) => {
    if (failCreates > 0) {
      failCreates--
      throw new Error('create failed')
    }
    const made = { ...frame(`new-${++n}`, 0), ...input, canvasId } as Frame
    db.set(made.id, made)
    return made
  })
  vi.mocked(api.deleteFrame).mockImplementation(async (id) => {
    db.delete(id)
  })
})

describe('paste to replace', () => {
  it('replaces each frame and undoes as one step', async () => {
    copyFrames([db.get('copied')!])
    replaceFramesWithClip('c', [db.get('a')!, db.get('b')!])
    await vi.waitFor(() => expect(db.has('a') || db.has('b')).toBe(false))
    expect([...db.keys()].sort()).toEqual(['copied', 'new-1', 'new-2'])
    await undo()
    expect(db.has('new-1') || db.has('new-2')).toBe(false)
    expect([...db.values()].map((f) => f.name).sort()).toEqual(['a', 'b', 'copied'])
  })

  it('keeps a frame whose replacement failed', async () => {
    copyFrames([db.get('copied')!])
    failCreates = 1
    replaceFramesWithClip('c', [db.get('a')!])
    await new Promise((r) => setTimeout(r, 10))
    expect(db.has('a')).toBe(true)
    expect([...db.keys()].filter((id) => id.startsWith('new'))).toEqual([])
  })

  it('never removes the replacement when the original cannot come back', async () => {
    copyFrames([db.get('copied')!])
    replaceFramesWithClip('c', [db.get('a')!])
    await vi.waitFor(() => expect(db.has('a')).toBe(false))
    failCreates = 1
    await undo()
    expect(db.has('new-1')).toBe(true)
  })

  it('keeps every replacement, retryable, when one of several originals cannot come back', async () => {
    copyFrames([db.get('copied')!])
    replaceFramesWithClip('c', [db.get('a')!, db.get('b')!])
    await vi.waitFor(() => expect(db.has('a') || db.has('b')).toBe(false))
    failCreates = 1
    await undo()
    expect(db.has('new-1') && db.has('new-2')).toBe(true)
    await undo()
    expect([...db.values()].map((f) => f.name).sort()).toEqual(['a', 'b', 'copied'])
  })
})
