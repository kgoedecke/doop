import { nanoid } from 'nanoid'
import type { CanvasGuide } from '../../shared/types'
import { roundGuidePosition, sameGuide } from '../../shared/guides'
import { MOBILE_QUERY } from '../hooks/use-mobile'
import { api } from './api'
import { historyEpoch, recordGuide, trackSave } from './history'
import { useStore } from './store'

type GuideState = Pick<ReturnType<typeof useStore.getState>, 'canvas' | 'activePageId' | 'rulers' | 'uiHidden'> & {
  /** the phone breakpoint, for a component that subscribes to it; read live otherwise */
  phone?: boolean
}

function phoneLayout(): boolean {
  try {
    return window.matchMedia(MOBILE_QUERY).matches
  } catch {
    return false
  }
}

/** The ruler guides on the page in view. Guides show with the rulers, and
 *  only what is on screen snaps: with the rulers off (or the chrome hidden
 *  with ⌘., or on a phone, which has no rulers) there are none. */
export function visibleGuides(s: GuideState = useStore.getState()): CanvasGuide[] {
  if (!s.rulers || s.uiHidden || !s.canvas?.guides?.length || (s.phone ?? phoneLayout())) return []
  return s.canvas.guides.filter((guide) => guide.pageId === s.activePageId)
}

export function newGuide(pageId: string, axis: CanvasGuide['axis'], at: number): CanvasGuide {
  return { id: nanoid(10), pageId, axis, at: roundGuidePosition(at) }
}

/* One guide's writes in flight, run one after another so they land in the
   order they were made. `saved` is what the server last accepted, which a
   failed write puts back when no newer edit of the guide is queued. */
type GuideWrites = { tail: Promise<unknown>; latest: number; saved: CanvasGuide | null }
const writes = new Map<string, GuideWrites>()

/** Save one guide change, `before` → `after` (null for "not there"), as one
 *  undo step. The local copy changes at once; a failed save puts back what
 *  the server holds, unless the guide has been edited again since. */
export function commitGuide(canvasId: string, before: CanvasGuide | null, after: CanvasGuide | null) {
  const id = (after ?? before)?.id
  if (!id) return Promise.resolve()
  const store = useStore.getState()
  if (store.canvas?.id !== canvasId) return Promise.resolve()
  store.setGuideLocal(id, after)
  if (sameGuide(before, after)) return Promise.resolve()
  const key = `${canvasId}:${id}`
  const queue = writes.get(key) ?? { tail: Promise.resolve(), latest: 0, saved: before }
  writes.set(key, queue)
  const seq = ++queue.latest
  const epoch = historyEpoch()
  /* the canvas this save was made on is still open, under the same history */
  const current = () => useStore.getState().canvas?.id === canvasId && historyEpoch() === epoch
  const send = (): Promise<unknown> => (after ? api.putGuide(canvasId, after) : api.deleteGuide(canvasId, id))
  const task = queue.tail
    .then(send)
    .then(
      () => {
        const from = queue.saved
        queue.saved = after
        if (current()) recordGuide(canvasId, from, after)
      },
      (err: unknown) => {
        if (!current()) return
        const s = useStore.getState()
        if (queue.latest === seq) s.setGuideLocal(id, queue.saved)
        s.pushNotice(err instanceof Error ? err.message : 'Could not save the guide.')
      },
    )
    .finally(() => {
      if (queue.latest === seq) writes.delete(key)
    })
  queue.tail = task
  trackSave(task)
  return task
}
