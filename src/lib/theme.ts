import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'doop-theme'

type ThemeListener = () => void
const listeners = new Set<ThemeListener>()

function notifyListeners() {
  listeners.forEach((listener) => {
    try {
      listener()
    } catch (err) {
      console.error('Error in theme listener:', err)
    }
  })
}

/**
 * Returns the system theme preference ('dark' or 'light').
 */
export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Returns the currently configured theme preference ('light', 'dark', or 'system').
 * Defaults to 'system' if nothing is saved or if storage is inaccessible.
 */
export function getTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    // LocalStorage might be restricted
  }
  return 'system'
}

/**
 * Resolves any theme ('light', 'dark', or 'system') to the concrete 'light' or 'dark' mode.
 */
export function resolveTheme(theme: Theme = getTheme()): ResolvedTheme {
  return theme === 'system' ? getSystemTheme() : theme
}

/**
 * Returns the current concrete theme applied to the document ('light' or 'dark').
 */
export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(getTheme())
}

/**
 * Applies the given theme to the document HTML element and synchronizes color-scheme.
 */
export function applyTheme(theme: Theme = getTheme()): ResolvedTheme {
  const resolved = resolveTheme(theme)
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    if (resolved === 'dark') {
      root.classList.add('dark')
      root.style.colorScheme = 'dark'
    } else {
      root.classList.remove('dark')
      root.style.colorScheme = 'light'
    }
  }
  return resolved
}

/**
 * Updates the user's theme preference, persists it to localStorage,
 * updates the document classes, and notifies all subscribers.
 */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // LocalStorage might be restricted
  }
  applyTheme(theme)
  notifyListeners()
}

/**
 * Convenience function to toggle between light and dark modes.
 */
export function toggleDarkMode(): void {
  const currentResolved = getResolvedTheme()
  const nextTheme: Theme = currentResolved === 'dark' ? 'light' : 'dark'
  setTheme(nextTheme)
}

function subscribe(listener: ThemeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Global browser listeners for system changes and cross-tab storage sync
if (typeof window !== 'undefined') {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const handleMediaChange = () => {
    if (getTheme() === 'system') {
      applyTheme('system')
      notifyListeners()
    }
  }

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', handleMediaChange)
  } else if (typeof (mediaQuery as { addListener?: (cb: () => void) => void }).addListener === 'function') {
    ;(mediaQuery as { addListener: (cb: () => void) => void }).addListener(handleMediaChange)
  }

  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) {
      applyTheme(getTheme())
      notifyListeners()
    }
  })

  // Ensure DOM matches preference on module evaluation
  applyTheme()
}

export interface UseThemeResult {
  /** The configured preference: 'light', 'dark', or 'system' */
  theme: Theme
  /** The effective active theme: 'light' or 'dark' */
  resolvedTheme: ResolvedTheme
  /** True if dark mode is active */
  isDark: boolean
  /** Update the theme preference */
  setTheme: (theme: Theme) => void
  /** Toggle between light and dark */
  toggleDarkMode: () => void
}

/**
 * React hook to read and manipulate the active theme.
 * Re-renders whenever the theme setting or system preference changes.
 */
export function useTheme(): UseThemeResult {
  const theme = useSyncExternalStore(subscribe, getTheme, () => 'system' as Theme)
  const resolvedTheme = resolveTheme(theme)
  const isDark = resolvedTheme === 'dark'

  return {
    theme,
    resolvedTheme,
    isDark,
    setTheme,
    toggleDarkMode,
  }
}
