import { useMemo } from 'react'
import { useStore, type State } from './store'
import { canvasPages, framePageId, pageFrames } from '../../shared/pages'
import type { ClientCanvas } from '../../shared/types'

/** The page's frames hold their current HTML here: the page is not stale (the
 *  room keeps it current), or it has no frames. A stale page is not shown, so a
 *  frame never renders from HTML this browser does not have. */
export function pageReady(state: Pick<State, 'canvas' | 'stalePages'>, pageId: string): boolean {
  const { canvas } = state
  if (!canvas || !state.stalePages[pageId]) return true
  return !canvas.frames.some((frame) => framePageId(canvas, frame) === pageId)
}

/** The frame's HTML here is current: its page is ready. A frame this canvas
 *  does not hold counts as ready, so a caller with no canvas open is not held up. */
export function frameHtmlReady(state: Pick<State, 'canvas' | 'stalePages'>, frameId: string): boolean {
  const frame = state.canvas?.frames.find((candidate) => candidate.id === frameId)
  return !frame || pageReady(state, framePageId(state.canvas!, frame))
}

/** The open canvas with the active page's frames, once that page is ready
 *  (its frames are left out while its HTML is on its way). */
function pageCanvas(state: Pick<State, 'canvas' | 'stalePages' | 'activePageId'>): ClientCanvas | null {
  const { canvas, activePageId } = state
  if (!canvas) return null
  const pageId = activePageId ?? canvasPages(canvas)[0]!.id
  return { ...canvas, frames: pageReady(state, pageId) ? pageFrames(canvas, pageId) : [] }
}

export function usePageCanvas() {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const stalePages = useStore((s) => s.stalePages)
  return useMemo(() => pageCanvas({ canvas, activePageId, stalePages }), [canvas, activePageId, stalePages])
}

export function currentPageCanvas() {
  return pageCanvas(useStore.getState())
}

/** The active page is still on its way. */
export function usePageLoading(): boolean {
  return useStore((s) => !!s.canvas && !!s.activePageId && !pageReady(s, s.activePageId))
}
