import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'

/* opening a canvas records that its frames are on its actor */
vi.mock('../server/db/persist.ts', () => ({ saveCanvas: vi.fn() }))
import { canvasActor } from '../server/frame-sync.ts'
import { store } from '../server/store.ts'

it('counts frames without fetching frame payloads', async () => {
  const canvases = [randomUUID(), randomUUID()].map((id) => ({
    id,
    name: 'Stats',
    createdAt: 1,
    updatedAt: 1,
    frames: [],
  }))
  // Frames exist only as actor rows: reading their HTML would not be needed for a count.
  const pages = [{ id: 'main', name: 'Main' }]
  const frame = (canvasId: string, id: string) => ({
    id: `${canvasId}.${id}`,
    canvasId,
    pageId: 'main',
    name: id,
    html: '<p>Frame</p>',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: 'test',
  })
  const [first, second] = canvases.map((canvas) => canvas.id) as [string, string]
  await canvasActor(first).importFrames([frame(first, 'a'), frame(first, 'b')])
  await canvasActor(first).initialize(pages)
  await canvasActor(second).initialize(pages)
  store.init(canvases)

  expect(await store.getCanvasStats()).toEqual({ canvases: 2, frames: 2 })
})
