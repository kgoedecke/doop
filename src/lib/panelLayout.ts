import { useSyncExternalStore } from 'react'

/** How the canvas editor lays out its side panels: islands floating over
 *  the board, or columns docked to the window's edges with the board
 *  between them. */
export type PanelLayout = 'floating' | 'docked'

/* Per browser, like the theme: it is how this device's editor looks. */
export const PANEL_LAYOUT_STORAGE_KEY = 'doop:panel-layout'

export function isPanelLayout(value: unknown): value is PanelLayout {
  return value === 'floating' || value === 'docked'
}

/* Storage is read every time, so a pick made in another tab while no page
   here was listening is never shadowed by a stale copy. A pick storage
   would not take (private browsing, a full or locked down store) holds for
   this session instead, until another tab saves one. */
let unsaved: PanelLayout | null = null
const listeners = new Set<() => void>()

export function getPanelLayout(): PanelLayout {
  if (unsaved) return unsaved
  try {
    const stored = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY)
    if (isPanelLayout(stored)) return stored
  } catch {
    /* storage unavailable: the default stands */
  }
  return 'floating'
}

export function setPanelLayout(layout: PanelLayout): void {
  try {
    localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, layout)
    unsaved = null
  } catch {
    unsaved = layout
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  /* another tab of this browser saved a pick, which outranks one this tab
     could not save */
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PANEL_LAYOUT_STORAGE_KEY) return
    unsaved = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function usePanelLayout(): PanelLayout {
  return useSyncExternalStore(subscribe, getPanelLayout)
}
