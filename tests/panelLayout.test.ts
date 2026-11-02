// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('panel layout preference', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('floats until someone picks docked, and remembers the pick', async () => {
    const first = await import('../src/lib/panelLayout')
    expect(first.getPanelLayout()).toBe('floating')
    first.setPanelLayout('docked')
    expect(localStorage.getItem(first.PANEL_LAYOUT_STORAGE_KEY)).toBe('docked')
    vi.resetModules()
    const next = await import('../src/lib/panelLayout')
    expect(next.getPanelLayout()).toBe('docked')
  })

  it('ignores a value it does not know', async () => {
    localStorage.setItem('doop:panel-layout', 'sideways')
    const { getPanelLayout } = await import('../src/lib/panelLayout')
    expect(getPanelLayout()).toBe('floating')
  })

  it('picks up a choice another tab stored while nothing here listened', async () => {
    const { getPanelLayout } = await import('../src/lib/panelLayout')
    expect(getPanelLayout()).toBe('floating')
    localStorage.setItem('doop:panel-layout', 'docked')
    expect(getPanelLayout()).toBe('docked')
  })

  it('keeps a pick storage would not take for this session', async () => {
    localStorage.setItem('doop:panel-layout', 'docked')
    const { getPanelLayout, setPanelLayout } = await import('../src/lib/panelLayout')
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      setPanelLayout('floating')
      /* the write really failed: storage still holds the old pick */
      expect(localStorage.getItem('doop:panel-layout')).toBe('docked')
      expect(getPanelLayout()).toBe('floating')
    } finally {
      setItem.mockRestore()
    }
  })
})
