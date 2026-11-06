import type { Canvas, CanvasPageInfo } from '../../shared/types'
import { canvasPages, framePageId, samePages } from '../../shared/pages'
import { stackOf } from '../../shared/frameStack'
import { api, ApiError } from './api'
import { useStore } from './store'
import { pageBackground } from '../../shared/pageBackground'
import {
  guidesLeaving,
  historyEpoch,
  recordPageBackground,
  recordPageCopy,
  recordPages,
  recordUpdates,
  trackSave,
} from './history'

export function savePages(canvas: Canvas, next: CanvasPageInfo[], selectId?: string) {
  const task = savePagesAndRecord(canvas, next, selectId)
  trackSave(task)
  return task
}

async function savePagesAndRecord(canvas: Canvas, next: CanvasPageInfo[], selectId?: string) {
  const expected = canvasPages(canvas)
  const activeBefore = useStore.getState().activePageId
  /* the guides a deleted page takes with it, for undo to bring back */
  const leaving = guidesLeaving(canvas, next)
  try {
    const saved = await api.setPages(canvas.id, next, expected)
    const state = useStore.getState()
    if (state.canvas?.id !== canvas.id) return
    const activeAfter = selectId ?? (saved.some((p) => p.id === activeBefore) ? activeBefore : saved[0]!.id)
    recordPages(canvas.id, expected, saved, activeBefore, activeAfter, leaving)
    // A newer broadcast can arrive before this HTTP response.
    if (!samePages(canvasPages(state.canvas), expected) && !samePages(canvasPages(state.canvas), saved)) return
    state.setPages(saved, canvas.id)
    if (selectId) state.setActivePage(selectId)
  } catch (error) {
    if (useStore.getState().canvas?.id !== canvas.id) return
    if (error instanceof ApiError && error.status === 409 && Array.isArray(error.body.pages)) {
      // Refresh instead of replacing a possibly newer WebSocket state with the rejected save.
      const beforeRefresh = canvasPages(useStore.getState().canvas!)
      const current = await api.getCanvas(canvas.id)
      const state = useStore.getState()
      if (state.canvas?.id === canvas.id && samePages(canvasPages(state.canvas), beforeRefresh)) {
        state.setPages(canvasPages(current), canvas.id)
      }
    }
    throw error
  }
}

/** Copy a page and its frames in one server call, then show the copy. */
export function duplicatePage(canvas: Canvas, pageId: string) {
  const task = (async () => {
    const expected = canvasPages(canvas)
    const activeBefore = useStore.getState().activePageId
    const copy = await api.duplicatePage(canvas.id, pageId)
    const state = useStore.getState()
    if (state.canvas?.id !== canvas.id) return
    /* history holds only this action's change (the copy after its source),
       not whatever collaborators did to the list meanwhile, so undo takes
       back the copy alone */
    const after = [...expected]
    after.splice(expected.findIndex((page) => page.id === pageId) + 1, 0, copy.page)
    recordPageCopy(canvas.id, expected, after, activeBefore, copy.page.id, copy.frames)
    /* the broadcast usually lands first; a page list or frame that already
       moved on past this response is left alone */
    if (samePages(canvasPages(state.canvas), expected)) state.setPages(copy.pages, canvas.id)
    for (const frame of copy.frames) {
      const local = state.canvas.frames.find((f) => f.id === frame.id)
      if (!local || local.updatedAt < frame.updatedAt) state.upsertFrame(frame)
    }
    useStore.getState().setActivePage(copy.page.id)
  })()
  trackSave(task)
  return task
}

export function moveFramesToPage(canvas: Canvas, ids: string[], pageId: string) {
  const task = (async () => {
    const moved: Parameters<typeof recordUpdates>[0] = []
    try {
      for (const id of ids) {
        if (useStore.getState().canvas?.id !== canvas.id) return
        const before = canvas.frames.find((f) => f.id === id)
        if (!before || framePageId(canvas, before) === pageId) continue
        const frame = await api.updateFrame(id, { pageId })
        if (useStore.getState().canvas?.id !== canvas.id) return
        useStore.getState().upsertFrame(frame)
        /* the server puts it in front on its new page; undo puts it back
           where it was in the old page's stack, not in front there */
        moved.push({
          frameId: id,
          before: { pageId: framePageId(canvas, before), z: stackOf(before) },
          after: { pageId, z: stackOf(frame) },
        })
      }
      if (useStore.getState().canvas?.id === canvas.id) useStore.getState().setActivePage(pageId)
    } finally {
      if (useStore.getState().canvas?.id === canvas.id) recordUpdates(moved)
    }
  })()
  trackSave(task)
  return task
}

/** The colour the open canvas shows for a page right now. */
function shownBackground(canvasId: string, pageId: string): string | null {
  const canvas = useStore.getState().canvas
  if (canvas?.id !== canvasId) return null
  return pageBackground(canvasPages(canvas).find((page) => page.id === pageId))
}

/* One page's colour writes in flight, run one after another so they land in
   the order they were made. `saved` is what the server last accepted, which
   a failed write puts back when no newer edit of the page is queued. */
type BackgroundWrites = { tail: Promise<unknown>; latest: number; saved: string | null; shown: string | null }
const backgroundWrites = new Map<string, BackgroundWrites>()

/** Paint a page's canvas (`#rrggbb`) or put the theme paper back (null):
 *  shown at once, saved through the API, one undo step per save that lands.
 *  A failed save puts back what the server holds, unless the page has been
 *  painted again since; a save finishing after the canvas was left (or
 *  revisited, under a fresh history) touches nothing. */
export function setPageBackground(canvas: Canvas, pageId: string, color: string | null) {
  const state = useStore.getState()
  if (state.canvas?.id !== canvas.id) return Promise.resolve()
  const before = pageBackground(canvasPages(state.canvas).find((page) => page.id === pageId))
  if (before === color) return Promise.resolve()
  state.setPageBackgroundLocal(pageId, color)
  const key = `${canvas.id}:${pageId}`
  const queue = backgroundWrites.get(key) ?? { tail: Promise.resolve(), latest: 0, saved: before, shown: before }
  backgroundWrites.set(key, queue)
  /* a colour this queue did not paint arrived meanwhile (a teammate's): that
     is what the person saw before this edit, so it is what undo and a
     failed save go back to */
  if (before !== queue.shown) queue.saved = before
  queue.shown = color
  const seq = ++queue.latest
  const epoch = historyEpoch()
  /* the canvas this save was made on is still open, under the same history */
  const current = () => useStore.getState().canvas?.id === canvas.id && historyEpoch() === epoch
  const task = queue.tail
    .then(() => api.setPageBackground(canvas.id, pageId, color))
    .then(
      () => {
        const from = queue.saved
        queue.saved = color
        if (current()) recordPageBackground(canvas.id, pageId, from, color)
      },
      (error: unknown) => {
        /* put back what the server holds, unless a newer edit of this page
           is queued or the page already shows a colour from elsewhere */
        if (current() && queue.latest === seq && shownBackground(canvas.id, pageId) === queue.shown) {
          useStore.getState().setPageBackgroundLocal(pageId, queue.saved)
          queue.shown = queue.saved
        }
        throw error
      },
    )
    .finally(() => {
      if (queue.latest === seq) backgroundWrites.delete(key)
    })
  trackSave(task)
  /* the queue carries on past a failed write; the caller still hears of it */
  queue.tail = task.catch(() => undefined)
  return task
}
