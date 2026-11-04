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

  it('lists tokens by type, colours first, with the themes line', () => {
    expect(text().indexOf('color-ink')).toBeLessThan(text().indexOf('spacing-4'))
    expect(text()).toContain('Themesdefault, dark')
    expect(container.querySelector<HTMLElement>('[style*="background"]')?.style.background).toBe('#111')
  })

  it('opens a token, shows its theme value and use count, and saves a rename with themes', async () => {
    act(() => button('color-ink').click())
    expect(document.body.textContent).toContain('used in 1 frame')
    expect(input('Value (dark)').value).toBe('#eee')
    type(input('color-primary'), 'color-text')
    type(input('Value (dark)'), '')
    await act(async () => {
      button('Save').click()
      await Promise.resolve()
    })
    expect(setToken).toHaveBeenCalledWith('c1', '--color-ink', {
      newName: '--color-text',
      type: 'color',
      value: '#111',
      description: 'text',
      themes: { dark: null },
    })
  })

  it('creates a token from the type menu', async () => {
    /* Radix opens a menu on pointerdown, not click */
    act(() => {
      button('New token').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
      )
    })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Radius'),
    )
    expect(item).toBeTruthy()
    act(() => item!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
    act(() => item!.click())
    expect(document.body.textContent).toContain('New Radius token')
    type(input('color-primary'), 'radius-md')
    /* a radius is a number with its unit, px by default */
    type(input('A CSS value, or var(--other) to alias a token'), '8')
    await act(async () => {
      button('Save').click()
      await Promise.resolve()
    })
    expect(createTokens).toHaveBeenCalledWith('c1', [
      { name: '--radius-md', type: 'radius', value: '8px', description: undefined, themes: {} },
    ])
  })

  it('adds and removes themes from the dropdown', async () => {
    act(() => button('Themes').click())
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
    act(() => button('Themes').click())
    expect(document.body.textContent).toContain('default')
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
