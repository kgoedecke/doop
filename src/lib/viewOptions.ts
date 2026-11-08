/* What the canvas draws over the frames, each switched from the zoom pill's
   menu or its shortcut, and remembered per browser:
   - pixelGrid (⇧'): the hairline grid that fades in from 300%
   - cursors (⌘⌥\ / Ctrl+Alt+\): everyone else's pointer
   - comments (⇧C): the comment pins; the Comment tool still shows them */

export interface ViewOptions {
  pixelGrid: boolean
  cursors: boolean
  comments: boolean
}

export type ViewOption = keyof ViewOptions

export const DEFAULT_VIEW_OPTIONS: ViewOptions = { pixelGrid: true, cursors: true, comments: true }

const VIEW_OPTIONS_KEY = 'doop:view-options'

export function readViewOptions(): ViewOptions {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(VIEW_OPTIONS_KEY) ?? '{}')
    if (!stored || typeof stored !== 'object') return DEFAULT_VIEW_OPTIONS
    const options = { ...DEFAULT_VIEW_OPTIONS }
    for (const name of Object.keys(DEFAULT_VIEW_OPTIONS) as ViewOption[]) {
      const value = (stored as Record<string, unknown>)[name]
      if (typeof value === 'boolean') options[name] = value
    }
    return options
  } catch {
    return DEFAULT_VIEW_OPTIONS
  }
}

export function writeViewOptions(options: ViewOptions) {
  try {
    localStorage.setItem(VIEW_OPTIONS_KEY, JSON.stringify(options))
  } catch {
    /* private mode: the choice just doesn't stick */
  }
}

/** The option a key press toggles, or null. Read by `code`: ⇧ and ⌥ change
 *  the typed character (⇧' is `"`, ⌥\ is `«` on macOS). */
export function viewOptionForKey(
  e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): ViewOption | null {
  const mod = e.metaKey || e.ctrlKey
  if (e.shiftKey && !mod && !e.altKey) {
    if (e.code === 'Quote') return 'pixelGrid'
    if (e.code === 'KeyC') return 'comments'
    return null
  }
  if (mod && e.altKey && !e.shiftKey && e.code === 'Backslash') return 'cursors'
  return null
}

/** A typed zoom level ("150", "150%", "33.3 %") as a zoom factor, or null
 *  when it is not a positive number. */
export function parseZoomPercent(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*%?\s*$/.exec(text)
  if (!match) return null
  const percent = Number(match[1])
  return percent > 0 ? percent / 100 : null
}
