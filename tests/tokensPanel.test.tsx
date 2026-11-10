// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas } from '../shared/types'
import type { DesignToken } from '../shared/designTokens'

const setToken = vi.fn(() => Promise.resolve({ result: { name: '--color-ink', result: 'updated' }, tokens: [] }))
const createTokens = vi.fn(() => Promise.resolve({ results: [{ name: '--x', result: 'created' }], tokens: [] }))
const setTokenThemes = vi.fn(() => Promise.resolve({ themes: ['dark'], tokens: [] }))
const updateFrame = vi.fn(() => Promise.resolve())

vi.mock('../src/lib/api', () => ({
  api: {
    updateFrame: (...args: unknown[]) => updateFrame(...(args as [])),
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
    [...document.querySelectorAll<HTMLElement>('label, [data-row-label]')]
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
    /* and the page's frames wear it: the design switches, one save per frame */
    expect(useStore.getState().canvas?.frames[0]?.html).toContain('data-doop-theme="dark"')
    expect(updateFrame).toHaveBeenCalledWith('f1', { html: expect.stringContaining('data-doop-theme="dark"') })
    expect(text()).toContain('#eee')
    expect(container.querySelector<HTMLElement>('[style*="background"]')?.style.background).toBe('#eee')
    /* a token without a dark value shows its default, marked as inherited */
    expect(container.querySelector('[title="same as default"]')?.textContent).toBe(
      '16px',
    ) /* the tick follows the frames: an undo elsewhere puts them back on the default */
    act(() => {
      const frame = useStore.getState().canvas!.frames[0]!
      useStore.getState().patchFrameLocal(frame.id, { html: frame.html.replace(' data-doop-theme="dark"', '') })
    })
    expect(themeRow('default').getAttribute('aria-checked')).toBe('true')
  })

  it('browses the themes through a local pick when the frames cannot be switched', () => {
    /* a canvas with no frames on the page: nothing to switch, the rows still follow the pick */
    act(() => useStore.getState().setCanvas({ ...useStore.getState().canvas!, frames: [] }))
    pickTheme('dark')
    expect(themeRow('dark').getAttribute('aria-checked')).toBe('true')
    expect(text()).toContain('#eee')
    expect(updateFrame).not.toHaveBeenCalledWith('f1', expect.anything())
  })

  it('opens a token with a row per theme, resets a theme, and saves only what changed', async () => {
    act(() => button('color-ink').click())
    expect(document.body.textContent).toContain('Edit Color token')
    /* a row per theme: the default first, then dark with its own value */
    expect(input('A CSS value, or var(--other) to alias a token').value).toBe('#111')
    expect([...document.querySelectorAll('[data-theme-label]')].map((el) => el.textContent)).toEqual([
      'default',
      'dark',
    ])
    expect(input('same as default').value).toBe('#eee')
    act(() => button('Back to the default value').click())
    expect(input('same as default').value).toBe('')
    type(document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, 'color-text')
    await act(async () => {
      button('Save').click()
      await Promise.resolve()
    })
    /* only what changed: the rename and the cleared theme value */
    expect(setToken).toHaveBeenCalledWith('c1', '--color-ink', { newName: '--color-text', themes: { dark: null } })
  })

  it('keeps a value a teammate changed while the modal was open', async () => {
    act(() => button('color-ink').click())
    /* the teammate's edit lands in the store while the person is still typing */
    act(() => {
      const canvas = useStore.getState().canvas!
      useStore.getState().setCanvas({
        ...canvas,
        tokens: canvas.tokens!.map((d) => (d.name === '--color-ink' ? { ...d, value: '#222' } : d)),
      })
    })
    type(input('When to reach for it'), 'body text')
    await act(async () => {
      button('Save').click()
      await Promise.resolve()
    })
    /* only the description: the stale draft value is not sent back */
    expect(setToken).toHaveBeenCalledWith('c1', '--color-ink', { description: 'body text' })
  })

  it('does not render again for a cursor move', () => {
    let commits = 0
    act(() => root.unmount())
    root = createRoot(container)
    act(() =>
      root.render(
        <TooltipProvider>
          <Profiler id="tokens" onRender={() => commits++}>
            <TokensSection />
          </Profiler>
        </TooltipProvider>,
      ),
    )
    const mounted = commits
    act(() => useStore.getState().setCursor('peer', 10, 20))
    act(() => useStore.getState().setCursor('peer', 11, 21))
    expect(commits).toBe(mounted)
  })

  it('creates a token of the type picked from the plus menu, named after it', async () => {
    /* Radix opens a menu on pointerdown, not click */
    act(() => {
      button('New token').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
      )
    })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === 'Radius',
    )
    expect(item).toBeTruthy()
    act(() => item!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
    act(() => item!.click())
    expect(document.body.textContent).toContain('New Radius token')
    /* the next free stem-N name and the type's default value are prefilled */
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value).toBe('radius-1')
    expect(input('A CSS value, or var(--other) to alias a token').value).toBe('8')
    await act(async () => {
      button('Save').click()
      await Promise.resolve()
    })
    expect(createTokens).toHaveBeenCalledWith('c1', [
      { name: '--radius-1', type: 'radius', value: '8px', description: undefined, themes: {} },
    ])
  })

  it('adds a theme from the plus, and renames or deletes one from its context menu', async () => {
    await act(async () => {
      button('Add a theme').click()
      await Promise.resolve()
    })
    expect(setTokenThemes).toHaveBeenCalledWith('c1', ['dark', 'theme-1'], [])
    const menuItem = (label: string) => {
      const el = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (e) => e.textContent?.trim() === label,
      )
      if (!el) throw new Error(`no menu item “${label}”`)
      act(() => el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
      act(() => el.click())
    }
    const rightClick = (label: string) =>
      act(() => {
        themeRow(label).dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 10, clientY: 10 }),
        )
      })
    /* a double click on the name opens the rename too */
    act(() => themeRow('dark').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(document.querySelector('input[aria-label="Rename dark"]')).toBeTruthy()
    act(() => {
      document
        .querySelector<HTMLInputElement>('input[aria-label="Rename dark"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('input[aria-label="Rename dark"]')).toBeNull()
    rightClick('dark')
    menuItem('Rename')
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Rename dark"]')!
    type(field, 'Night')
    /* Enter commits (a blur right after opening is the menu's focus hand-back, not a commit) */
    await act(async () => {
      field.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(setTokenThemes).toHaveBeenCalledWith('c1', ['night'], [{ from: 'dark', to: 'night' }])
    rightClick('dark')
    menuItem('Delete theme')
    await act(async () => {
      await Promise.resolve()
    })
    expect(setTokenThemes).toHaveBeenCalledWith('c1', [], [])
  })
})
