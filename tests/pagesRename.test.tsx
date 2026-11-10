// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, CanvasPageInfo } from '../shared/types'

/* resolves like the real one: the store holds the saved list afterwards */
const savePages = vi.fn((canvas: Canvas, next: CanvasPageInfo[]) => {
  useStore.getState().setPages(next, canvas.id)
  return Promise.resolve()
})
vi.mock('../src/lib/pageEdits', () => ({
  savePages: (canvas: Canvas, next: CanvasPageInfo[]) => savePages(canvas, next),
  duplicatePage: () => Promise.resolve(),
  moveFramesToPage: () => Promise.resolve(),
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { PagesPanel } = await import('../src/components/PagesPanel')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const pageButton = (name: string) => {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent === name)
  if (!el) throw new Error(`page ${name} not rendered`)
  return el
}
const field = () => container.querySelector<HTMLInputElement>('input[maxlength="100"]')

function startRenaming(name: string) {
  act(() => {
    pageButton(name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
}

function type(value: string) {
  const input = field()!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function blur() {
  await act(async () => {
    field()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await Promise.resolve()
  })
}

const names = () => (useStore.getState().canvas?.pages ?? []).map((p) => p.name)

/* happy-dom has no layout: the row under the pointer is the one the test names */
function dragPage(from: string, onto: string, after: boolean) {
  const target = container.querySelector<HTMLElement>(`[data-page-id="${onto}"]`)!
  document.elementFromPoint = () => target
  target.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, height: 28 }) as DOMRect
  const y = after ? 26 : 2
  act(() => {
    pageButton(from).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
    )
  })
  return {
    drop: () =>
      act(() => {
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: y }))
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: y }))
      }),
  }
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })

describe('PagesPanel rename', () => {
  beforeEach(() => {
    savePages.mockClear()
    useStore.getState().setCanvas({
      id: 'c1',
      name: 'Canvas',
      frames: [],
      pages: [
        { id: 'p1', name: 'Adjust' },
        { id: 'p2', name: 'Purchasing' },
      ],
    } as unknown as Canvas)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<PagesPanel />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('keeps the typed name and closes the field when focus leaves it', async () => {
    startRenaming('Adjust')
    type('Breakdown')
    await blur()
    expect(savePages).toHaveBeenCalledTimes(1)
    expect(savePages.mock.calls[0]?.[1].map((p) => p.name)).toEqual(['Breakdown', 'Purchasing'])
    expect(field()).toBeNull()
  })

  it('closes without saving when the name is unchanged', async () => {
    startRenaming('Adjust')
    await blur()
    expect(savePages).not.toHaveBeenCalled()
    expect(field()).toBeNull()
  })

  it('discards the typed name on Escape, even when a blur follows', async () => {
    startRenaming('Adjust')
    type('Breakdown')
    const input = field()!
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })
    expect(savePages).not.toHaveBeenCalled()
    expect(field()).toBeNull()
  })

  it('saves once when Enter is followed by a blur', async () => {
    startRenaming('Adjust')
    type('Breakdown')
    const input = field()!
    await act(async () => {
      input.form!.requestSubmit()
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })
    expect(savePages).toHaveBeenCalledTimes(1)
  })

  it('keeps the field open after a failed save, and saves the retry once', async () => {
    let fail!: (error: Error) => void
    savePages.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (fail = reject)))
    startRenaming('Adjust')
    type('Breakdown')
    await blur()
    /* a second blur while the first save is in flight sends nothing */
    await blur()
    expect(savePages).toHaveBeenCalledTimes(1)
    await act(async () => {
      fail(new Error('offline'))
    })
    await settle()
    expect(field()?.value).toBe('Breakdown')
    expect(field()?.disabled).toBe(false)

    await blur()
    await settle()
    expect(savePages).toHaveBeenCalledTimes(2)
    expect(names()).toEqual(['Breakdown', 'Purchasing'])
    expect(field()).toBeNull()
  })

  it('keeps a rename committed by the press that starts a page drag', async () => {
    startRenaming('Adjust')
    type('Breakdown')
    /* the press lands before the field loses focus */
    const drag = dragPage('Purchasing', 'p1', false)
    await blur()
    drag.drop()
    await settle()
    expect(savePages).toHaveBeenCalledTimes(2)
    expect(names()).toEqual(['Purchasing', 'Breakdown'])
  })
})
