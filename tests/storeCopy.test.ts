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

it('publishes a canvas copy only after its canvas actor holds every frame', async () => {
  const source = await sourceCanvas()
  vi.mocked(persist.saveCanvasCopy).mockImplementationOnce(async (canvas: Canvas) => {
    expect(store.getCanvasMetadata(canvas.id)).toBeUndefined()
    const snapshot = await sync.canvasActor(canvas.id).snapshot()
    expect(snapshot.initialized).toBe(true)
    expect(snapshot.frames.map((frame) => frame.html)).toEqual(['<p>First</p>', '<p>Second</p>'])
  })
  const copy = (await store.duplicateCanvas(source, 'bob', 'Bob'))!
  expect(persist.saveCanvasCopy).toHaveBeenCalledOnce()
  expect((await store.syncCanvas(copy.id))?.frames).toHaveLength(2)
})

it('does not publish a partial copy when the canvas actor fails to take the frames', async () => {
  const source = await sourceCanvas()
  const getCanvasActor = sync.canvasActor
  let copyId = ''
  vi.spyOn(sync, 'canvasActor').mockImplementation((canvasId) => {
    const actor = getCanvasActor(canvasId)
    if (canvasId === source) return actor
    copyId = canvasId
    return {
      ...actor,
      importFrames: async () => {
        throw new Error('Actor unavailable')
      },
    }
  })
  await expect(store.duplicateCanvas(source, 'bob', 'Bob')).rejects.toThrow('Actor unavailable')
  expect(persist.saveCanvasCopy).not.toHaveBeenCalled()
  expect(store.getCanvasMetadata(copyId)).toBeUndefined()
  expect(await getCanvasActor(copyId).summary()).toMatchObject({ deleted: true, frames: [] })
})

it('leaves nothing behind when a create fails, so its empty page can still be deleted', async () => {
  const id = await sourceCanvas()
  const canvas = (await store.syncCanvas(id))!
  const pages = [...canvas.pages!, { id: 'empty', name: 'Empty' }]
  await store.setPages(id, pages, canvas.pages!)
  const getCanvasActor = sync.canvasActor
  vi.spyOn(sync, 'canvasActor').mockImplementation((canvasId) => ({
    ...getCanvasActor(canvasId),
    createFrame: async () => {
      throw new Error('Actor unavailable')
    },
  }))
  await expect(store.createFrame(id, { name: 'Failed', pageId: 'empty', x: 120 }, 'Alice')).rejects.toThrow(
    'Actor unavailable',
  )
  expect(await store.setPages(id, canvas.pages!, pages)).toEqual({ pages: canvas.pages, dropped: [] })
})
