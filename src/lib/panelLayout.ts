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

/* the choice as set this session; storage can be off limits (private
   browsing, a locked down webview) and the switch must still work */
let active: PanelLayout | null = null
const listeners = new Set<() => void>()

export function getPanelLayout(): PanelLayout {
  if (active) return active
  try {
    const stored = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY)
    active = isPanelLayout(stored) ? stored : 'floating'
  } catch {
    active = 'floating'
  }
  return active
}

export function setPanelLayout(layout: PanelLayout): void {
  active = layout
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
    if (e.key !== PANEL_LAYOUT_STORAGE_KEY) return
    active = null
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
