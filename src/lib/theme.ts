import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'doop-theme'
const THEME_CHANGE_EVENT = 'doop-theme-change'

let activeTheme: Theme | null = null

export function getTheme(): Theme {
  if (activeTheme !== null) return activeTheme
  if (typeof window === 'undefined') return 'system'
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      activeTheme = stored
      return stored
    }
  } catch {
    // Storage access restricted (e.g. sandboxed webview, private browsing);
    // fall through to default.
  }
  return 'system'
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  }
  return theme
}

export function applyTheme(theme: Theme): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  const resolved = resolveTheme(theme)
  const root = document.documentElement
  if (resolved === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
  root.style.colorScheme = resolved
  return resolved
}

export function setTheme(theme: Theme): void {
  activeTheme = theme
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Storage write failed (quota exceeded, restricted access, etc.);
    // the theme is still applied visually and preserved in-memory for this session.
  }
  applyTheme(theme)
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }))
}

export function initTheme(): void {
  if (typeof window === 'undefined') return
  const current = getTheme()
  applyTheme(current)

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const handleSystemChange = () => {
    if (getTheme() === 'system') {
      applyTheme('system')
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: 'system' }))
    }
  }

  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener('change', handleSystemChange)
  } else {
    mediaQuery.addListener(handleSystemChange)
  }
}

export function useTheme() {
  const [theme, setLocalTheme] = useState<Theme>(() => getTheme())
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => resolveTheme(getTheme()))

  useEffect(() => {
    const handleThemeChange = (e?: Event) => {
      if (e && 'detail' in e) {
        const detailTheme = (e as CustomEvent<Theme>).detail
        if (detailTheme === 'light' || detailTheme === 'dark' || detailTheme === 'system') {
          activeTheme = detailTheme
        }
      }
      const currentTheme = getTheme()
      setLocalTheme(currentTheme)
      setResolvedTheme(resolveTheme(currentTheme))
    }

    const handleStorageChange = (e: StorageEvent) => {
      if (!e.key || e.key === STORAGE_KEY) {
        activeTheme = null
        handleThemeChange()
      }
    }

    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange)
    window.addEventListener('storage', handleStorageChange)

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleMediaChange = () => {
      if (getTheme() === 'system') {
        handleThemeChange()
      }
    }

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleMediaChange)
    } else {
      mediaQuery.addListener(handleMediaChange)
    }

    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange)
      window.removeEventListener('storage', handleStorageChange)
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleMediaChange)
      } else {
        mediaQuery.removeListener(handleMediaChange)
      }
    }
  }, [])

  return {
    theme,
    resolvedTheme,
    setTheme,
  }
}
