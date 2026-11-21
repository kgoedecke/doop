// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { Inspector } from '../src/components/Inspector'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { setExportSettings } from '../src/lib/exportSettings'
import { isFrameExporting } from '../src/lib/frameExport'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Checkout',
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  html: '<h1>Checkout</h1>',
  createdAt: 1,
  updatedAt: 10,
  updatedBy: 'Designer',
}
let root: Root
let container: HTMLDivElement

function mount() {
  act(() =>
    root.render(
      <TooltipProvider>
        <Inspector frame={frame} />
      </TooltipProvider>,
    ),
  )
}
const exportButton = () =>
  [...container.querySelectorAll('button')].find((button) => /^Export(ing…)?$/.test(button.textContent?.trim() ?? ''))!

beforeEach(() => {
  useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [frame], createdAt: 1, updatedAt: 10 })
  setExportSettings({ scale: 1, format: 'pdf' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mount()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('keeps the Export button busy while a PDF renders, across a remount, until it ends', async () => {
  let fail!: (reason: unknown) => void
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((_, reject) => (fail = reject)))

  act(() => exportButton().click())
  expect(exportButton().textContent).toContain('Exporting…')
  expect(exportButton().disabled).toBe(true)
  expect(isFrameExporting('f')).toBe(true)

  /* deselecting and selecting again mounts a fresh Inspector */
  act(() => root.unmount())
  root = createRoot(container)
  mount()
  expect(exportButton().disabled).toBe(true)

  await act(async () => {
    fail(new Error('network'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(isFrameExporting('f')).toBe(false)
  expect(exportButton().textContent?.trim()).toBe('Export')
  expect(exportButton().disabled).toBe(false)
})
