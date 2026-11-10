import { beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, CanvasGuide } from '../shared/types'

const api = vi.hoisted(() => ({
  setPages: vi.fn(),
  setPageBackground: vi.fn(),
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
const { savePages, duplicatePage, setPageBackground } = await import('../src/lib/pageEdits')
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

const background = (id: string) => useStore.getState().canvas?.pages?.find((p) => p.id === id)?.background

it('paints a page at once, saves it, and takes the colour back and forth through undo and redo', async () => {
  api.setPageBackground.mockImplementation(async () => [])
  await setPageBackground(useStore.getState().canvas!, 'first', '#1e1e1e')
  expect(api.setPageBackground).toHaveBeenCalledWith('c', 'first', '#1e1e1e')
  expect(background('first')).toBe('#1e1e1e')
  await undo()
  expect(api.setPageBackground).toHaveBeenLastCalledWith('c', 'first', null)
  expect(background('first')).toBeUndefined()
  await redo()
  expect(background('first')).toBe('#1e1e1e')
  /* the same colour again is no edit and no undo step */
  await setPageBackground(useStore.getState().canvas!, 'first', '#1e1e1e')
  expect(api.setPageBackground).toHaveBeenCalledTimes(3)
})

it('puts the previous colour back when the save fails', async () => {
  api.setPageBackground.mockRejectedValue(new Error('offline'))
  await expect(setPageBackground(useStore.getState().canvas!, 'first', '#1e1e1e')).rejects.toThrow('offline')
  expect(background('first')).toBeUndefined()
  await undo()
  expect(api.setPageBackground).toHaveBeenCalledTimes(1)
})

it('leaves a colour a teammate painted meanwhile when an undo fails', async () => {
  api.setPageBackground.mockImplementation(async () => [])
  await setPageBackground(useStore.getState().canvas!, 'first', '#1e1e1e')
  const pending = deferred<never>()
  api.setPageBackground.mockReturnValue(pending.promise)
  const undone = undo()
  await vi.waitFor(() => expect(background('first')).toBeUndefined())
  /* the room delivers someone else's colour while the undo is still in flight */
  useStore.getState().setPageBackgroundLocal('first', '#ffd166')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  pending.reject(new Error('offline'))
  await undone
  expect(background('first')).toBe('#ffd166')
})

it('brings a deleted painted page back with its colour on undo, and a duplicated one on redo', async () => {
  api.setPageBackground.mockImplementation(async () => [])
  useStore.getState().setPageBackgroundLocal('second', '#1e1e1e')
  await savePages(useStore.getState().canvas!, [pages[0]!])
  expect(background('second')).toBeUndefined()
  api.setPageBackground.mockClear()
  await undo()
  expect(api.setPageBackground).toHaveBeenCalledWith('c', 'second', '#1e1e1e')
  expect(background('second')).toBe('#1e1e1e')

  api.duplicatePage.mockResolvedValue({
    page: { id: 'twin', name: 'Exploration copy', background: '#1e1e1e' },
    pages: [...pages, { id: 'twin', name: 'Exploration copy', background: '#1e1e1e' }],
    frames: [],
  })
  await duplicatePage(useStore.getState().canvas!, 'second')
  await undo()
  expect(background('twin')).toBeUndefined()
  api.setPageBackground.mockClear()
  await redo()
  expect(api.setPageBackground).toHaveBeenCalledWith('c', 'twin', '#1e1e1e')
  expect(background('twin')).toBe('#1e1e1e')
})

it('runs quick colour changes in order and keeps the newest when an older save fails', async () => {
  const first = deferred<never>()
  api.setPageBackground.mockReturnValueOnce(first.promise).mockResolvedValue([])
  const canvas = useStore.getState().canvas!
  const one = setPageBackground(canvas, 'first', '#111111')
  const two = setPageBackground(useStore.getState().canvas!, 'first', '#222222')
  expect(background('first')).toBe('#222222')
  /* the second write waits for the first */
  await vi.waitFor(() => expect(api.setPageBackground).toHaveBeenCalledTimes(1))
  first.reject(new Error('offline'))
  await expect(one).rejects.toThrow('offline')
  await two
  expect(api.setPageBackground).toHaveBeenNthCalledWith(2, 'c', 'first', '#222222')
  expect(background('first')).toBe('#222222')
  /* the one save that landed is the one undo step, back to the colour before both */
  await undo()
  expect(api.setPageBackground).toHaveBeenLastCalledWith('c', 'first', null)
  expect(background('first')).toBeUndefined()
})

it('leaves a fresh visit alone when a colour save from before it finishes', async () => {
  const pending = deferred<never>()
  api.setPageBackground.mockReturnValueOnce(pending.promise)
  const task = setPageBackground(useStore.getState().canvas!, 'second', '#1e1e1e')
  await vi.waitFor(() => expect(api.setPageBackground).toHaveBeenCalledTimes(1))
  /* the person leaves and comes back: a new history, the page unpainted */
  clearHistory()
  useStore.getState().setCanvas(structuredClone(canvas))
  pending.reject(new Error('offline'))
  await expect(task).rejects.toThrow('offline')
  expect(background('second')).toBeUndefined()
  const landed = deferred<unknown[]>()
  api.setPageBackground.mockReturnValueOnce(landed.promise)
  const late = setPageBackground(useStore.getState().canvas!, 'second', '#2e2e2e')
  await vi.waitFor(() => expect(api.setPageBackground).toHaveBeenCalledTimes(2))
  clearHistory()
  landed.resolve([])
  await late
  await undo()
  /* nothing to undo: no further request */
  expect(api.setPageBackground).toHaveBeenCalledTimes(2)
})

it('brings a page back with the colour a teammate gave it after the step was recorded', async () => {
  api.setPageBackground.mockImplementation(async () => [])
  api.duplicatePage.mockResolvedValue({
    page: { id: 'twin', name: 'Exploration copy', background: '#1e1e1e' },
    pages: [...pages, { id: 'twin', name: 'Exploration copy', background: '#1e1e1e' }],
    frames: [],
  })
  await duplicatePage(useStore.getState().canvas!, 'second')
  /* a teammate repaints the copy */
  useStore.getState().setPageBackgroundLocal('twin', '#2e2e2e')
  await undo()
  await redo()
  expect(api.setPageBackground).toHaveBeenLastCalledWith('c', 'twin', '#2e2e2e')
  expect(background('twin')).toBe('#2e2e2e')
})

it('paints a restored page at once and lets an edit made meanwhile stand', async () => {
  useStore.getState().setPageBackgroundLocal('second', '#1e1e1e')
  await savePages(useStore.getState().canvas!, [pages[0]!])
  const restore = deferred<unknown[]>()
  api.setPageBackground.mockReturnValueOnce(restore.promise).mockResolvedValue([])
  const task = undo()
  await vi.waitFor(() => expect(background('second')).toBe('#1e1e1e'))
  useStore.getState().setPageBackgroundLocal('second', '#3e3e3e')
  restore.resolve([])
  await task
  expect(background('second')).toBe('#3e3e3e')
})

it('goes back to a teammate’s colour that arrived between two of its own edits', async () => {
  const first = deferred<unknown[]>()
  api.setPageBackground.mockReturnValueOnce(first.promise).mockResolvedValue([])
  const one = setPageBackground(useStore.getState().canvas!, 'first', '#111111')
  await vi.waitFor(() => expect(api.setPageBackground).toHaveBeenCalledTimes(1))
  /* the room delivers a teammate's colour while the first write is out */
  useStore.getState().setPageBackgroundLocal('first', '#aaaaaa')
  const two = setPageBackground(useStore.getState().canvas!, 'first', '#222222')
  first.resolve([])
  await one
  await two
  /* undo walks back through this client's own edits, then reaches the
     teammate's colour rather than the page's original one */
  await undo()
  expect(background('first')).toBe('#111111')
  await undo()
  expect(background('first')).toBe('#aaaaaa')
})

it('does not roll back a failed save over a colour that arrived from elsewhere', async () => {
  const pending = deferred<never>()
  api.setPageBackground.mockReturnValueOnce(pending.promise)
  const task = setPageBackground(useStore.getState().canvas!, 'first', '#111111')
  await vi.waitFor(() => expect(api.setPageBackground).toHaveBeenCalledTimes(1))
  useStore.getState().setPageBackgroundLocal('first', '#aaaaaa')
  pending.reject(new Error('offline'))
  await expect(task).rejects.toThrow('offline')
  expect(background('first')).toBe('#aaaaaa')
})

it('takes a restored colour off again when its save fails, unless a newer colour arrived', async () => {
  useStore.getState().setPageBackgroundLocal('second', '#1e1e1e')
  await savePages(useStore.getState().canvas!, [pages[0]!])
  api.setPageBackground.mockRejectedValueOnce(new Error('offline'))
  await undo()
  expect(background('second')).toBeUndefined()
  expect(useStore.getState().notice?.text).toContain('could not be put back')

  /* painted again and deleted again, the page remembers the colour it wears now */
  useStore.getState().setPageBackgroundLocal('second', '#1e1e1e')
  await redo()
  const restore = deferred<never>()
  api.setPageBackground.mockReturnValueOnce(restore.promise)
  const task = undo()
  await vi.waitFor(() => expect(background('second')).toBe('#1e1e1e'))
  useStore.getState().setPageBackgroundLocal('second', '#3e3e3e')
  restore.reject(new Error('offline'))
  await task
  expect(background('second')).toBe('#3e3e3e')
})

it('leaves a colour saved on a fresh visit alone when an older restore fails', async () => {
  useStore.getState().setPageBackgroundLocal('second', '#1e1e1e')
  await savePages(useStore.getState().canvas!, [pages[0]!])
  const restore = deferred<never>()
  api.setPageBackground.mockReturnValueOnce(restore.promise).mockResolvedValue([])
  const task = undo()
  await vi.waitFor(() => expect(api.setPageBackground).toHaveBeenCalledTimes(1))
  /* leave and come back; the page is painted the same colour on this visit */
  clearHistory()
  useStore.getState().setCanvas(structuredClone(canvas))
  await setPageBackground(useStore.getState().canvas!, 'second', '#1e1e1e')
  const noticeBefore = useStore.getState().notice
  restore.reject(new Error('offline'))
  await task
  expect(background('second')).toBe('#1e1e1e')
  expect(useStore.getState().notice).toBe(noticeBefore)
})
