import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'doop-theme'
const THEME_CHANGE_EVENT = 'doop-theme-change'

export function getTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored
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
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, theme)
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
    const handleThemeChange = () => {
      const currentTheme = getTheme()
      setLocalTheme(currentTheme)
      setResolvedTheme(resolveTheme(currentTheme))
    }

    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange)
    window.addEventListener('storage', handleThemeChange)

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
      window.removeEventListener('storage', handleThemeChange)
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
