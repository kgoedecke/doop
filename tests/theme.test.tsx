// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getTheme, setTheme, toggleDarkMode, THEME_STORAGE_KEY, useTheme } from '../src/lib/theme'
import { Switch, SwitchCard, SwitchRow } from '../src/components/ui/switch'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Theme management', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.style.colorScheme = ''
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.style.colorScheme = ''
  })

  it('defaults to system theme when no preference is saved', () => {
    expect(getTheme()).toBe('system')
  })

  it('sets and persists theme in localStorage and documentElement', () => {
    setTheme('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')

    setTheme('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('toggles dark mode between light and dark', () => {
    setTheme('light')
    toggleDarkMode()
    expect(getTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    toggleDarkMode()
    expect(getTheme()).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('reactively updates in useTheme hook', async () => {
    let captured: ReturnType<typeof useTheme> | null = null

    function TestComponent() {
      const state = useTheme()
      captured = state
      return <div>Active: {state.theme}</div>
    }

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<TestComponent />)
    })

    expect(captured).not.toBeNull()

    await act(async () => {
      setTheme('dark')
    })

    expect(captured!.theme).toBe('dark')
    expect(captured!.isDark).toBe(true)
    expect(container.textContent).toContain('Active: dark')

    await act(async () => {
      captured!.toggleDarkMode()
    })

    expect(captured!.theme).toBe('light')
    expect(captured!.isDark).toBe(false)

    act(() => {
      root.unmount()
    })
    container.remove()
  })
})

describe('Switch component', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('renders with role="switch" and handles clicks', async () => {
    let state = false

    await act(async () => {
      root.render(
        <Switch
          checked={state}
          onCheckedChange={(next) => {
            state = next
          }}
        />,
      )
    })

    const switchBtn = container.querySelector<HTMLButtonElement>('button[role="switch"]')!
    expect(switchBtn).toBeDefined()
    expect(switchBtn.getAttribute('aria-checked')).toBe('false')
    expect(switchBtn.getAttribute('data-state')).toBe('unchecked')

    await act(async () => {
      switchBtn.click()
    })

    expect(state).toBe(true)
  })

  it('renders SwitchCard and toggles on card click', async () => {
    let state = false

    await act(async () => {
      root.render(
        <SwitchCard
          title="Dark mode"
          description="Test description"
          checked={state}
          onChange={(next) => {
            state = next
          }}
        />,
      )
    })

    const card = container.querySelector<HTMLDivElement>('[role="button"]')!
    expect(card).toBeDefined()
    expect(container.textContent).toContain('Dark mode')
    expect(container.textContent).toContain('Test description')

    await act(async () => {
      card.click()
    })

    expect(state).toBe(true)
  })

  it('renders SwitchRow with label and description', async () => {
    let state = false

    await act(async () => {
      root.render(
        <SwitchRow
          label="Appearance setting"
          description="Detailed copy"
          checked={state}
          onCheckedChange={(next) => {
            state = next
          }}
        />,
      )
    })

    expect(container.textContent).toContain('Appearance setting')
    expect(container.textContent).toContain('Detailed copy')
    const switchBtn = container.querySelector<HTMLButtonElement>('button[role="switch"]')!
    expect(switchBtn).toBeDefined()

    await act(async () => {
      switchBtn.click()
    })

    expect(state).toBe(true)
  })
})
