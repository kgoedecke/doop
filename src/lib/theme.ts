import { useSyncExternalStore } from 'react'

/** What a person asks for: a fixed look, or whatever the OS is set to. */
export type Theme = 'light' | 'dark' | 'system'
/** What the document is actually painted in. */
export type ResolvedTheme = 'light' | 'dark'

/* index.html reads this same key before the bundle loads, so a reload never
   flashes the light theme — change one and change the other. The choice is
   per browser, not per account: it is how this device looks, like zoom. */
export const THEME_STORAGE_KEY = 'doop-theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

/* The preference as set this session. Storage can be off limits (a locked
   down webview, private browsing) and the switch must still work. */
let active: Theme | null = null
const listeners = new Set<() => void>()

function readStored(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(stored) ? stored : null
  } catch {
    return null
  }
}

export function getTheme(): Theme {
  if (!active) active = readStored() ?? 'system'
  return active
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? systemTheme() : theme
}

/* `.dark` on <html> flips the design tokens; color-scheme flips what the
   browser draws itself — scrollbars, native selects, form controls. */
function paint(theme: Theme): void {
  const resolved = resolveTheme(theme)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
}

type ThemeState = { theme: Theme; resolved: ResolvedTheme }

/* useSyncExternalStore wants the same object back until something changed,
   so the snapshot is cached and dropped on every notification */
let snapshot: ThemeState | null = null

function getSnapshot(): ThemeState {
  if (!snapshot) {
    const theme = getTheme()
    snapshot = { theme, resolved: resolveTheme(theme) }
  }
  return snapshot
}

function notify(): void {
  snapshot = null
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setTheme(theme: Theme): void {
  active = theme
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* nowhere to keep it — the choice still holds until the tab closes */
  }
  paint(theme)
  notify()
}

/** Paints the stored preference and keeps it in step with the OS and with
 *  other tabs. Called once, before React mounts. */
export function initTheme(): void {
  paint(getTheme())
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    if (getTheme() !== 'system') return
    paint('system')
    notify()
  })
  /* another tab changed it (or cleared storage, where key is null) */
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return
    active = null
    paint(getTheme())
    notify()
  })
}

/** The preference, what it currently resolves to, and the setter. Re-renders
 *  when the preference, the OS setting, or another tab changes it. */
export function useTheme(): ThemeState & { setTheme: (theme: Theme) => void } {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  return { ...state, setTheme }
}
