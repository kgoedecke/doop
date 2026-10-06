// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/* the test runtime has no localStorage; the module only needs get and set */
const store = new Map<string, string>()
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
}

/* the module caches the preference, so every test gets a fresh copy */
type ThemeModule = typeof import('../src/lib/theme')
let theme: ThemeModule
const root = () => document.documentElement

beforeEach(async () => {
  store.clear()
  vi.stubGlobal('localStorage', storage)
  root().className = ''
  root().style.colorScheme = ''
  vi.resetModules()
  theme = await import('../src/lib/theme')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('follows the system when nothing is stored, and ignores garbage', () => {
  expect(theme.getTheme()).toBe('system')
  theme.initTheme()
  /* happy-dom reports no dark preference */
  expect(root().classList.contains('dark')).toBe(false)
  expect(root().style.colorScheme).toBe('light')

  storage.setItem(theme.THEME_STORAGE_KEY, 'blue')
  vi.resetModules()
  return import('../src/lib/theme').then((fresh) => expect(fresh.getTheme()).toBe('system'))
})

it('paints the stored preference before React mounts', () => {
  storage.setItem(theme.THEME_STORAGE_KEY, 'dark')
  theme.initTheme()
  expect(root().classList.contains('dark')).toBe(true)
  expect(root().style.colorScheme).toBe('dark')
})

it('setTheme persists, repaints, and re-renders the hook', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.append(container)
  function Probe() {
    const { theme: preference, resolved } = theme.useTheme()
    return <p>{`${preference}/${resolved}`}</p>
  }
  const app = createRoot(container)
  await act(async () => app.render(<Probe />))
  expect(container.textContent).toBe('system/light')

  await act(async () => theme.setTheme('dark'))
  expect(container.textContent).toBe('dark/dark')
  expect(storage.getItem(theme.THEME_STORAGE_KEY)).toBe('dark')
  expect(root().classList.contains('dark')).toBe(true)
  expect(root().style.colorScheme).toBe('dark')

  await act(async () => theme.setTheme('light'))
  expect(container.textContent).toBe('light/light')
  expect(root().classList.contains('dark')).toBe(false)

  await act(async () => app.unmount())
  container.remove()
})

it('keeps the choice for the session when storage is unavailable', () => {
  vi.spyOn(storage, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError')
  })
  theme.setTheme('dark')
  expect(theme.getTheme()).toBe('dark')
  expect(root().classList.contains('dark')).toBe(true)
})

it('picks up a change made in another tab', () => {
  theme.initTheme()
  storage.setItem(theme.THEME_STORAGE_KEY, 'dark')
  window.dispatchEvent(new StorageEvent('storage', { key: theme.THEME_STORAGE_KEY }))
  expect(theme.getTheme()).toBe('dark')
  expect(root().classList.contains('dark')).toBe(true)
})
