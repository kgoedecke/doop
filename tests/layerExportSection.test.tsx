// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { LayerExportSection } from '../src/components/LayerExportSection'
import { setExportSettings } from '../src/lib/exportSettings'
import { copyElementPng, downloadElementExport } from '../src/lib/frameExport'
import { posthog } from '../src/lib/posthog'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/frameExport')>()),
  downloadElementExport: vi.fn(async () => {}),
  copyElementPng: vi.fn(async () => {}),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'layer-frame',
  canvasId: 'canvas',
  name: 'Landing',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  html: '<!doctype html><html><body><div class="card">Hi</div></body></html>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
const target = { selector: 'body > div:nth-of-type(1)', name: 'Pricing card' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  setExportSettings({ scale: 3, format: 'jpg' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<LayerExportSection frame={frame} target={target} />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  if (!found) throw new Error(`no button "${name}"`)
  return found
}

it('heads the section Export and names the layer on its button', () => {
  expect(container.querySelector('h3')?.textContent).toBe('Export')
  expect(button('Export Pricing card')).toBeTruthy()
})

it('downloads the layer at the shared scale and format', () => {
  act(() => button('Export Pricing card').click())
  expect(downloadElementExport).toHaveBeenCalledWith(frame, target, 'jpg', 3)
  expect(posthog.capture).toHaveBeenCalledWith('frames_exported', {
    destination: 'jpg',
    frame_count: 1,
    source: 'element_panel',
    target: 'element',
  })
})

it('copies the layer as a PNG at the shared scale', () => {
  act(() => button('Copy as PNG').click())
  expect(copyElementPng).toHaveBeenCalledWith(frame, target, 3)
  expect(posthog.capture).toHaveBeenCalledWith('png_copied', { target: 'element', source: 'element_panel' })
})

it('exports the layer as PNG while the frame format is PDF, which a layer has none of', () => {
  act(() => setExportSettings({ scale: 2, format: 'pdf' }))
  act(() => button('Export Pricing card').click())
  expect(downloadElementExport).toHaveBeenCalledWith(frame, target, 'png', 2)
})
