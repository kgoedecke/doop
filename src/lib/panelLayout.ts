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

/* The choice as set this session, for when storage is off limits (private
   browsing, a locked down webview) and the switch must still work. Storage
   itself is read every time, so a pick made in another tab while no page
   here was listening is never shadowed by a stale copy. */
let fallback: PanelLayout = 'floating'
const listeners = new Set<() => void>()

export function getPanelLayout(): PanelLayout {
  try {
    const stored = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY)
    if (isPanelLayout(stored)) return stored
  } catch {
    /* storage unavailable: this session's choice stands */
  }
  return fallback
}

export function setPanelLayout(layout: PanelLayout): void {
  fallback = layout
  try {
    localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, layout)
  } catch {
    /* kept for this session only */
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  /* another tab of this browser changed it */
  const onStorage = (e: StorageEvent) => {
    if (e.key === PANEL_LAYOUT_STORAGE_KEY) listener()
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
