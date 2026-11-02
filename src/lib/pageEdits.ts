import type { Canvas, CanvasPageInfo } from '../../shared/types'
import { canvasPages, framePageId, samePages } from '../../shared/pages'
import { api, ApiError } from './api'
import { useStore } from './store'
import { guidesLeaving, recordPageCopy, recordPages, recordUpdates, trackSave } from './history'

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
        moved.push({ frameId: id, before: { pageId: framePageId(canvas, before) }, after: { pageId } })
      }
      if (useStore.getState().canvas?.id === canvas.id) useStore.getState().setActivePage(pageId)
    } finally {
      if (useStore.getState().canvas?.id === canvas.id) recordUpdates(moved)
    }
  })()
  trackSave(task)
  return task
}
