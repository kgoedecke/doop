import { beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const api = vi.hoisted(() => ({
  setPages: vi.fn(),
  updateFrame: vi.fn(),
  createFrame: vi.fn(),
  deleteFrame: vi.fn(),
  getCanvas: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({
  api,
  ApiError: class extends Error {
    status: number
    body: Record<string, unknown>
    constructor(status: number, text: string) {
      super(text)
      this.status = status
      this.body = JSON.parse(text)
    }
  },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
const { ApiError } = await import('../src/lib/api')
const { useStore } = await import('../src/lib/store')
const { savePages, moveFramesToPage } = await import('../src/lib/pageEdits')
const { clearHistory, recordCreate, deleteFrameTracked, undo, redo } = await import('../src/lib/history')
const pages = [
  { id: 'first', name: 'Main' },
  { id: 'second', name: 'Exploration' },
]
const frame = {
  id: 'f',
  canvasId: 'c',
  pageId: 'second',
  name: 'Hero',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '<h1>Hero</h1>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'User',
} satisfies Frame
const canvas = { id: 'c', name: 'Design', pages, frames: [frame], createdAt: 0, updatedAt: 0 } satisfies Canvas
beforeEach(() => {
  vi.clearAllMocks()
  clearHistory()
  useStore.getState().setCanvas(structuredClone(canvas))
  api.setPages.mockImplementation(async (_id, next) => next)
  api.updateFrame.mockImplementation(async (id, patch) => ({ ...frame, id, ...patch }))
  api.createFrame.mockImplementation(async (canvasId, input) => ({ ...frame, ...input, canvasId, id: 'restored' }))
  api.deleteFrame.mockResolvedValue({})
})

it('ignores a page save that completes after switching canvases', async () => {
  let resolve!: (value: typeof pages) => void
  api.setPages.mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  const pending = savePages(canvas, [...pages, { id: 'third', name: 'New' }], 'third')
  const other = { ...canvas, id: 'other', frames: [], pages: [{ id: 'other-page', name: 'Other' }] }
  useStore.getState().setCanvas(other)
  resolve([...pages, { id: 'third', name: 'New' }])
  await pending
  expect(useStore.getState().canvas).toEqual(other)
  expect(useStore.getState().activePageId).toBe('other-page')
})

it('does not overwrite a newer page broadcast with an older HTTP response', async () => {
  let resolve!: (value: typeof pages) => void
  api.setPages.mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  const saved = [...pages, { id: 'third', name: 'New' }]
  const pending = savePages(canvas, saved)
  useStore.getState().setPages([...saved, { id: 'fourth', name: 'Collaborator' }])
  resolve(saved)
  await pending
  expect(useStore.getState().canvas!.pages).toHaveLength(4)
})

it('undoes and redoes a page move as one group without deleting the created frame', async () => {
  const second = { ...frame, id: 'g' }
  useStore.getState().setCanvas({ ...canvas, frames: [frame, second] })
  recordCreate(frame)
  await moveFramesToPage(useStore.getState().canvas!, ['f', 'g'], 'first')
  await undo()
  expect(api.updateFrame.mock.calls.slice(-2)).toEqual([
    ['f', { pageId: 'second' }],
    ['g', { pageId: 'second' }],
  ])
  expect(api.deleteFrame).not.toHaveBeenCalled()
  expect(useStore.getState().activePageId).toBe('second')
  await redo()
  expect(api.updateFrame.mock.calls.slice(-2)).toEqual([
    ['f', { pageId: 'first' }],
    ['g', { pageId: 'first' }],
  ])
})

it('records successful members of a partially failed move for undo', async () => {
  useStore.getState().setCanvas({ ...canvas, frames: [frame, { ...frame, id: 'g' }] })
  // Start with one successful save, followed by a failed member.
  api.updateFrame
    .mockReset()
    .mockResolvedValueOnce({ ...frame, pageId: 'first' })
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue({ ...frame, pageId: 'second' })
  await expect(moveFramesToPage(useStore.getState().canvas!, ['f', 'g'], 'first')).rejects.toThrow('network')
  await undo()
  expect(api.updateFrame).toHaveBeenLastCalledWith('f', { pageId: 'second' })
})

it('restores a deleted frame on the first remaining page when its original page was deleted', async () => {
  deleteFrameTracked(frame)
  useStore.getState().removeFrame(frame.id)
  useStore.getState().setPages([pages[0]!])
  await undo()
  expect(api.createFrame).toHaveBeenCalledWith('c', expect.objectContaining({ pageId: 'first', html: '<h1>Hero</h1>' }))
  expect(useStore.getState().canvas!.frames[0]).toMatchObject({ id: 'restored', pageId: 'first' })
})

it('ignores frame-move replies after navigating away and stops moving the remaining frames', async () => {
  let resolve!: (value: Frame) => void
  api.updateFrame.mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  const pending = moveFramesToPage({ ...canvas, frames: [frame, { ...frame, id: 'g' }] }, ['f', 'g'], 'first')
  useStore.getState().setCanvas({ ...canvas, id: 'other', frames: [] })
  resolve({ ...frame, pageId: 'first' })
  await pending
  expect(useStore.getState().canvas!.frames).toEqual([])
  expect(api.updateFrame).toHaveBeenCalledTimes(1)
})

it('waits for an in-flight page move before choosing the undo entry', async () => {
  let resolve!: (value: Frame) => void
  api.updateFrame.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r
    }),
  )
  recordCreate(frame)
  const pending = moveFramesToPage(canvas, ['f'], 'first')
  const undoing = undo()
  resolve({ ...frame, pageId: 'first' })
  await pending
  await undoing
  expect(api.deleteFrame).not.toHaveBeenCalled()
  expect(api.updateFrame).toHaveBeenLastCalledWith('f', { pageId: 'second' })
  await redo()
  expect(api.updateFrame).toHaveBeenLastCalledWith('f', { pageId: 'first' })
  expect(useStore.getState().activePageId).toBe('first')
})

it('refreshes pages after a save conflict without replacing frame data', async () => {
  const newer = [...pages, { id: 'third', name: 'Collaborator' }]
  api.setPages.mockRejectedValue(new ApiError(409, JSON.stringify({ pages: newer })))
  api.getCanvas.mockResolvedValue({ ...canvas, pages: newer, frames: [] })
  await expect(savePages(canvas, pages)).rejects.toBeInstanceOf(ApiError)
  expect(useStore.getState().canvas!.pages).toEqual(newer)
  expect(useStore.getState().canvas!.frames).toEqual([frame])
})

it('does not overwrite a newer broadcast while refreshing after a conflict', async () => {
  let resolve!: (value: Canvas) => void
  api.setPages.mockRejectedValue(new ApiError(409, JSON.stringify({ pages })))
  api.getCanvas.mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  const pending = savePages(canvas, pages)
  await vi.waitFor(() => expect(api.getCanvas).toHaveBeenCalled())
  const newest = [...pages, { id: 'fourth', name: 'Latest' }]
  useStore.getState().setPages(newest)
  resolve({ ...canvas, pages: [...pages, { id: 'third', name: 'Older' }] })
  await expect(pending).rejects.toBeInstanceOf(ApiError)
  expect(useStore.getState().canvas!.pages).toEqual(newest)
})

it('undoes a grouped move to a remaining page when the source page was deleted, preserving redo', async () => {
  const remaining = { id: 'remaining', name: 'Archive' }
  const secondFrame = { ...frame, id: 'g' }
  useStore.getState().setCanvas({ ...canvas, pages: [remaining, ...pages], frames: [frame, secondFrame] })
  await moveFramesToPage(useStore.getState().canvas!, ['f', 'g'], 'first')
  useStore.getState().setPages([remaining, pages[0]!])
  api.updateFrame.mockImplementation(async (id, patch) => {
    if (patch.pageId === 'second') throw new Error('page not found')
    return { ...frame, id, ...patch }
  })
  await undo()
  expect(api.updateFrame.mock.calls.slice(-2)).toEqual([
    ['f', { pageId: 'remaining' }],
    ['g', { pageId: 'remaining' }],
  ])
  expect(useStore.getState().activePageId).toBe('remaining')
  await redo()
  expect(api.updateFrame.mock.calls.slice(-2)).toEqual([
    ['f', { pageId: 'first' }],
    ['g', { pageId: 'first' }],
  ])
  await undo()
  expect(api.updateFrame.mock.calls.slice(-2)).toEqual([
    ['f', { pageId: 'remaining' }],
    ['g', { pageId: 'remaining' }],
  ])
})

it('uses a remaining page when the destination is deleted before redo', async () => {
  const remaining = { id: 'remaining', name: 'Archive' }
  useStore.getState().setCanvas({ ...canvas, pages: [remaining, ...pages] })
  await moveFramesToPage(useStore.getState().canvas!, ['f'], 'first')
  await undo()
  useStore.getState().setPages([remaining, pages[1]!])
  api.updateFrame.mockImplementation(async (id, patch) => {
    if (patch.pageId === 'first') throw new Error('page not found')
    return { ...frame, id, ...patch }
  })
  await redo()
  expect(api.updateFrame).toHaveBeenLastCalledWith('f', { pageId: 'remaining' })
  expect(useStore.getState().activePageId).toBe('remaining')
  await undo()
  expect(api.updateFrame).toHaveBeenLastCalledWith('f', { pageId: 'second' })
})

it('restores a deleted page before restoring its deleted frame, then redoes both deletions', async () => {
  useStore.getState().setActivePage('second')
  deleteFrameTracked(frame)
  useStore.getState().removeFrame(frame.id)
  await savePages(useStore.getState().canvas!, [pages[0]!])
  expect(useStore.getState().canvas!.pages).toEqual([pages[0]])
  await undo()
  expect(useStore.getState().canvas!.pages).toEqual(pages)
  expect(useStore.getState().activePageId).toBe('second')
  expect(api.createFrame).not.toHaveBeenCalled()
  await undo()
  expect(api.createFrame).toHaveBeenLastCalledWith('c', expect.objectContaining({ pageId: 'second' }))
  await redo()
  // Frame deletion broadcasts normally remove the recreated frame before page redo.
  useStore.getState().removeFrame('restored')
  await redo()
  expect(useStore.getState().canvas!.pages).toEqual([pages[0]])
})

it('undoes page deletion without removing a page added by a collaborator', async () => {
  useStore.getState().removeFrame(frame.id)
  await savePages(useStore.getState().canvas!, [pages[0]!])
  const collaborator = { id: 'collaborator', name: 'Shared work' }
  useStore.getState().setPages([pages[0]!, collaborator])
  await undo()
  expect(useStore.getState().canvas!.pages).toEqual([pages[0], pages[1], collaborator])
  await redo()
  expect(useStore.getState().canvas!.pages).toEqual([pages[0], collaborator])
})

it('undoes and redoes page reordering and renaming', async () => {
  await savePages(useStore.getState().canvas!, [pages[1]!, pages[0]!])
  await undo()
  expect(useStore.getState().canvas!.pages).toEqual(pages)
  await redo()
  expect(useStore.getState().canvas!.pages).toEqual([pages[1], pages[0]])
  await savePages(useStore.getState().canvas!, [{ ...pages[1]!, name: 'Ideas' }, pages[0]!])
  await undo()
  expect(useStore.getState().canvas!.pages).toEqual([pages[1], pages[0]])
})

it('waits for page deletion to save before undoing it and preserves redo', async () => {
  useStore.getState().removeFrame(frame.id)
  let resolve!: (value: typeof pages) => void
  api.setPages.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r
    }),
  )
  const saving = savePages(useStore.getState().canvas!, [pages[0]!])
  const undoing = undo()
  resolve([pages[0]!])
  await saving
  await undoing
  expect(useStore.getState().canvas!.pages).toEqual(pages)
  await redo()
  expect(useStore.getState().canvas!.pages).toEqual([pages[0]])
})
