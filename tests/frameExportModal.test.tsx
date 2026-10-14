// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { FrameContextMenu } from '../src/components/FrameContextMenu'
import { ContextMenu, ContextMenuTrigger } from '../src/components/ui/context-menu'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'export-frame',
  canvasId: 'canvas',
  name: 'Poster',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function openFrameMenu(): Promise<Element> {
  await act(async () => {
    root.render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button>Frame</button>
        </ContextMenuTrigger>
        <FrameContextMenu frame={frame} at={{ current: { x: 0, y: 0 } }} />
      </ContextMenu>,
    )
  })
  await act(async () => {
    container
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  return document.querySelector('[role="menu"]')!
}

async function openExportDialog(): Promise<Element> {
  const menu = await openFrameMenu()
  const exportItem = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === 'Export…',
  )!
  await act(async () => {
    exportItem.click()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return document.querySelector('[role="dialog"]')!
}

it('keeps Copy image URL in the frame menu, not the export dialog', async () => {
  const menu = await openFrameMenu()
  expect(menu.textContent).toContain('Copy image URL')
  expect(menu.textContent).toContain('Export…')
  expect(menu.textContent).not.toContain('Download PNG')
})

it('hands focus from the frame menu to a persistent export dialog and dismisses with Escape', async () => {
  const dialog = await openExportDialog()

  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(dialog.textContent).toContain('Export “Poster”')
  expect(dialog.contains(document.activeElement)).toBe(true)
  expect(dialog.textContent).toContain('Download PNG')
  expect(dialog.textContent).toContain('Download JPG')
  expect(dialog.textContent).not.toMatch(/PSD|Canva|Figma/)
  expect(dialog.textContent).not.toContain('Copy image URL')
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.style.pointerEvents).not.toBe('none')
})
