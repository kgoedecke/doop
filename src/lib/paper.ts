import { backgroundTone, pageBackground } from '../../shared/pageBackground'
import { canvasPages } from '../../shared/pages'
import type { Canvas } from '../../shared/types'
import { useStore } from './store'
import { getTheme, resolveTheme, useTheme, type ResolvedTheme } from './theme'

/** What the canvas behind a page's frames looks like: its own colour when
 *  the page has one, else the theme paper; and whether light or dark ink
 *  reads on it. */
export interface Paper {
  background: string | null
  tone: ResolvedTheme
}

export function paperOf(
  canvas: Pick<Canvas, 'id' | 'pages'> | null,
  pageId: string | null,
  theme: ResolvedTheme,
): Paper {
  const page = canvas ? canvasPages(canvas).find((p) => p.id === pageId) : undefined
  const background = pageBackground(page)
  return { background, tone: background ? backgroundTone(background) : theme }
}

/** The paper of the page being viewed, following the theme and the page. */
export function usePaper(): Paper {
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const { resolved } = useTheme()
  return paperOf(canvas, activePageId, resolved)
}

/** The paper of one page of the open canvas, read once (a save queued now
 *  keeps the paper it was drawn on). */
export function currentPaper(pageId: string | null): Paper {
  return paperOf(useStore.getState().canvas, pageId, resolveTheme(getTheme()))
}
