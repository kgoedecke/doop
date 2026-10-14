import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({ loadLegacyFrameIds: async () => [], saveCanvas: vi.fn() }))
import { store } from '../server/store.ts'
import { canvasIndex, frameActor } from '../server/frame-sync.ts'
import { pageFrames } from '../shared/pages.ts'

it('imports existing page membership into the canvas index on first access', async () => {
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
  for (const entry of frames) await frameActor(entry.id).initialize(entry)
  await canvasIndex(canvasId).initialize(frames.map((entry) => entry.id))
  store.init([canvas])

  const reopened = (await store.syncCanvas(canvasId))!
  expect(pageFrames(reopened, 'first').map((entry) => entry.name)).toEqual(['orphan', 'legacy'])
  expect(pageFrames(reopened, 'second').map((entry) => entry.name)).toEqual(['kept'])
  for (const entry of frames.slice(1)) expect((await store.getFrame(entry.id))?.pageId).toBe('first')
  expect((await canvasIndex(canvasId).snapshot()).framePages).toEqual({
    [frames[0]!.id]: 'second',
    [frames[1]!.id]: 'first',
    [frames[2]!.id]: 'first',
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
  const index = canvasIndex(id)
  expect(await index.setPages([pages[0]!], pages)).toEqual({ pages: [pages[0]] })

  // Bypass the app's earlier check to exercise stale requests already in flight.
  expect(await index.moveFrame(frame.id, 'removed')).toBe(false)
  expect(await index.reserveFrame({ ...frame, id: `${id}.late`, pageId: 'removed' }, false, {})).toBeNull()
  expect(await store.updateFrame(frame.id, { pageId: 'removed', name: 'Rejected' }, 'Bob')).toBeUndefined()
  expect((await store.syncCanvas(id))?.frames).toMatchObject([{ name: 'Kept', pageId: 'main' }])
})

it('keeps a page while a frame is being created or has moved onto it', async () => {
  const id = randomUUID()
  const pages = [
    { id: 'main', name: 'Main' },
    { id: 'target', name: 'Target' },
  ]
  store.init([{ id, name: 'Pages', createdAt: 1, updatedAt: 1, pages, frames: [] }])
  const frame = (await store.createFrame(id, { name: 'Kept', pageId: 'main' }, 'Alice'))!
  const index = canvasIndex(id)
  const pending = { ...frame, id: `${id}.pending`, pageId: 'target' }
  expect(await index.reserveFrame(pending, false, {})).toEqual(pending)
  expect(await index.setPages([pages[0]!], pages)).toMatchObject({ error: 'occupied' })
  await index.remove(pending.id)
  await index.confirmDelete(pending.id)

  await expect(store.updateFrame(frame.id, { pageId: 'target', width: -1 }, 'Alice')).rejects.toThrow(
    'Invalid frame width',
  )
  expect((await store.getFrame(frame.id))?.pageId).toBe('main')
  expect((await store.updateFrame(frame.id, { pageId: 'target' }, 'Alice'))?.pageId).toBe('target')
  expect(await index.setPages([pages[0]!], pages)).toMatchObject({ error: 'occupied' })
  expect(await index.setPages([pages[1]!], pages)).toEqual({ pages: [pages[1]] })
  expect((await store.getFrame(frame.id))?.pageId).toBe('target')
  expect((await store.updateFrame(frame.id, { name: 'Edited later' }, 'Alice'))?.pageId).toBe('target')
})
