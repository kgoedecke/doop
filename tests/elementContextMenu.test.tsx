// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { ElementContextMenu } from '../src/components/ElementContextMenu'
import { ContextMenu, ContextMenuTrigger } from '../src/components/ui/context-menu'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.restoreAllMocks())

it('does not parse frame HTML for closed menus, including after a frame update', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
  const frame = { id: 'f', canvasId: 'c', html: '<div id="layer">Layer</div>' } as Frame
  function render(html: string) {
    root.render(
      <>
        {Array.from({ length: 100 }, (_, i) => (
          <ContextMenu key={i}>
            <ContextMenuTrigger asChild>
              <div data-layer={i}>Layer</div>
            </ContextMenuTrigger>
            <ElementContextMenu frame={{ ...frame, html }} selector="#layer" />
          </ContextMenu>
        ))}
      </>,
    )
  }
  try {
    act(() => render(frame.html))
    act(() => render('<div id="layer" data-doop-locked>Updated</div>'))
    expect(parse).not.toHaveBeenCalled()
    await act(async () => {
      container
        .querySelector('[data-layer="0"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    expect(parse.mock.calls.length).toBeGreaterThan(0)
    expect(parse.mock.calls.length).toBeLessThanOrEqual(3)
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    expect(items.some((item) => item.textContent?.startsWith('Unlock'))).toBe(true)
    /* an element exports on its own, as a frame does */
    for (const label of ['Export…', 'Copy as PNG']) {
      expect(items.some((item) => item.textContent === label)).toBe(true)
    }
    expect(items.find((item) => item.textContent?.startsWith('Delete element'))?.getAttribute('aria-disabled')).toBe(
      'true',
    )
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('pastes a copied standalone shape as a new element on the canvas', async () => {
  const { copyFrames } = await import('../src/lib/frameClipboard')
  const { useStore } = await import('../src/lib/store')
  const { api } = await import('../src/lib/api')
  const shape = {
    id: 's',
    canvasId: 'c',
    name: 'Rectangle',
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    html: '<body data-doop-canvas-element><div id="layer" data-doop-drawing="rect"></div></body>',
  } as Frame
  useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [shape], createdAt: 0, updatedAt: 0 })
  const create = vi.spyOn(api, 'createFrame').mockResolvedValue({ ...shape, id: 'new' })
  copyFrames([shape])
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    act(() =>
      root.render(
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div data-layer="0">Layer</div>
          </ContextMenuTrigger>
          <ElementContextMenu frame={shape} selector="#layer" />
        </ContextMenu>,
      ),
    )
    await act(async () => {
      container
        .querySelector('[data-layer="0"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    const paste = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith('Paste'),
    )!
    expect(paste.getAttribute('aria-disabled')).toBeNull()
    await act(async () => paste.click())
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![1]).toMatchObject({ name: 'Rectangle', html: shape.html, width: 100, height: 50 })
  } finally {
    await act(async () => root.unmount())
    container.remove()
    localStorage.clear()
  }
})

it('opens the export dialog for the element, which outlives the menu', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const frame = {
    id: 'f',
    canvasId: 'c',
    name: 'Poster',
    width: 100,
    height: 100,
    html: '<body><div id="layer">Layer</div></body>',
  } as Frame
  try {
    await act(async () =>
      root.render(
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div data-layer>Layer</div>
          </ContextMenuTrigger>
          <ElementContextMenu frame={frame} selector="#layer" />
        </ContextMenu>,
      ),
    )
    await act(async () => {
      container
        .querySelector('[data-layer]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    const exportItem = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === 'Export…',
    )
    await act(async () => {
      exportItem!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      exportItem!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      ;(exportItem as HTMLElement).click()
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Export “Layer”')
    expect(dialog.textContent).toContain('Download PNG')
    /* an element is no PDF page */
    expect(dialog.textContent).not.toContain('PDF')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
