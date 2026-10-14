import { beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'

const rig = vi.hoisted(() => ({ savedFrames: [] as { id: string; pageId?: string; immediate?: boolean }[] }))
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
    saveMember: noop,
    saveReference: noop,
  }
})
import { store } from '../server/store.ts'
import { pageFrames } from '../shared/pages.ts'

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
