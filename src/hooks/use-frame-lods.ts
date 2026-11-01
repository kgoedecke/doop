import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useStore, type Viewport } from '../lib/store'
import { frameLods, liveFrameBudget, type FrameLod, type LodRect } from '../lib/frameLod'

/* the camera is re-read once it rests: a pan or pinch never swaps documents
   mid-gesture, the same settle the Stage waits for its layout zoom */
const SETTLE_MS = 250

interface SettledView {
  camera: Viewport
  width: number
  height: number
}

/** How each frame on the page is drawn (see frameLod.ts), from the settled
 *  camera, the stage size, the selection and the running agent streams. */
export function useFrameLods(
  stageRef: RefObject<HTMLDivElement | null>,
  frames: readonly LodRect[],
): Map<string, FrameLod> {
  const [budget] = useState(liveFrameBudget)
  /* zero size until the stage is measured: nothing goes live before then,
     so a heavy canvas never mounts every document for one first paint */
  const [view, setView] = useState<SettledView>(() => ({ camera: useStore.getState().viewport, width: 0, height: 0 }))
  const selectedIds = useStore((s) => s.selectedIds)
  /* a joined string, so a new stream chunk with the same streams re-renders nothing */
  const streamIds = useStore((s) => Object.keys(s.streams).join('\n'))

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () =>
      setView({ camera: useStore.getState().viewport, width: stage.clientWidth, height: stage.clientHeight })
    let settle = 0
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.viewport === prev.viewport) return
      window.clearTimeout(settle)
      settle = window.setTimeout(measure, SETTLE_MS)
    })
    const resize = new ResizeObserver(measure)
    resize.observe(stage)
    return () => {
      unsubscribe()
      resize.disconnect()
      window.clearTimeout(settle)
    }
  }, [stageRef])

  return useMemo(
    () =>
      frameLods(frames, view.camera, view, {
        budget,
        pinned: new Set(selectedIds),
        preferred: new Set(streamIds ? streamIds.split('\n') : []),
      }),
    [frames, view, budget, selectedIds, streamIds],
  )
}
