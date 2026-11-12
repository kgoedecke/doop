// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  previewRegistry: vi.fn(),
  importRegistry: vi.fn(),
  setComponentLocal: vi.fn(),
  setLayersTab: vi.fn(),
}))
vi.mock('../src/lib/api', () => ({ api: mocks, ApiError: class extends Error {} }))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => mocks } }))
import { Root as Dialog } from '@radix-ui/react-dialog'
import { RegistryImportSection } from '../src/components/RegistryImportSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const done = vi.fn()
const back = vi.fn()
const url = 'https://example.com/r/registry.json'
const item = (name: string) => ({ name, title: name, description: '', type: 'registry:ui' })

function Harness() {
  const [busy, setBusy] = useState<'discovering' | 'importing' | null>(null)
  return (
    <Dialog open>
      <RegistryImportSection canvasId="c1" busy={busy} onBusy={setBusy} onDone={done} onBack={back} />
    </Dialog>
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.importRegistry.mockResolvedValue({ components: [{ id: 'button1', mainFrameId: 'main1' }], failures: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Harness />))
  await act(async () => {
    const input = container.querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, url)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((element) => element.textContent === text)!
const click = (element: HTMLElement) => act(async () => element.click())

it('reviews a registry before importing only the selected items', async () => {
  mocks.previewRegistry.mockResolvedValue({ url, name: 'Acme', items: [item('button'), item('card')] })
  await click(button('Review registry'))
  expect(mocks.previewRegistry).toHaveBeenCalledWith('c1', url)
  expect(mocks.importRegistry).not.toHaveBeenCalled()
  expect(button('Import 0 items').disabled).toBe(true)
  await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  await click(button('Import 1 item'))
  expect(mocks.importRegistry).toHaveBeenCalledWith('c1', url, ['button'])
  expect(done).toHaveBeenCalledWith(['main1'], 0)
  expect(mocks.setLayersTab).toHaveBeenCalledWith('components')
  expect(mocks.setComponentLocal).toHaveBeenCalledWith('button1', { id: 'button1', mainFrameId: 'main1' })
})

it('preselects a single registry item and lets people return to edit its URL', async () => {
  mocks.previewRegistry.mockResolvedValue({ url, name: 'button', items: [item('button')] })
  await click(button('Review registry'))
  expect(button('Import 1 item').disabled).toBe(false)
  await click(button('Back'))
  expect(container.querySelector<HTMLInputElement>('#registry-url')?.value).toBe(url)
  expect(back).not.toHaveBeenCalled()
  await click(button('Back'))
  expect(back).toHaveBeenCalledOnce()
})

it('keeps the selection available for retry when an import fails', async () => {
  mocks.previewRegistry.mockResolvedValue({ url, name: 'button', items: [item('button')] })
  mocks.importRegistry.mockRejectedValueOnce(new Error('Dependency unavailable'))
  await click(button('Review registry'))
  await click(button('Import 1 item'))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Dependency unavailable')
  expect(button('Import 1 item').disabled).toBe(false)
  await click(button('Import 1 item'))
  expect(done).toHaveBeenCalledWith(['main1'], 0)
  expect(mocks.setLayersTab).toHaveBeenCalledWith('components')
  expect(mocks.setComponentLocal).toHaveBeenCalledWith('button1', { id: 'button1', mainFrameId: 'main1' })
})
