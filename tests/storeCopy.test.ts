import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  loadLegacyFrameIds: async () => [],
  saveCanvasCopy: vi.fn(),
  saveCanvas: vi.fn(),
}))
import * as persist from '../server/db/persist.ts'
import * as sync from '../server/frame-sync.ts'
import { store } from '../server/store.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  store.canvases.clear()
})

async function sourceCanvas() {
  const id = randomUUID()
  store.init([{ id, name: 'Source', createdAt: 1, updatedAt: 1, frames: [] }])
  await store.createFrame(id, { name: 'First', html: '<p>First</p>' }, 'Alice')
  await store.createFrame(id, { name: 'Second', html: '<p>Second</p>' }, 'Alice')
  return id
}

it('publishes a canvas copy only after every frame actor is ready', async () => {
  const source = await sourceCanvas()
  vi.mocked(persist.saveCanvasCopy).mockImplementationOnce(async (canvas: Canvas) => {
    expect(store.getCanvasMetadata(canvas.id)).toBeUndefined()
    const index = await sync.canvasIndex(canvas.id).snapshot()
    expect(index.frameIds).toHaveLength(2)
    const frames = await Promise.all(index.frameIds.map(async (id) => (await sync.frameActor(id).snapshot()).frame))
    expect(frames.map((frame) => frame?.html)).toEqual(['<p>First</p>', '<p>Second</p>'])
  })
  const copy = (await store.duplicateCanvas(source, 'bob', 'Bob'))!
  expect(persist.saveCanvasCopy).toHaveBeenCalledOnce()
  expect((await store.syncCanvas(copy.id))?.frames).toHaveLength(2)
})

it('does not publish a partial copy when a frame actor fails to initialize', async () => {
  const source = await sourceCanvas()
  const getFrameActor = sync.frameActor
  let copied = 0
  let copyId = ''
  vi.spyOn(sync, 'frameActor').mockImplementation((id) => {
    const actor = getFrameActor(id)
    if (id.startsWith(`${source}.`)) return actor
    return {
      ...actor,
      initialize: async (frame) => {
        copyId = frame.canvasId
        if (++copied === 2) throw new Error('Actor unavailable')
        return actor.initialize(frame)
      },
    }
  })
  await expect(store.duplicateCanvas(source, 'bob', 'Bob')).rejects.toThrow('Actor unavailable')
  expect(copied).toBe(2)
  expect(persist.saveCanvasCopy).not.toHaveBeenCalled()
  expect(store.getCanvasMetadata(copyId)).toBeUndefined()
  expect(await sync.canvasIndex(copyId).snapshot()).toMatchObject({ deleted: true, frameIds: [] })
})

it('releases a failed creation so its empty page can still be deleted', async () => {
  const id = await sourceCanvas()
  const canvas = (await store.syncCanvas(id))!
  const pages = [...canvas.pages!, { id: 'empty', name: 'Empty' }]
  await store.setPages(id, pages, canvas.pages!)
  const getFrameActor = sync.frameActor
  vi.spyOn(sync, 'frameActor').mockImplementation((frameId) => ({
    ...getFrameActor(frameId),
    initialize: async () => {
      throw new Error('Actor unavailable')
    },
  }))
  await expect(store.createFrame(id, { name: 'Failed', pageId: 'empty', x: 120 }, 'Alice')).rejects.toThrow(
    'Actor unavailable',
  )
  expect(await store.setPages(id, canvas.pages!, pages)).toEqual({ pages: canvas.pages })
})
