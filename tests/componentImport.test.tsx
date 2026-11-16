// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentLibrary } from '../src/lib/api'

const mocks = vi.hoisted(() => ({
  importComponent: vi.fn(),
  componentPreview: vi.fn(),
  notices: [] as string[],
  components: [] as { id: string; status?: 'deleted' }[],
}))
vi.mock('../src/lib/api', () => ({
  api: { importComponent: mocks.importComponent, componentPreview: mocks.componentPreview },
}))
vi.mock('../src/lib/store', () => {
  const state = {
    get canvas() {
      return { id: 'here', components: mocks.components }
    },
    pushNotice: (text: string) => mocks.notices.push(text),
  }
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state })
  return { useStore }
})
import { ImportCanvasList, ImportComponentsModal } from '../src/components/ComponentImport'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* Importing from another canvas: the panel lists canvases like Home, with a way
   back, and a canvas opens a modal to pick its components. */

let root: Root
let container: HTMLDivElement
const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
const entry = (id: string, name: string) => ({ id, name, signature: `${id}:1`, instances: 0 })

const landing: ComponentLibrary = {
  id: 'landing',
  name: 'UI v2 landing',
  updatedAt: Date.now() - 3_600_000,
  previewFrameId: 'f1',
  components: [entry('cover', 'Blog Cover'), entry('canva', 'Tile Canva'), entry('claude', 'Tile Claude Code')],
}
const empty: ComponentLibrary = { id: 'posts', name: 'X Posts', updatedAt: Date.now(), components: [] }

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocks.notices.length = 0
  mocks.components = []
  mocks.importComponent.mockReset().mockResolvedValue({})
  mocks.componentPreview.mockReset().mockReturnValue(new Promise(() => {}))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

it('lists canvases one per row, greys one with no components, and goes back', () => {
  const onBack = vi.fn()
  const onPick = vi.fn()
  act(() => root.render(<ImportCanvasList sources={[landing, empty]} onBack={onBack} onPick={onPick} />))

  const tiles = document.querySelectorAll<HTMLButtonElement>('[data-import-canvas]')
  expect([...tiles].map((tile) => tile.dataset.importCanvas)).toEqual(['UI v2 landing', 'X Posts'])
  expect(tiles[0]!.textContent).toContain('3')
  expect(tiles[1]!.disabled).toBe(true)
  expect(tiles[1]!.textContent).toContain('No components')

  act(() => tiles[0]!.click())
  expect(onPick).toHaveBeenCalledWith(landing)
  act(() => button('Components')!.click())
  expect(onBack).toHaveBeenCalled()
})

it('filters canvases by name', () => {
  act(() => root.render(<ImportCanvasList sources={[landing, empty]} onBack={() => {}} onPick={() => {}} />))
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search canvases"]')!
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(search, 'posts')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const names = [...document.querySelectorAll<HTMLElement>('[data-import-canvas]')].map((t) => t.dataset.importCanvas)
  expect(names).toEqual(['X Posts'])
})

it('imports the picked components, skipping the ones already here', async () => {
  mocks.components = [{ id: 'claude' }]
  const onDone = vi.fn()
  act(() => root.render(<ImportComponentsModal canvasId="here" source={landing} onBack={() => {}} onDone={onDone} />))
  /* the one already here has no checkbox and says so */
  const cell = (name: string) => document.querySelector(`[data-import-component="${name}"]`)!
  expect(cell('Tile Claude Code').querySelector('input')).toBeNull()
  expect(cell('Tile Claude Code').textContent).toContain('Already on this canvas')

  act(() => button('Select all')!.click())
  expect(button('Import 2 components')).toBeDefined()
  await act(async () => button('Import 2 components')!.click())

  expect(mocks.importComponent.mock.calls).toEqual([
    ['here', 'landing', 'cover'],
    ['here', 'landing', 'canva'],
  ])
  expect(mocks.notices).toEqual(['2 components imported'])
  expect(onDone).toHaveBeenCalled()
})

it('keeps the modal open and says why when an import fails', async () => {
  mocks.importComponent.mockRejectedValue(new Error('no component “Blog Cover” on canvas landing'))
  const onDone = vi.fn()
  act(() => root.render(<ImportComponentsModal canvasId="here" source={landing} onBack={() => {}} onDone={onDone} />))
  act(() => document.querySelector<HTMLInputElement>('[data-import-component="Blog Cover"] input')!.click())
  await act(async () => button('Import 1 component')!.click())
  expect(mocks.notices).toEqual(['no component “Blog Cover” on canvas landing'])
  expect(onDone).not.toHaveBeenCalled()
  expect(button('Import 1 component')).toBeDefined()
})

it('closing goes back to the canvas list', () => {
  const onBack = vi.fn()
  act(() => root.render(<ImportComponentsModal canvasId="here" source={landing} onBack={onBack} onDone={() => {}} />))
  act(() => button('Back to canvases')!.click())
  expect(onBack).toHaveBeenCalled()
})

it('cannot be closed while an import runs', async () => {
  let finish = () => {}
  mocks.importComponent.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
  const onBack = vi.fn()
  act(() => root.render(<ImportComponentsModal canvasId="here" source={landing} onBack={onBack} onDone={() => {}} />))
  act(() => document.querySelector<HTMLInputElement>('[data-import-component="Blog Cover"] input')!.click())
  act(() => button('Import 1 component')!.click())
  expect(button('Importing…')).toBeDefined()
  expect(document.querySelector('[aria-label="Close"]')).toBeNull()
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(onBack).not.toHaveBeenCalled()
  await act(async () => finish())
})

it('stops counting a picked component once it has arrived', () => {
  act(() => root.render(<ImportComponentsModal canvasId="here" source={landing} onBack={() => {}} onDone={() => {}} />))
  act(() => document.querySelector<HTMLInputElement>('[data-import-component="Blog Cover"] input')!.click())
  expect(button('Import 1 component')).toBeDefined()
  /* it lands here (an earlier, partly failed run brought it), still ticked */
  mocks.components = [{ id: 'cover' }]
  act(() => root.render(<ImportComponentsModal canvasId="here" source={landing} onBack={() => {}} onDone={() => {}} />))
  expect(button('Import')!.disabled).toBe(true)
  expect(document.body.textContent).not.toContain('1 selected')
})
