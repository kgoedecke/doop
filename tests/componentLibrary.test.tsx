// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  registryDirectory: vi.fn(),
  previewRegistry: vi.fn(),
  importRegistry: vi.fn(),
  setComponentLocal: vi.fn(),
  setLayersTab: vi.fn(),
  state: { canvas: { tokens: [] as unknown[] } },
}))
vi.mock('../src/lib/api', () => ({ api: mocks, ApiError: class extends Error {} }))
vi.mock('../src/lib/store', () => {
  const useStore = (select: (state: typeof mocks.state) => unknown) => select(mocks.state)
  useStore.getState = () => mocks
  return { useStore }
})
import { ComponentLibrary } from '../src/components/ComponentLibrary'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const done = vi.fn()
const source = 'https://magicui.design/r/registry'
const item = (name: string) => ({ name, title: name, description: '', type: 'registry:ui', source })

async function mount(initialInput = '') {
  root = createRoot(container)
  await act(async () =>
    root.render(<ComponentLibrary canvasId="c1" initialInput={initialInput} onClose={() => {}} onDone={done} />),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.canvas.tokens = []
  mocks.registryDirectory.mockResolvedValue([
    { namespace: '@shadcn', homepage: 'https://ui.shadcn.com', description: 'Official', featured: true },
    { namespace: '@magicui', homepage: 'https://magicui.design', description: 'Animated', featured: true },
  ])
  mocks.previewRegistry.mockResolvedValue({
    name: 'magicui',
    namespace: '@magicui',
    items: [item('marquee'), item('globe')],
  })
  mocks.importRegistry.mockResolvedValue({
    components: [{ id: 'marquee1', mainFrameId: 'main1' }],
    failures: [],
    themed: [],
  })
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const buttonNamed = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.includes(text))!
const click = (element: HTMLElement) => act(async () => element.click())

it('browses the directory and adds the picked components from a registry', async () => {
  await mount()
  expect(document.body.textContent).toContain('@magicui')
  await click(buttonNamed('@magicui'))
  expect(mocks.previewRegistry).toHaveBeenCalledWith('c1', '@magicui')
  await click(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  await click(buttonNamed('Add 1 component'))
  expect(mocks.importRegistry).toHaveBeenCalledWith('c1', [{ source, name: 'marquee' }], false)
  expect(mocks.setComponentLocal).toHaveBeenCalledWith('marquee1', { id: 'marquee1', mainFrameId: 'main1' })
  expect(mocks.setLayersTab).toHaveBeenCalledWith('components')
  expect(done).toHaveBeenCalledWith(['main1'], '1 component added')
})

it('looks up a pasted install command at once and preselects a single item', async () => {
  mocks.previewRegistry.mockResolvedValue({ name: 'marquee', items: [item('marquee')] })
  await mount('npx shadcn@latest add @magicui/marquee')
  expect(mocks.previewRegistry).toHaveBeenCalledWith('c1', 'npx shadcn@latest add @magicui/marquee')
  expect(buttonNamed('Add 1 component').disabled).toBe(false)
})

it('themes with the canvas tokens unless switched off, and says so', async () => {
  mocks.state.canvas.tokens = [{ name: '--color-brand', type: 'color', value: 'red' }]
  mocks.importRegistry.mockResolvedValue({
    components: [{ id: 'marquee1', mainFrameId: 'main1' }],
    failures: [{ name: 'globe', error: 'no' }],
    themed: [{ variable: '--primary', token: '--color-brand' }],
  })
  await mount('@magicui')
  for (const box of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await click(box)
  await click(buttonNamed('Add 2 components'))
  expect(mocks.importRegistry).toHaveBeenCalledWith(
    'c1',
    [
      { source, name: 'marquee' },
      { source, name: 'globe' },
    ],
    true,
  )
  expect(done).toHaveBeenCalledWith(['main1'], '1 component added · themed with 1 canvas token · 1 could not render')
})

it('keeps the selection for a retry when adding fails', async () => {
  mocks.importRegistry.mockRejectedValueOnce(new Error('Dependency unavailable'))
  await mount('@magicui')
  await click(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  await click(buttonNamed('Add 1 component'))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Dependency unavailable')
  await click(buttonNamed('Add 1 component'))
  expect(done).toHaveBeenCalledOnce()
})
