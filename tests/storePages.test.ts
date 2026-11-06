import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  loadLegacyFrameIds: vi.fn(async () => []),
  loadLegacyFrame: vi.fn(),
  saveCanvas: vi.fn(),
  saveGuideline: vi.fn(),
  saveCanvasCopy: vi.fn(async () => {}),
}))
import * as persist from '../server/db/persist.ts'
import { store } from '../server/store.ts'
import { canvasActor } from '../server/frame-sync.ts'
import { canvasPages, pageFrames } from '../shared/pages.ts'
import { MAX_GUIDES } from '../shared/guides.ts'

it('imports legacy frames onto their pages on first access', async () => {
  const canvasId = randomUUID()
  const frame = (id: string, pageId?: string): Frame => ({
    id: `${canvasId}.${id}`,
    canvasId,
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
  const canvas: Canvas = {
    id: canvasId,
    name: 'Reopened',
    ownerId: 'alice',
    createdAt: 1,
    updatedAt: 1,
    pages: [
      { id: 'first', name: 'Page 1' },
      { id: 'second', name: 'Page 2' },
    ],
    frames: [],
  }
  const frames = [frame('kept', 'second'), frame('orphan', 'deleted-page'), frame('legacy')]
  vi.mocked(persist.loadLegacyFrameIds).mockResolvedValueOnce(frames.map((entry) => entry.id))
  vi.mocked(persist.loadLegacyFrame).mockImplementation(async (id) => frames.find((entry) => entry.id === id))
  store.init([canvas])

  const reopened = (await store.syncCanvas(canvasId))!
  expect(pageFrames(reopened, 'first').map((entry) => entry.name)).toEqual(['orphan', 'legacy'])
  expect(pageFrames(reopened, 'second').map((entry) => entry.name)).toEqual(['kept'])
  for (const entry of frames.slice(1)) expect((await store.getFrame(entry.id))?.pageId).toBe('first')
  const { frames: stored } = await canvasActor(canvasId).snapshot()
  expect(Object.fromEntries(stored.map((entry) => [entry.name, entry.pageId]))).toEqual({
    kept: 'second',
    orphan: 'first',
    legacy: 'first',
  })
})

it('rejects creates and moves to a deleted page without relocating the frame on later reads', async () => {
  const id = randomUUID()
  const pages = [
    { id: 'main', name: 'Main' },
    { id: 'removed', name: 'Removed' },
  ]
  store.init([{ id, name: 'Pages', createdAt: 1, updatedAt: 1, pages, frames: [] }])
  const frame = (await store.createFrame(id, { name: 'Kept', pageId: 'main' }, 'Alice'))!
  const actor = canvasActor(id)
  expect(await actor.setPages([pages[0]!], pages)).toEqual({ pages: [pages[0]] })

  // Bypass the app's earlier check to exercise stale requests already in flight.
  const by = { name: 'Bob', kind: 'user' as const, color: '#000' }
  expect(await actor.createFrame({ ...frame, id: `${id}.late`, pageId: 'removed' }, by, false)).toBeNull()
  expect(await actor.write(frame.id, { type: 'update', patch: { pageId: 'removed' } }, by)).toBeNull()
  expect(await store.updateFrame(frame.id, { pageId: 'removed', name: 'Rejected' }, 'Bob')).toBeUndefined()
  expect((await store.syncCanvas(id))?.frames).toMatchObject([{ name: 'Kept', pageId: 'main' }])
})

it('moves a frame between pages in one write, and keeps a page that holds frames', async () => {
  const id = randomUUID()
  const pages = [
    { id: 'main', name: 'Main' },
    { id: 'target', name: 'Target' },
  ]
  store.init([{ id, name: 'Pages', createdAt: 1, updatedAt: 1, pages, frames: [] }])
  const frame = (await store.createFrame(id, { name: 'Kept', pageId: 'main' }, 'Alice'))!
  const actor = canvasActor(id)

  // An invalid patch moves nothing: the page change and the edit land together or not at all.
  await expect(store.updateFrame(frame.id, { pageId: 'target', width: -1 }, 'Alice')).rejects.toThrow(
    'Invalid frame width',
  )
  expect((await store.getFrame(frame.id))?.pageId).toBe('main')
  expect((await store.updateFrame(frame.id, { pageId: 'target' }, 'Alice'))?.pageId).toBe('target')
  expect(await actor.setPages([pages[0]!], pages)).toMatchObject({ error: 'occupied' })
  expect(await actor.setPages([pages[1]!], pages)).toEqual({ pages: [pages[1]] })
  expect((await store.getFrame(frame.id))?.pageId).toBe('target')
  expect((await store.updateFrame(frame.id, { name: 'Edited later' }, 'Alice'))?.pageId).toBe('target')
})

const newCanvas = (name: string): Canvas => {
  const canvas: Canvas = { id: randomUUID(), name, ownerId: 'alice', createdAt: 1, updatedAt: 1, frames: [] }
  store.init([canvas])
  return store.getCanvasMetadata(canvas.id)!
}

it('advances a frame version when multiple writes share the same timestamp', async () => {
  const canvas = newCanvas('Versions')
  const frame = (await store.createFrame(canvas.id, { name: 'Path' }, 'alice'))!
  const now = vi.spyOn(Date, 'now').mockReturnValue(frame.updatedAt)
  try {
    const second = (await store.updateFrame(frame.id, { html: '<p>Second</p>' }, 'alice'))!.updatedAt
    const third = (await store.updateFrame(frame.id, { html: '<p>Third</p>' }, 'alice'))!.updatedAt
    expect(second).toBeGreaterThan(frame.updatedAt)
    expect(third).toBeGreaterThan(second)
  } finally {
    now.mockRestore()
  }
})

it('keeps a page copy within the guide limit', async () => {
  const canvas = newCanvas('Guide limit')
  const [page] = canvasPages(canvas)
  const guide = (id: string, pageId = 'elsewhere') => ({ id, pageId, axis: 'v' as const, at: 0 })
  for (let i = 0; i < 10; i++) store.setGuide(canvas.id, guide(`copied${i}`, page!.id))
  for (let i = 0; i < MAX_GUIDES - 15; i++) store.setGuide(canvas.id, guide(`filler${i}`))
  await expect(store.duplicatePage(canvas.id, page!.id, 'alice')).rejects.toThrow('guides')
  /* five over: make exactly enough room */
  for (let i = 0; i < 5; i++) store.deleteGuide(canvas.id, `filler${i}`)
  const copy = (await store.duplicatePage(canvas.id, page!.id, 'alice'))!
  expect(copy.guides).toHaveLength(10)
  expect(store.getCanvasMetadata(canvas.id)!.guides).toHaveLength(MAX_GUIDES)
})

it('points a copied page’s prototype links and flow start at the copied frames', async () => {
  const canvas = newCanvas('Prototype copy')
  const [page] = canvasPages(canvas)
  await store.setPages(canvas.id, [page!, { id: 'other-page', name: 'Other' }], [page!])
  const other = (await store.createFrame(canvas.id, { name: 'Elsewhere', pageId: 'other-page' }, 'alice'))!
  const target = (await store.createFrame(canvas.id, { name: 'Target', pageId: page!.id }, 'alice'))!
  const multi = JSON.stringify([
    { on: 'click', action: `overlay:${target.id}` },
    { on: 'key:Escape', action: `navigate:${other.id}` },
  ]).replaceAll('"', '&quot;')
  await store.createFrame(
    canvas.id,
    {
      name: 'Start',
      pageId: page!.id,
      html: `<a data-doop-on="click" data-doop-action="navigate:${target.id}">Go</a><b data-doop-interactions="${multi}"></b>`,
    },
    'alice',
  )
  await store.setFlowStart(canvas.id, page!.id, target.id)

  const copy = (await store.duplicatePage(canvas.id, page!.id, 'alice'))!
  const copiedTarget = copy.frames.find((f) => f.name === 'Target')!
  const copiedStart = copy.frames.find((f) => f.name === 'Start')!
  expect(copy.page.startFrameId).toBe(copiedTarget.id)
  expect(copiedStart.html).toContain(`navigate:${copiedTarget.id}`)
  expect(copiedStart.html).toContain(`overlay:${copiedTarget.id}`)
  /* the link to a frame on another page was not part of the copy */
  expect(copiedStart.html).toContain(`navigate:${other.id}`)
  expect(copiedStart.html).not.toContain(target.id)
  /* the copy lives in the canvas actor: a fresh read lists the page and its frames */
  const reread = (await store.syncCanvas(canvas.id))!
  expect(
    pageFrames(reread, copy.page.id)
      .map((f) => f.name)
      .sort(),
  ).toEqual(['Start', 'Target'])
})

it('points a copied canvas’s prototype links and flow starts at the copied frames', async () => {
  const canvas = newCanvas('Prototype canvas')
  const [page] = canvasPages(canvas)
  const target = (await store.createFrame(canvas.id, { name: 'Target', pageId: page!.id }, 'alice'))!
  await store.createFrame(
    canvas.id,
    { name: 'Start', pageId: page!.id, html: `<a data-doop-on="click" data-doop-action="overlay:${target.id}">Go</a>` },
    'alice',
  )
  await store.setFlowStart(canvas.id, page!.id, target.id)

  const copy = (await store.duplicateCanvas(canvas.id, 'bob', 'bob'))!
  const copiedTarget = copy.frames.find((f) => f.name === 'Target')!
  expect(copy.frames.find((f) => f.name === 'Start')!.html).toContain(`overlay:${copiedTarget.id}`)
  expect(canvasPages(copy)[0]!.startFrameId).toBe(copiedTarget.id)
})

it('keeps a page’s background across page-list saves and gives it to copies of the page and the canvas', async () => {
  const canvas = store.createCanvas('Painted', 'alice')
  const [page] = canvasPages(canvas)
  expect(store.setPageBackground(canvas.id, 'missing', '#1e1e1e')).toBeUndefined()
  expect(store.setPageBackground(canvas.id, page!.id, '#1e1e1e')).toEqual([{ ...page, background: '#1e1e1e' }])
  /* a rename or reorder never touches the colour, whatever the client sends for it */
  const saved = store.setPages(canvas.id, [
    { id: page!.id, name: 'Renamed', background: '#ffffff' },
    { id: 'second', name: 'Second', background: '#ff0000' },
  ])
  expect(saved!.pages).toEqual([
    { id: page!.id, name: 'Renamed', background: '#1e1e1e' },
    { id: 'second', name: 'Second' },
  ])
  const copy = await store.duplicatePage(canvas.id, page!.id, 'alice')
  expect(copy!.page.background).toBe('#1e1e1e')
  const twin = await store.duplicateCanvas(canvas.id, 'alice', 'alice')
  expect(canvasPages(twin!).map((p) => p.background)).toEqual(['#1e1e1e', '#1e1e1e', undefined])
  expect(store.setPageBackground(canvas.id, page!.id, null)).toEqual([
    { id: page!.id, name: 'Renamed' },
    { id: copy!.page.id, name: 'Renamed copy', background: '#1e1e1e' },
    { id: 'second', name: 'Second' },
  ])
})
