import { beforeEach, describe, expect, it, vi } from 'vitest'

/* persistence is not under test: the canvas actor's order is */
vi.mock('../server/db/persist.ts', () => ({
  loadLegacyFrameIds: async () => [],
  loadLegacyFrame: async () => undefined,
  saveCanvas: () => {},
  saveCanvasCopy: () => Promise.resolve(),
}))

const { store } = await import('../server/store.ts')
const { canvasPages, pageFrames } = await import('../shared/pages.ts')

let canvasId: string
const order = async (pageId?: string) => {
  const canvas = (await store.syncCanvas(canvasId))!
  return pageFrames(canvas, pageId ?? canvasPages(canvas)[0]!.id).map((f) => f.name)
}

beforeEach(() => {
  canvasId = store.createCanvas('stack', 'kevin').id
})

describe('server frame stacking', () => {
  it('creates each frame in front of the page', async () => {
    const a = (await store.createFrame(canvasId, { name: 'a' }, 'kevin'))!
    const b = (await store.createFrame(canvasId, { name: 'b' }, 'kevin'))!
    expect(b.z).toBeGreaterThan(a.z!)
    expect(await order()).toEqual(['a', 'b'])
  })

  it('keeps the frames in stack order after a z change', async () => {
    await store.createFrame(canvasId, { name: 'a' }, 'kevin')
    await store.createFrame(canvasId, { name: 'b' }, 'kevin')
    const c = (await store.createFrame(canvasId, { name: 'c' }, 'kevin'))!
    await store.updateFrame(c.id, { z: -1 }, 'kevin')
    expect(await order()).toEqual(['c', 'a', 'b'])
  })

  it('brings a deleted frame back to the place it is given', async () => {
    await store.createFrame(canvasId, { name: 'a' }, 'kevin')
    await store.createFrame(canvasId, { name: 'b' }, 'kevin')
    await store.createFrame(canvasId, { name: 'back', z: -5 }, 'kevin')
    expect(await order()).toEqual(['back', 'a', 'b'])
  })

  it('puts a frame moved to another page in front there', async () => {
    const pages = canvasPages((await store.syncCanvas(canvasId))!)
    await store.setPages(canvasId, [pages[0]!, { id: 'p2', name: 'Page 2' }], pages)
    await store.createFrame(canvasId, { name: 'there', pageId: 'p2', z: 100 }, 'kevin')
    const moving = (await store.createFrame(canvasId, { name: 'moving', z: -100 }, 'kevin'))!
    await store.updateFrame(moving.id, { pageId: 'p2' }, 'kevin')
    expect(await order('p2')).toEqual(['there', 'moving'])
  })

  it('keeps the order in a copied canvas', async () => {
    await store.createFrame(canvasId, { name: 'a' }, 'kevin')
    const b = (await store.createFrame(canvasId, { name: 'b' }, 'kevin'))!
    await store.updateFrame(b.id, { z: -1 }, 'kevin')
    const copy = await store.duplicateCanvas(canvasId, 'kevin', 'kevin')
    expect(copy!.frames.map((f) => f.name)).toEqual(['b', 'a'])
  })
})
