import { beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'

const rig = vi.hoisted(() => ({
  savedFrames: [] as { id: string; pageId?: string; immediate?: boolean }[],
  /* runs while a page copy is being written, before it lands in memory */
  duringCopy: null as (() => void) | null,
}))
vi.mock('../server/db/persist.ts', () => {
  const noop = () => undefined
  return {
    deleteCanvas: noop,
    deleteFrame: noop,
    deleteGuideline: noop,
    deleteMember: noop,
    deleteReference: noop,
    saveCanvas: noop,
    saveCanvasCopy: noop,
    saveFrame: (frame: Frame, immediate?: boolean) =>
      rig.savedFrames.push({ id: frame.id, pageId: frame.pageId, immediate }),
    saveGuideline: noop,
    savePageCopy: async () => rig.duringCopy?.(),
    saveMember: noop,
    saveReference: noop,
  }
})
import { store } from '../server/store.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import { MAX_GUIDES } from '../shared/guides.ts'

const frame = (id: string, pageId?: string): Frame => ({
  id,
  canvasId: 'c1',
  name: id,
  pageId,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'test',
})

beforeEach(() => {
  for (const canvas of store.allCanvases()) store.deleteCanvas(canvas.id)
  rig.savedFrames = []
  rig.duringCopy = null
})

it('rehomes a frame whose page no longer exists to the first page on boot', () => {
  /* the frame move was still on the write debounce when the process died,
     but the page's deletion had already landed */
  const canvas: Canvas = {
    id: 'c1',
    name: 'Boot',
    ownerId: 'alice',
    createdAt: 1,
    updatedAt: 1,
    pages: [
      { id: 'c1:page1', name: 'Page 1' },
      { id: 'c1:page2', name: 'Page 2' },
    ],
    frames: [frame('kept', 'c1:page2'), frame('orphan', 'deleted-page'), frame('legacy')],
  }
  store.init([canvas])

  const booted = store.getCanvas('c1')!
  expect(pageFrames(booted, 'c1:page1').map((f) => f.id)).toEqual(['orphan', 'legacy'])
  expect(pageFrames(booted, 'c1:page2').map((f) => f.id)).toEqual(['kept'])
  expect(rig.savedFrames).toEqual([
    { id: 'orphan', pageId: 'c1:page1', immediate: true },
    { id: 'legacy', pageId: 'c1:page1', immediate: true },
  ])
})

it('advances a frame version when multiple writes share the same timestamp', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(100)
  try {
    const canvas = store.createCanvas('Versions', 'alice')
    const frame = store.createFrame(canvas.id, { name: 'Path' }, 'alice')!
    const first = frame.updatedAt
    const second = store.updateFrame(frame.id, { html: '<p>Second</p>' }, 'alice')!.updatedAt
    const third = store.updateFrame(frame.id, { html: '<p>Third</p>' }, 'alice')!.updatedAt
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
  } finally {
    now.mockRestore()
  }
})

it('keeps a page copy within the guide limit when guides are added while it is written', async () => {
  const canvas = store.createCanvas('Guide race', 'alice')
  const [page] = canvasPages(canvas)
  const guide = (id: string, pageId = 'elsewhere') => ({ id, pageId, axis: 'v' as const, at: 0 })
  for (let i = 0; i < 10; i++) store.setGuide(canvas.id, guide(`copied${i}`, page!.id))
  /* room for the copy's ten when it starts; a teammate fills most of it meanwhile */
  for (let i = 0; i < MAX_GUIDES - 25; i++) store.setGuide(canvas.id, guide(`filler${i}`))
  rig.duringCopy = () => {
    for (let i = 0; i < 10; i++) store.setGuide(canvas.id, guide(`late${i}`))
  }
  const copy = await store.duplicatePage(canvas.id, page!.id, 'alice')
  expect(copy!.guides).toHaveLength(5)
  expect(store.getCanvas(canvas.id)!.guides).toHaveLength(MAX_GUIDES)
})
