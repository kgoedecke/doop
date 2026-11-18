/* The Agents tab is split between Recent tasks on top and the chat under it.
   Dragging the line between them sets how tall Recent tasks is; the chat
   takes the rest. Remembered per browser, like the panel widths. */

const KEY = 'doop:agents-split'

/** Recent tasks never shrinks below its heading and a row. */
export const MIN_RECENT_PX = 64
/** The chat always keeps room for a prompt and its answer. */
export const MIN_CHAT_PX = 120

/** Where the line may sit in a column `total` px tall. */
export function clampRecentHeight(height: number, total: number): number {
  const max = Math.max(MIN_RECENT_PX, total - MIN_CHAT_PX)
  return Math.round(Math.min(max, Math.max(MIN_RECENT_PX, height)))
}

/** The remembered height, or null for the default split. */
export function readRecentHeight(): number | null {
  try {
    const value = Number(localStorage.getItem(KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** Remember a height; null forgets it and goes back to the default split. */
export function writeRecentHeight(height: number | null) {
  try {
    if (height === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(Math.round(height)))
  } catch {
    /* storage refused (private mode): the split lasts this page only */
  }
}
