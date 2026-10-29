// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { MAX_PDF_FRAMES } from '../shared/pdfLimits'
import { ExportModal } from '../src/components/ExportModal'
import { downloadFramesPdf } from '../src/lib/frameExport'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameExport', () => ({ downloadFramesPdf: vi.fn(async () => {}) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base: Frame = {
  id: 'a',
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
const onClose = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function open(frames: Frame[]): Promise<Element> {
  await act(async () => {
    root.render(<ExportModal frames={frames} initialSelection={[]} onClose={onClose} />)
  })
  return document.querySelector('[role="dialog"]')!
}

function checkboxes(dialog: Element): HTMLInputElement[] {
  return Array.from(dialog.querySelectorAll<HTMLInputElement>('[aria-label="Frames to export"] input[type="checkbox"]'))
}

async function click(el: Element | undefined) {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

it('holds a PDF over the frame limit on the checklist until enough frames are unchecked', async () => {
  const many = Array.from({ length: MAX_PDF_FRAMES + 2 }, (_, i) => ({
    ...base,
    id: `f${i}`,
    name: `F${i}`,
    x: i * 200,
  }))
  const dialog = await open(many)
  const action = () =>
    Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Download PDF'))!
  expect(action().disabled).toBe(true)
  expect(dialog.textContent).toContain(`A PDF holds at most ${MAX_PDF_FRAMES} frames. Uncheck 2 frames to download.`)
  await click(checkboxes(dialog)[0])
  expect(dialog.textContent).toContain('Uncheck 1 frame to download.')
  await click(checkboxes(dialog)[1])
  expect(action().disabled).toBe(false)
  await click(action())
  expect(vi.mocked(downloadFramesPdf).mock.calls[0]?.[1]).toHaveLength(MAX_PDF_FRAMES)
  expect(onClose).toHaveBeenCalledOnce()
})
