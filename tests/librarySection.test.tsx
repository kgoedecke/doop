// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CanvasLibrary, ComponentLibrary } from '../src/lib/api'

const mocks = vi.hoisted(() => ({
  importComponent: vi.fn(),
  syncComponent: vi.fn(),
  publishLibrary: vi.fn(),
  updateLibraryEverywhere: vi.fn(),
  libraryPreview: vi.fn(),
  place: vi.fn(),
  capture: vi.fn(),
  notices: [] as string[],
  components: [] as { id: string; source?: { canvasId: string; library?: true } }[],
  canvasId: 'canvas1',
}))
vi.mock('../src/lib/api', () => ({
  api: {
    importComponent: mocks.importComponent,
    syncComponent: mocks.syncComponent,
    publishLibrary: mocks.publishLibrary,
    updateLibraryEverywhere: mocks.updateLibraryEverywhere,
    libraryPreview: mocks.libraryPreview,
  },
  errorMessage: (_error: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/components', () => ({
  placeComponent: mocks.place,
  LIBRARY_COMPONENT_DRAG_TYPE: 'application/x-doop-library-component',
  libraryDragData: (drag: unknown) => JSON.stringify(drag),
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
vi.mock('../src/components/WorkspaceModals', () => ({
  CreateWorkspaceModal: () => null,
  MoveCanvasModal: () => null,
  UpgradeModal: () => null,
}))
vi.mock('../src/lib/store', () => {
  const state = {
    get canvas() {
      return { id: mocks.canvasId, components: mocks.components }
    },
    pushNotice: (text: string) => mocks.notices.push(text),
    setComponentLocal: () => {},
  }
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state })
  return { useStore }
})
import { LibraryNotices, LibrarySection, PublishLibraryDialog } from '../src/components/LibrarySection'
import { libraryAttention, resetUpsellMemory } from '../src/lib/library'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The workspace library in the Components panel: the card a canvas without one
   gets, what a canvas with one is offered, and the publish dialog. */

let root: Root
let container: HTMLDivElement
const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)

const status = (over: Partial<CanvasLibrary> = {}): CanvasLibrary => ({
  billing: true,
  entitled: true,
  canPublish: true,
  library: false,
  changes: [],
  updates: [],
  ...over,
})
const kit: ComponentLibrary = {
  id: 'lib1',
  name: 'Design system',
  library: true,
  components: [
    { id: 'c1', name: 'Button', signature: 'Button()', description: 'The action button', instances: 0 },
    { id: 'c2', name: 'Card', signature: 'Card()', instances: 0 },
  ],
}

function render(props: Partial<Parameters<typeof LibrarySection>[0]>) {
  return act(async () =>
    root.render(
      <LibrarySection
        canvasId="canvas1"
        canEdit
        query=""
        status={status()}
        libraries={[]}
        onPublish={() => {}}
        onWall={() => {}}
        {...props}
      />,
    ),
  )
}

beforeEach(() => {
  localStorage.clear()
  resetUpsellMemory()
  for (const mock of [mocks.importComponent, mocks.syncComponent, mocks.publishLibrary, mocks.place, mocks.capture])
    mock.mockReset()
  mocks.libraryPreview.mockReset().mockResolvedValue({ html: '', width: 100, height: 50, variants: 1 })
  mocks.updateLibraryEverywhere.mockReset()
  mocks.notices.length = 0
  mocks.components = []
  mocks.canvasId = 'canvas1'
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('sells a workspace on a personal canvas, and stays dismissed', async () => {
  const onWall = vi.fn()
  await render({ status: status({ entitled: false, blocked: 'no_workspace' }), onWall })
  expect(container.textContent).toContain('Reuse components across canvases')
  expect(mocks.capture).toHaveBeenCalledWith('library_upsell_shown', { plan_required: false })
  await act(async () => button('Start a workspace')!.click())
  expect(onWall).toHaveBeenCalledWith({})

  await act(async () => (container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click())
  expect(container.querySelector('[data-library-upsell]')).toBeNull()
  act(() => root.unmount())
  root = createRoot(container)
  await render({ status: status({ entitled: false, blocked: 'no_workspace' }) })
  expect(container.querySelector('[data-library-upsell]')).toBeNull()
})

it('brings the card back once, when the canvas reaches five components with the panel open', async () => {
  const blocked = status({ entitled: false, blocked: 'no_workspace' })
  await render({ status: blocked })
  await act(async () => (container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click())
  expect(container.querySelector('[data-library-upsell]')).toBeNull()

  mocks.components = Array.from({ length: 5 }, (_, index) => ({ id: `c${index}` }))
  await render({ status: blocked })
  expect(container.querySelector('[data-library-upsell]')).toBeTruthy()
  await act(async () => (container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click())
  await render({ status: blocked })
  expect(container.querySelector('[data-library-upsell]')).toBeNull()
})

it('dismisses the card for the visit when the browser refuses to store it', async () => {
  const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError')
  })
  await render({ status: status({ entitled: false, blocked: 'no_workspace' }) })
  await act(async () => (container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click())
  expect(container.querySelector('[data-library-upsell]')).toBeNull()
  refuse.mockRestore()
})

it('points a workspace without a plan at the upgrade, and says nothing about plans when billing is off', async () => {
  const onWall = vi.fn()
  await render({ status: status({ entitled: false, blocked: 'plan_required', workspaceId: 'ws1' }), onWall })
  await act(async () => button('Upgrade to Pro')!.click())
  expect(onWall).toHaveBeenCalledWith({ workspaceId: 'ws1' })

  await render({ status: status({ billing: false, entitled: false, blocked: 'no_workspace' }) })
  expect(button('Move to a workspace')).toBeTruthy()
  expect(container.textContent).not.toContain('Pro')
})

it('shows viewers nothing', async () => {
  await render({ canEdit: false, status: status({ entitled: false, blocked: 'no_workspace' }) })
  expect(container.textContent).toBe('')
})

it('offers what the library publishes, minus what the canvas already uses, and places a pick', async () => {
  mocks.components = [{ id: 'c2', source: { canvasId: 'lib1', library: true } }]
  await render({ libraries: [kit] })
  expect(container.querySelector('[data-library-card="Button"]')).toBeTruthy()
  expect(container.querySelector('[data-library-card="Card"]')).toBeNull()

  const def = { id: 'c1', name: 'Button' }
  mocks.importComponent.mockResolvedValue(def)
  await act(async () => (container.querySelector('[data-library-card="Button"]') as HTMLButtonElement).click())
  expect(mocks.importComponent).toHaveBeenCalledWith('canvas1', 'lib1', 'c1')
  expect(mocks.place).toHaveBeenCalledWith(def)
})

it('lets a card be dragged, carrying where it comes from and importing nothing yet', async () => {
  await render({ libraries: [kit] })
  const card = container.querySelector('[data-library-card="Button"]')!
  const handle = card.closest<HTMLElement>('[draggable="true"]')!
  expect(handle).toBeTruthy()

  const carried = new Map<string, string>()
  const dataTransfer = { setData: (type: string, data: string) => carried.set(type, data), effectAllowed: 'none' }
  const dragStart = new Event('dragstart', { bubbles: true })
  Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
  await act(async () => card.dispatchEvent(dragStart))

  expect([...carried.keys()]).toEqual(['application/x-doop-library-component'])
  expect(JSON.parse(carried.get('application/x-doop-library-component')!)).toEqual({
    libraryCanvasId: 'lib1',
    componentId: 'c1',
  })
  expect(dataTransfer.effectAllowed).toBe('copy')
  expect(mocks.importComponent).not.toHaveBeenCalled()
  expect(mocks.place).not.toHaveBeenCalled()
})

it('places nothing when another canvas was opened while the component was being added', async () => {
  await render({ libraries: [kit] })
  let finish: (def: unknown) => void = () => {}
  mocks.importComponent.mockReturnValue(new Promise((resolve) => (finish = resolve)))
  await act(async () => (container.querySelector('[data-library-card="Button"]') as HTMLButtonElement).click())
  mocks.canvasId = 'canvas2'
  await act(async () => finish({ id: 'c1', name: 'Button' }))
  expect(mocks.importComponent).toHaveBeenCalledWith('canvas1', 'lib1', 'c1')
  expect(mocks.place).not.toHaveBeenCalled()
})

it('says first, and in the accent colour, what waits: unpublished changes and updates to pull', async () => {
  const onPublish = vi.fn()
  mocks.syncComponent.mockResolvedValue({ updated: true })
  const waiting = status({
    library: true,
    changes: [
      { id: 'c1', name: 'Button', change: 'changed' },
      { id: 'c3', name: 'Chip', change: 'unchanged' },
    ],
    updates: [
      { id: 'c4', name: 'Card', instances: 3 },
      { id: 'c5', name: 'Badge', instances: 1 },
    ],
  })
  expect(libraryAttention(waiting)).toEqual({ unpublished: 1, updates: 2 })
  await act(async () =>
    root.render(<LibraryNotices canvasId="canvas1" canEdit status={waiting} onPublish={onPublish} />),
  )
  expect(container.textContent).toContain('1 unpublished change')
  expect(container.textContent).toContain('Other canvases still use the last published version.')
  await act(async () => button('Publish changes')!.click())
  expect(onPublish).toHaveBeenCalled()

  expect(container.textContent).toContain('2 library updates')
  expect(container.textContent).toContain('reaches 4 instances')
  await act(async () => button('Update all')!.click())
  expect(mocks.syncComponent.mock.calls.map((call) => call[1])).toEqual(['c4', 'c5'])
})

it('asks for nothing when all is published, before a first publish, or of a viewer', async () => {
  const quiet = status({ library: true, changes: [{ id: 'c1', name: 'Button', change: 'unchanged' }] })
  const never = status({ changes: [{ id: 'c1', name: 'Button', change: 'new' }] })
  expect(libraryAttention(quiet)).toEqual({ unpublished: 0, updates: 0 })
  expect(libraryAttention(never)).toEqual({ unpublished: 0, updates: 0 })
  await act(async () => root.render(<LibraryNotices canvasId="canvas1" canEdit status={quiet} onPublish={() => {}} />))
  expect(container.textContent).toBe('')
  const pending = status({ library: true, changes: [{ id: 'c1', name: 'Button', change: 'changed' }] })
  await act(async () =>
    root.render(<LibraryNotices canvasId="canvas1" canEdit={false} status={pending} onPublish={() => {}} />),
  )
  expect(container.textContent).toBe('')
})

it('offers no publishing to someone the workspace keeps it from', async () => {
  const first = status({ canPublish: false, changes: [{ id: 'c1', name: 'Button', change: 'new' }] })
  await render({ status: { ...first, canPublish: true } })
  expect(container.querySelector('[data-library-publish]')).toBeTruthy()
  await render({ status: first, libraries: [kit] })
  expect(container.querySelector('[data-library-publish]')).toBeNull()
  /* the library itself is theirs to use */
  expect(container.querySelector('[data-library-card="Button"]')).toBeTruthy()

  const pending = status({
    canPublish: false,
    library: true,
    changes: [{ id: 'c1', name: 'Button', change: 'changed' }],
    updates: [{ id: 'c4', name: 'Card', instances: 1 }],
  })
  expect(libraryAttention(pending)).toEqual({ unpublished: 0, updates: 1 })
  await act(async () =>
    root.render(<LibraryNotices canvasId="canvas1" canEdit status={pending} onPublish={() => {}} />),
  )
  expect(container.querySelector('[data-library-unpublished]')).toBeNull()
  expect(container.querySelector('[data-library-publish]')).toBeNull()
  expect(button('Update all')).toBeTruthy()
})

it('offers a library with canvases on an older version to update them everywhere, after a confirmation', async () => {
  const behind = [
    { id: 'k1', name: 'Landing', components: ['Button'] },
    { id: 'k2', name: 'Pricing', components: ['Button', 'Card'] },
  ]
  const published = status({ library: true, changes: [{ id: 'c1', name: 'Button', change: 'unchanged' }], behind })
  mocks.updateLibraryEverywhere.mockResolvedValue({
    dry_run: false,
    canvases: [
      { canvas_id: 'k1', canvas_name: 'Landing', updated: ['Button'], frames_changed: 2, approvals_withdrawn: 0 },
    ],
    skipped: [{ canvas_id: 'k2', canvas_name: 'Pricing', reason: 'no_edit_access', message: 'no' }],
  })
  await act(async () =>
    root.render(<LibraryNotices canvasId="canvas1" canEdit status={published} onPublish={() => {}} />),
  )
  expect(container.querySelector('[data-library-behind]')?.textContent).toContain('2 canvases are on an older version')
  expect(container.textContent).toContain('Landing, Pricing')

  /* the button only asks: nothing is sent until the dialog is confirmed */
  await act(async () => (container.querySelector('[data-library-update-everywhere]') as HTMLButtonElement).click())
  expect(mocks.updateLibraryEverywhere).not.toHaveBeenCalled()
  const dialog = document.querySelector('[data-slot="confirm-dialog"]')!
  expect(dialog.textContent).toContain('Update 2 canvases to the latest version?')
  expect(dialog.textContent).toContain('Approved frames stay approved')
  await act(async () =>
    Array.from(dialog.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Update everywhere')!
      .click(),
  )
  expect(mocks.updateLibraryEverywhere).toHaveBeenCalledWith('canvas1')
  expect(mocks.notices).toEqual(['1 canvas updated · 1 canvas skipped'])
})

it('keeps quiet about older versions while changes are unpublished, on other canvases, and with viewers', async () => {
  const behind = [{ id: 'k1', name: 'Landing', components: ['Button'] }]
  const unpublished = status({ library: true, changes: [{ id: 'c1', name: 'Button', change: 'changed' }], behind })
  await act(async () =>
    root.render(<LibraryNotices canvasId="canvas1" canEdit status={unpublished} onPublish={() => {}} />),
  )
  expect(container.querySelector('[data-library-unpublished]')).toBeTruthy()
  expect(container.querySelector('[data-library-behind]')).toBeNull()

  const published = status({ library: true, changes: [{ id: 'c1', name: 'Button', change: 'unchanged' }], behind })
  await act(async () =>
    root.render(<LibraryNotices canvasId="canvas1" canEdit={false} status={published} onPublish={() => {}} />),
  )
  expect(container.textContent).toBe('')
  await act(async () =>
    root.render(
      <LibraryNotices canvasId="canvas1" canEdit status={{ ...published, behind: [] }} onPublish={() => {}} />,
    ),
  )
  expect(container.textContent).toBe('')
})

it('publishes the ticked components and leaves the rest', async () => {
  const onDone = vi.fn()
  mocks.publishLibrary.mockResolvedValue({ published: [{ id: 'c1' }], removed: [] })
  await act(async () =>
    root.render(
      <PublishLibraryDialog
        canvasId="canvas1"
        status={status({
          changes: [
            { id: 'c1', name: 'Button', change: 'new' },
            { id: 'c2', name: 'Card', change: 'changed' },
            { id: 'c3', name: 'Chip', change: 'unchanged' },
          ],
        })}
        onClose={() => {}}
        onDone={onDone}
      />,
    ),
  )
  const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('[data-library-changes] input'))
  expect(boxes.map((box) => box.checked)).toEqual([true, true, true])
  expect(boxes[2]!.disabled).toBe(true)
  await act(async () => boxes[1]!.click())
  await act(async () => button('Publish')!.click())
  expect(mocks.publishLibrary).toHaveBeenCalledWith('canvas1', ['c1'])
  expect(onDone).toHaveBeenCalled()
})
