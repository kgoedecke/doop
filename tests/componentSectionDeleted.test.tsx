// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentDef } from '../shared/components'
import type { Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({
  undeleteComponent: vi.fn(),
  changeInstances: vi.fn(),
  notices: [] as string[],
  components: [] as unknown[],
  frames: [] as unknown[],
  canEdit: true,
}))
vi.mock('../src/lib/api', () => ({
  api: { undeleteComponent: mocks.undeleteComponent, changeInstances: mocks.changeInstances },
  errorMessage: (_error: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/history', () => ({ recordCreate: () => {}, recordUpdate: () => {}, recordUpdates: () => {} }))
vi.mock('../src/lib/store', () => {
  const state = {
    get canvas() {
      return { id: 'canvas1', components: mocks.components, frames: mocks.frames }
    },
    pushNotice: (text: string) => mocks.notices.push(text),
    setComponentLocal: () => {},
    upsertFrame: () => {},
    setSelectedElement: () => {},
  }
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state })
  return { useStore, canEditOpenCanvas: () => mocks.canEdit, pickedSelectors: () => [] }
})
import { ComponentSection } from '../src/components/ComponentSection'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The Design panel on an instance whose component was deleted: it says so, and offers the
   two ways out (restore the component, detach this instance) instead of its props. */

let root: Root
let container: HTMLDivElement

const def = (over: Partial<ComponentDef> = {}): ComponentDef => ({
  id: 'cbutton',
  name: 'Button',
  description: '',
  template: '<button data-doop-part="r"><span data-doop-part="l" data-doop-prop="label">Buy</span></button>',
  css: '',
  rawCss: '',
  head: [],
  props: [{ name: 'label', type: 'text' }],
  slots: [],
  rev: 1,
  mainFrameId: 'main1',
  history: [],
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Tester',
  ...over,
})

const frame = {
  id: 'frame1',
  canvasId: 'canvas1',
  name: 'Page',
  html: '<!doctype html><html><head></head><body><button data-doop-part="r" data-doop-instance="cbutton" data-doop-rev="1" data-doop-id="inst01"><span data-doop-part="l">Buy</span></button></body></html>',
} as unknown as Frame

const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)

function render() {
  act(() => root.render(<ComponentSection frame={frame} selector="[data-doop-id='inst01']" />))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocks.frames = [frame]
  mocks.canEdit = true
  mocks.notices.length = 0
  mocks.undeleteComponent.mockReset()
  mocks.changeInstances.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows an instance of a component in use with its props', () => {
  mocks.components = [def()]
  render()
  expect(container.textContent).toContain('Button')
  expect(container.textContent).not.toContain('Main component deleted')
  expect(container.querySelector('[data-slot="deleted-component"]')).toBeNull()
  expect(container.textContent).toContain('label')
})

it('says the main component was deleted, and offers Restore and Detach instead of props', async () => {
  mocks.components = [def({ status: 'deleted', deletedAt: 5, deletedBy: 'Tester' })]
  mocks.undeleteComponent.mockResolvedValue({ component: def(), main: 'kept' })
  mocks.changeInstances.mockResolvedValue({ frame, missing: [] })
  render()
  expect(container.querySelector('[data-slot="deleted-component"]')).not.toBeNull()
  expect(container.textContent).toContain('Main component deleted')
  expect(container.querySelectorAll('input, textarea')).toHaveLength(0)

  await act(async () => {
    button('Restore component')!.click()
    await Promise.resolve()
  })
  expect(mocks.undeleteComponent).toHaveBeenCalledWith('canvas1', 'cbutton')
  expect(mocks.notices).toEqual(['“Button” restored'])

  await act(async () => {
    button('Detach')!.click()
    await Promise.resolve()
  })
  expect(mocks.changeInstances).toHaveBeenCalledWith('frame1', [{ instanceId: 'inst01', detach: true }])
})

it('offers nothing to someone who can only look', () => {
  mocks.components = [def({ status: 'deleted', deletedAt: 5, deletedBy: 'Tester' })]
  mocks.canEdit = false
  render()
  expect(container.textContent).toContain('Main component deleted')
  expect(button('Restore component')).toBeUndefined()
  expect(button('Detach')).toBeUndefined()
})
