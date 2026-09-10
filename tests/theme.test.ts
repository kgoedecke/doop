import { describe, expect, it } from 'vitest'
import { getTheme, resolveTheme } from '../src/lib/theme'

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
})
