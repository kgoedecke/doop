import { describe, expect, it } from 'vitest'
import { getTheme, resolveTheme, setTheme } from '../src/lib/theme'

describe('theme utilities', () => {
  it('resolves explicit light and dark themes correctly', () => {
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('defaults to system mode when nothing is set in storage', () => {
    expect(getTheme()).toBe('system')
  })

  it('resolves system mode based on matchMedia fallback', () => {
    const resolved = resolveTheme('system')
    expect(['light', 'dark']).toContain(resolved)
  })

  it('updates in-memory theme when setTheme is called', () => {
    setTheme('dark')
    expect(getTheme()).toBe('dark')
    setTheme('system')
  })
})
