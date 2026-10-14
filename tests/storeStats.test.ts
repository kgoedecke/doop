import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { canvasIndex } from '../server/frame-sync.ts'
import { store } from '../server/store.ts'

it('counts canvas membership without fetching frame payloads', async () => {
  const canvases = [randomUUID(), randomUUID()].map((id) => ({
    id,
    name: 'Stats',
    createdAt: 1,
    updatedAt: 1,
    frames: [],
  }))
  // Only indexes exist: fetching a frame payload would fail this read.
  await canvasIndex(canvases[0]!.id).initializePages([{ id: 'main', name: 'Main' }])
  await canvasIndex(canvases[1]!.id).initializePages([{ id: 'main', name: 'Main' }])
  await canvasIndex(canvases[0]!.id).initialize(['frame-a', 'frame-b'])
  await canvasIndex(canvases[1]!.id).initialize()
  store.init(canvases)

  expect(await store.getCanvasStats()).toEqual({ canvases: 2, frames: 2 })
})
