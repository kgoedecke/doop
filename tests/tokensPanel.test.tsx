// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas } from '../shared/types'
import type { DesignToken } from '../shared/designTokens'

const setToken = vi.fn(() => Promise.resolve({ result: { name: '--color-ink', result: 'updated' }, tokens: [] }))
const createTokens = vi.fn(() => Promise.resolve({ results: [{ name: '--x', result: 'created' }], tokens: [] }))
const setTokenThemes = vi.fn(() => Promise.resolve({ themes: ['dark'], tokens: [] }))
vi.mock('../src/lib/api', () => ({
  api: {
    setToken: (...args: unknown[]) => setToken(...(args as [])),
    createTokens: (...args: unknown[]) => createTokens(...(args as [])),
    setTokenThemes: (...args: unknown[]) => setTokenThemes(...(args as [])),
    deleteToken: () => Promise.resolve({ ok: true, tokens: [] }),
  },
  ApiError: class extends Error {},
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { TokensSection } = await import('../src/components/TokensPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function token(name: string, type: DesignToken['type'], value: string, extra: Partial<DesignToken> = {}): DesignToken {
  return { name, type, value, order: 1, updatedAt: 0, updatedBy: 'me', ...extra }
}

let container: HTMLDivElement
let root: Root

const text = () => container.textContent ?? ''
/* modals and menus render in a portal, so buttons are looked up document-wide */
const button = (label: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.includes(label) || b.getAttribute('aria-label') === label,
  )
  if (!el) throw new Error(`no button “${label}”`)
  return el
}
const input = (placeholderOrLabel: string) => {
  const el =
    document.querySelector<HTMLInputElement>(`input[placeholder="${placeholderOrLabel}"]`) ??
    [...document.querySelectorAll<HTMLElement>('label')]
      .find((l) => l.textContent?.trim() === placeholderOrLabel)
      ?.parentElement?.querySelector<HTMLInputElement>('input:not([type="color"])')
  if (!el) throw new Error(`no input “${placeholderOrLabel}”`)
  return el
}
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('TokensSection', () => {
  beforeEach(() => {
    setToken.mockClear()
    const canvas = {
      id: 'c1',
      name: 'Canvas',
      frames: [
        {
          id: 'f1',
          canvasId: 'c1',
          name: 'Hero',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          html: '<html><body style="color:var(--color-ink)"></body></html>',
          createdAt: 1,
          updatedAt: 1,
          updatedBy: 'me',
        },
      ],
      tokens: [
        token('--spacing-4', 'spacing', '16px'),
        token('--color-ink', 'color', '#111', { themes: { dark: '#eee' }, description: 'text' }),
      ],
      tokenThemes: ['dark'],
    } as Canvas
    useStore.getState().setCanvas(canvas)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <TooltipProvider>
          <TokensSection />
        </TooltipProvider>,
      ),
    )
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  /* the theme rows under the Themes heading */
  const themeRow = (label: string) => {
    const el = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (r) => r.textContent?.trim() === label,
    )
    if (!el) throw new Error(`no theme row “${label}”`)
    return el
  }
  const pickTheme = (label: string) => act(() => themeRow(label).click())

  /* the Manage themes modal, from the Themes heading's plus */
  const openManage = () => act(() => button('Manage themes…').click())

  it('lists tokens by type, colours first, under the default theme', () => {
    expect(text().indexOf('color-ink')).toBeLessThan(text().indexOf('spacing-4'))
    expect(themeRow('default').getAttribute('aria-checked')).toBe('true')
    expect(themeRow('dark').getAttribute('aria-checked')).toBe('false')
    expect(text()).toContain('#111')
    expect(container.querySelector<HTMLElement>('[style*="background"]')?.style.background).toBe('#111')
    /* a group folds on its row and opens again */
    act(() => button('Colors').click())
    expect(text()).not.toContain('color-ink')
    act(() => button('Colors').click())
    expect(text()).toContain('color-ink')
  })

  it('shows another theme’s values when it is picked from the dropdown', () => {
    pickTheme('dark')
    expect(themeRow('dark').getAttribute('aria-checked')).toBe('true')
    expect(text()).toContain('#eee')
    expect(container.querySelector<HTMLElement>('[style*="background"]')?.style.background).toBe('#eee')
    /* a token without a dark value shows its default, marked as inherited */
    expect(container.querySelector('[title="same as default"]')?.textContent).toBe('16px')
  })

  it('creates a token from the plus button, naming it after its type', async () => {
    act(() => button('New token').click())
    expect(document.body.textContent).toContain('New Color token')
    type(input('primary'), 'brand')
    type(input('A CSS value, or var(--other) to alias a token'), '#abcdef')
    await act(async () => {
      button('Save').click()
      await Promise.resolve()
    })
    expect(createTokens).toHaveBeenCalledWith('c1', [
      { name: '--brand', type: 'color', value: '#abcdef', description: undefined, themes: {} },
    ])
  })

  it('adds and removes themes from the manage modal', async () => {
    openManage()
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Add a theme"]')!
    type(field, 'Compact')
    await act(async () => {
      button('Add a theme').click()
      await Promise.resolve()
    })
    expect(setTokenThemes).toHaveBeenCalledWith('c1', ['dark', 'compact'], [])
    await act(async () => {
      button('Remove dark').click()
      await Promise.resolve()
    })
    expect(setTokenThemes).toHaveBeenCalledWith('c1', [], [])
  })

  it('shows the default theme first and renames a theme from its row', async () => {
    openManage()
    expect(document.body.textContent).toContain('the value itself')
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Rename dark"]')!
    type(field, 'Night')
    await act(async () => {
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })
    expect(setTokenThemes).toHaveBeenCalledWith('c1', ['night'], [{ from: 'dark', to: 'night' }])
    type(field, 'default')
    await act(async () => {
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('not “default”')
  })
})
