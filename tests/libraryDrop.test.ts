// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { ComponentDef } from '../shared/components'
import type { Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: { importComponent: vi.fn(), insertInstance: vi.fn(), createFrame: vi.fn() },
}))
const { api, ApiError } = await import('../src/lib/api')
const { useStore } = await import('../src/lib/store')
const { clearHistory } = await import('../src/lib/history')
const { dropLibraryComponent, libraryDragData, parseLibraryDrag } = await import('../src/lib/components')

/* A workspace library's card let go over the canvas: the canvas takes the
   component up on the drop, then the instance lands where one of its own would. */

const frame = (id: string, over: Partial<Frame> = {}): Frame => ({
  id,
  canvasId: 'c',
  pageId: 'p',
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: `<p>${id}</p>`,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Me',
  ...over,
})
const button = {
  id: 'c1',
  name: 'Button',
  rev: 1,
  source: { canvasId: 'lib1', componentId: 'c1', rev: 3, library: true },
} as ComponentDef
const drag = { libraryCanvasId: 'lib1', componentId: 'c1' }
const inFrame = { x: 50, y: 50 }
const onPaper = { x: 400, y: 300 }

function open(frames: Frame[], id = 'c') {
  useStore.getState().setCanvas({ id, name: 'T', frames, pages: [{ id: 'p', name: 'P' }] } as Canvas)
}

beforeEach(() => {
  vi.resetAllMocks()
  clearHistory()
  localStorage.clear()
  useStore.setState({ notice: null })
  open([frame('a')])
  vi.mocked(api.importComponent).mockResolvedValue(button)
  vi.mocked(api.insertInstance).mockImplementation(async (frameId) => ({
    frame: frame(frameId, { html: '<p>a</p><div data-doop-instance="c1"></div>' }),
    instanceId: 'i1',
  }))
  vi.mocked(api.createFrame).mockImplementation(async (canvasId, input) => ({ ...frame('made'), ...input, canvasId }))
})

it('round-trips the payload and refuses anything else under the type', () => {
  expect(parseLibraryDrag(libraryDragData(drag))).toEqual(drag)
  for (const junk of ['', 'c1', 'null', '[]', '{"componentId":"c1"}', '{"libraryCanvasId":"","componentId":"c1"}'])
    expect(parseLibraryDrag(junk)).toBeNull()
})

it('imports, then inserts into the frame under the pointer', async () => {
  await dropLibraryComponent(drag, inFrame)
  expect(api.importComponent).toHaveBeenCalledWith('c', 'lib1', 'c1')
  /* the definition is in the store without waiting for the room */
  expect(useStore.getState().canvas?.components).toEqual([button])
  expect(api.insertInstance).toHaveBeenCalledWith('a', { component: 'c1' })
  expect(vi.mocked(api.importComponent).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(api.insertInstance).mock.invocationCallOrder[0]!,
  )
  expect(useStore.getState().canvas?.frames[0]?.html).toContain('data-doop-instance="c1"')
  expect(useStore.getState().selectedId).toBe('a')
  expect(api.createFrame).not.toHaveBeenCalled()
})

it('lands on the paper as a frame of its own at the drop point', async () => {
  await dropLibraryComponent(drag, onPaper)
  expect(api.insertInstance).not.toHaveBeenCalled()
  expect(api.createFrame).toHaveBeenCalledWith(
    'c',
    expect.objectContaining({ name: 'Button', x: 400, y: 300, html: expect.stringContaining('component="c1"') }),
  )
  expect(useStore.getState().selectedId).toBe('made')
})

it('takes nothing up when the frame under the pointer is locked', async () => {
  open([frame('a', { locked: true })])
  await dropLibraryComponent(drag, inFrame)
  expect(api.importComponent).not.toHaveBeenCalled()
  expect(api.insertInstance).not.toHaveBeenCalled()
  expect(useStore.getState().notice?.text).toBeTruthy()
})

it('says why an import failed and places nothing', async () => {
  vi.mocked(api.importComponent).mockRejectedValue(new ApiError(402, '{"error":"This workspace needs a plan."}'))
  await dropLibraryComponent(drag, inFrame)
  expect(useStore.getState().notice?.text).toBe('This workspace needs a plan.')
  expect(useStore.getState().canvas?.components ?? []).toEqual([])
  expect(api.insertInstance).not.toHaveBeenCalled()
  expect(api.createFrame).not.toHaveBeenCalled()

  vi.mocked(api.importComponent).mockRejectedValue(new Error('offline'))
  await dropLibraryComponent(drag, inFrame)
  expect(useStore.getState().notice?.text).toBe('Couldn’t import that.')
})

it('places nothing on a canvas opened while the import was on its way', async () => {
  let answer!: (def: ComponentDef) => void
  vi.mocked(api.importComponent).mockReturnValue(new Promise((resolve) => (answer = resolve)))
  const dropped = dropLibraryComponent(drag, inFrame)
  open([frame('other', { canvasId: 'c2' })], 'c2')
  answer(button)
  await dropped
  expect(useStore.getState().canvas?.components ?? []).toEqual([])
  expect(api.insertInstance).not.toHaveBeenCalled()
  expect(api.createFrame).not.toHaveBeenCalled()
})
