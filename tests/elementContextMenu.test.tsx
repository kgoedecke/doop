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
    expect(items.find((item) => item.textContent?.startsWith('Delete element'))?.getAttribute('aria-disabled')).toBe(
      'true',
    )
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
