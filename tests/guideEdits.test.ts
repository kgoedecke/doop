import { beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, CanvasGuide } from '../shared/types'

const api = vi.hoisted(() => ({
  setPages: vi.fn(),
  putGuide: vi.fn(),
  deleteGuide: vi.fn(),
  duplicatePage: vi.fn(),
  createFrame: vi.fn(),
  deleteFrame: vi.fn(),
  getCanvas: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({ api, ApiError: class extends Error {} }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
const { useStore } = await import('../src/lib/store')
const { commitGuide, visibleGuides } = await import('../src/lib/guides')
const { savePages, duplicatePage } = await import('../src/lib/pageEdits')
const { clearHistory, undo, redo } = await import('../src/lib/history')

const pages = [
  { id: 'first', name: 'Main' },
  { id: 'second', name: 'Exploration' },
]
const onSecond: CanvasGuide = { id: 'g2', pageId: 'second', axis: 'v', at: 40 }
const onFirst: CanvasGuide = { id: 'g1', pageId: 'first', axis: 'h', at: 10 }
const canvas = {
  id: 'c',
  name: 'Design',
  pages,
  frames: [],
  guides: [onFirst, onSecond],
  createdAt: 0,
  updatedAt: 0,
} satisfies Canvas

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const guides = () => useStore.getState().canvas?.guides ?? []

beforeEach(() => {
  vi.clearAllMocks()
  clearHistory()
  useStore.getState().setCanvas(structuredClone(canvas))
  api.setPages.mockImplementation(async (_id, next) => next)
  api.putGuide.mockImplementation(async (_id, guide) => guide)
  api.deleteGuide.mockResolvedValue({ ok: true })
})

it('brings a deleted page back with its guides on undo, and takes them again on redo', async () => {
  await savePages(useStore.getState().canvas!, [pages[0]!])
  expect(guides()).toEqual([onFirst])
  await undo()
  expect(api.putGuide).toHaveBeenCalledWith('c', onSecond)
  expect(guides()).toEqual([onFirst, onSecond])
  await redo()
  expect(guides()).toEqual([onFirst])
  await undo()
  expect(guides()).toEqual([onFirst, onSecond])
})

it('does not bring back a guide a teammate deleted between undo and redo', async () => {
  await savePages(useStore.getState().canvas!, [pages[0]!])
  await undo()
  expect(guides()).toContainEqual(onSecond)
  /* the teammate's removal arrives over the room */
  useStore.getState().setGuideLocal(onSecond.id, null)
  await redo()
  api.putGuide.mockClear()
  await undo()
  expect(api.putGuide).not.toHaveBeenCalled()
  expect(guides()).toEqual([onFirst])
})

it('says so when a guide cannot be put back with its page', async () => {
  await savePages(useStore.getState().canvas!, [pages[0]!])
  api.putGuide.mockRejectedValueOnce(new Error('A canvas holds at most 500 guides.'))
  await undo()
  expect(useStore.getState().canvas!.pages).toEqual(pages)
  expect(useStore.getState().notice).toMatchObject({
    text: 'A guide could not be put back: A canvas holds at most 500 guides.',
  })
})

it('restores the guides of a duplicated page when the copy is redone', async () => {
  const copyPage = { id: 'copy', name: 'Exploration copy' }
  const copied: CanvasGuide = { ...onSecond, id: 'g3', pageId: 'copy' }
  api.duplicatePage.mockImplementation(async () => {
    /* the broadcasts land before the response */
    useStore.getState().setPages([...pages, copyPage])
    useStore.getState().setGuideLocal(copied.id, copied)
    return { page: copyPage, pages: [...pages, copyPage], frames: [] }
  })
  await duplicatePage(useStore.getState().canvas!, 'second')
  await undo()
  expect(guides().some((g) => g.pageId === 'copy')).toBe(false)
  await redo()
  expect(api.putGuide).toHaveBeenLastCalledWith('c', copied)
  expect(guides()).toContainEqual(copied)
})

it('does not record a guide save that finishes under another history', async () => {
  const save = deferred()
  api.putGuide.mockReturnValueOnce(save.promise)
  const pending = commitGuide('c', onFirst, { ...onFirst, at: 99 })
  /* leave the canvas and come back: a fresh history */
  clearHistory()
  useStore.getState().setCanvas(structuredClone(canvas))
  save.resolve({ ...onFirst, at: 99 })
  await pending
  await undo()
  expect(api.putGuide).toHaveBeenCalledTimes(1)
})

it('writes one guide in order and keeps a newer move when an older save fails', async () => {
  const first = deferred()
  api.putGuide.mockReturnValueOnce(first.promise)
  const a = commitGuide('c', onFirst, { ...onFirst, at: 20 })
  const b = commitGuide('c', { ...onFirst, at: 20 }, { ...onFirst, at: 30 })
  /* the second write waits for the first */
  await vi.waitFor(() => expect(api.putGuide).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(api.putGuide).toHaveBeenCalledTimes(1)
  first.reject(new Error('offline'))
  await Promise.all([a, b])
  expect(api.putGuide).toHaveBeenCalledTimes(2)
  expect(guides().find((g) => g.id === 'g1')?.at).toBe(30)
  /* undo returns to what the server last held, not the failed position */
  await undo()
  expect(api.putGuide).toHaveBeenLastCalledWith('c', onFirst)
  expect(guides().find((g) => g.id === 'g1')?.at).toBe(10)
})

it('rolls a failed save back to what the server holds when it is the latest edit', async () => {
  api.putGuide.mockRejectedValueOnce(new Error('offline'))
  await commitGuide('c', onFirst, { ...onFirst, at: 50 })
  expect(guides().find((g) => g.id === 'g1')).toEqual(onFirst)
})

it('hides guides on a phone and lets go of the selection when guides are hidden', () => {
  const state = { ...useStore.getState(), rulers: true, activePageId: 'first' }
  expect(visibleGuides({ ...state, phone: false })).toEqual([onFirst])
  expect(visibleGuides({ ...state, phone: true })).toEqual([])
  if (!useStore.getState().rulers) useStore.getState().toggleRulers()
  useStore.getState().selectGuide('g1')
  useStore.getState().toggleRulers()
  expect(useStore.getState().selectedGuideId).toBeNull()
  useStore.getState().toggleRulers()
  useStore.getState().selectGuide('g1')
  useStore.getState().toggleUiHidden()
  expect(useStore.getState().selectedGuideId).toBeNull()
  useStore.getState().toggleUiHidden()
})
