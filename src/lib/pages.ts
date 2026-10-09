import { useMemo } from 'react'
import { useStore } from './store'
import { canvasPages, pageFrames } from '../../shared/pages'

export function usePageCanvas() {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  return useMemo(
    () => (canvas ? { ...canvas, frames: pageFrames(canvas, activePageId ?? canvasPages(canvas)[0]!.id) } : null),
    [canvas, activePageId],
  )
}

export function currentPageCanvas() {
  const { canvas, activePageId } = useStore.getState()
  return canvas ? { ...canvas, frames: pageFrames(canvas, activePageId ?? canvasPages(canvas)[0]!.id) } : null
}
