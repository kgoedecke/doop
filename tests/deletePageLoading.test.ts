// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { Frame, WireCanvas } from '../shared/types'

/* A frame selected on a page this browser has not read yet (from Activity or
   a comment, while the page loads) holds a blank copy here. Deleting it waits
   for the page, so undo brings back the real design; copying it copies
   nothing rather than the blank copy. */

const api = vi.hoisted(() => ({ deleteFrame: vi.fn(), createFrame: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api, ApiError: class extends Error {} }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
const { useStore } = await import('../src/lib/store')
const { clearHistory, deleteFramesTracked, undo } = await import('../src/lib/history')
const { copyFrames } = await import('../src/lib/frameClipboard')

const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  pageId: 'second',
  name: 'Card',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  html: '<p>The actual design</p>',
  createdAt: 1,
  updatedAt: 10,
  updatedBy: 'Ada',
}
const { html: _html, ...meta } = frame
const wire: WireCanvas = {
  id: 'c',
  name: 'Canvas',
  pages: [
    { id: 'first', name: 'Main' },
    { id: 'second', name: 'Exploration' },
  ],
  frames: [meta],
  createdAt: 1,
  updatedAt: 10,
}

beforeEach(() => {
  vi.clearAllMocks()
  clearHistory()
  localStorage.clear()
  useStore.getState().setCanvas(null)
  /* the room's init carried the first page only */
  useStore.getState().setCanvas(wire, ['first'])
  api.deleteFrame.mockResolvedValue({ ok: true })
  api.createFrame.mockImplementation(async (_canvasId: string, input: Partial<Frame>) => ({
    ...frame,
    ...input,
    id: 'f2',
  }))
})

const stored = () => useStore.getState().canvas!.frames.find((f) => f.id === 'f')!

it('deletes a frame whose page is loading once the page is here, so undo brings the design back', async () => {
  deleteFramesTracked([stored()])
  expect(api.deleteFrame).not.toHaveBeenCalled()

  useStore.getState().setPageFrames('second', [frame])
  await vi.waitFor(() => expect(api.deleteFrame).toHaveBeenCalledWith('f'))
  useStore.getState().removeFrame('f')

  await undo()
  expect(api.createFrame).toHaveBeenCalledWith('c', expect.objectContaining({ html: '<p>The actual design</p>' }))
})

it('copies nothing of a frame whose page is loading', () => {
  expect(copyFrames([stored()])).toBe(false)
  expect(localStorage.getItem('doop:frame-clipboard')).toBeNull()

  useStore.getState().setPageFrames('second', [frame])
  expect(copyFrames([stored()])).toBe(true)
})
