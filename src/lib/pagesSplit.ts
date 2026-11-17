/* The split between the Pages list and the Layers tree in the canvas rail.
   It is kept as a percentage of the rail's height, so one split fits any
   window. The Pages section is as tall as its content, up to the limit this
   split sets: `pagesMaxHeightCss` clamps that limit again in CSS, so a window
   that shrinks below the size the split was dragged in still shows both lists. */
import { useEffect, useState } from 'react'

/** the least the Pages section gets with no move picker: its heading, one page row,
 *  the list's bottom padding and the 1px divider (30 + 27 + 4 + 1px);
 *  PagesPanel's classes set those sizes */
export const PAGES_BASE_MIN_PX = 62
/** what the move picker adds while it is shown (its 32px trigger and 8px of padding) */
export const PAGES_MOVE_PICKER_PX = 40
/** what the Layers tree always keeps: the rail's header, the Layers heading
 *  and search footer, and room for a few rows */
export const LAYERS_MIN_PX = 240
/** how far one arrow press moves the split */
export const PAGES_KEY_STEP_PX = 10

const STORAGE_KEY = 'doop:layers-pages-split'

/** the least the Pages section gets: one page row, plus the move picker while it is shown */
export function pagesMinPx(withMovePicker: boolean): number {
  return withMovePicker ? PAGES_BASE_MIN_PX + PAGES_MOVE_PICKER_PX : PAGES_BASE_MIN_PX
}

/** the most the Pages section gets: the room the Layers tree leaves, never below `minPx` */
export function pagesMaxPx(railPx: number, minPx: number): number {
  return Math.max(minPx, railPx - LAYERS_MIN_PX)
}

/** a Pages height, held between `minPx` and the room the Layers tree keeps */
export function clampPagesPx(px: number, railPx: number, minPx: number): number {
  return Math.min(pagesMaxPx(railPx, minPx), Math.max(minPx, px))
}

/** a Pages height as a percentage of the rail */
export function pagesPctOf(px: number, railPx: number): number {
  return (px / railPx) * 100
}

/** the CSS height limit of the Pages section for a stored percentage, with the limits `clampPagesPx` applies */
export function pagesMaxHeightCss(pct: number, minPx: number): string {
  return `clamp(${minPx}px, ${pct}%, calc(100% - ${LAYERS_MIN_PX}px))`
}

/** the Pages height an arrow key, Home or End asks for; undefined for any other key.
 *  Home and End clamp infinity, so they stop at the same limits as a drag. */
export function pagesPxAfterKey(key: string, pagesPx: number, railPx: number, minPx: number): number | undefined {
  switch (key) {
    case 'ArrowUp':
      return clampPagesPx(pagesPx - PAGES_KEY_STEP_PX, railPx, minPx)
    case 'ArrowDown':
      return clampPagesPx(pagesPx + PAGES_KEY_STEP_PX, railPx, minPx)
    case 'Home':
      return clampPagesPx(-Infinity, railPx, minPx)
    case 'End':
      return clampPagesPx(Infinity, railPx, minPx)
    default:
      return undefined
  }
}

/** a stored split, or null when it is missing or not a percentage of the rail */
export function readPagesPct(raw: string | null): number | null {
  if (raw === null) return null
  const pct = Number(raw)
  return Number.isFinite(pct) && pct > 0 && pct < 100 ? pct : null
}

/** The split as the user last left it, kept per browser; null until it is dragged. */
export function usePagesPct(): [number | null, (pct: number | null) => void] {
  const [pct, setPct] = useState<number | null>(readStoredPct)
  useEffect(() => {
    try {
      if (pct === null) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, String(pct))
    } catch {
      /* the split still works when it cannot be saved */
    }
  }, [pct])
  return [pct, setPct]
}

function readStoredPct(): number | null {
  try {
    return readPagesPct(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}
