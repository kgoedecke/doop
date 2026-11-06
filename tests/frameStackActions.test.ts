import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

/* persistence is not under test: the batch's all-or-nothing is */
vi.mock('../server/db/persist.ts', () => ({
  loadLegacyFrameIds: async () => [],
  legacyFrameCanvasId: async () => undefined,
  saveTask: () => {},
  saveActivity: () => {},
  saveCanvas: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

const user: Actor = { name: 'kevin', kind: 'user', color: '#000' }
let canvasId: string
const order = async () => (await store.syncCanvas(canvasId))!.frames.map((f) => f.name)

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('stack', 'kevin').id
})

describe('restackFrames', () => {
  it('writes every frame of a renumbering', async () => {
    const a = (await actions.createFrame(canvasId, { name: 'a' }, user))!
    const b = (await actions.createFrame(canvasId, { name: 'b' }, user))!
    const frames = await actions.restackFrames(
      canvasId,
      [
        { id: b.id, z: 0 },
        { id: a.id, z: 1 },
      ],
      user,
    )
    expect(frames?.map((f) => f.z)).toEqual([0, 1])
    expect(await order()).toEqual(['b', 'a'])
  })

  it('writes nothing when one frame is missing or on another canvas', async () => {
    const a = (await actions.createFrame(canvasId, { name: 'a' }, user))!
    await actions.createFrame(canvasId, { name: 'b' }, user)
    const elsewhere = (await actions.createFrame(store.createCanvas('other', 'kevin').id, { name: 'x' }, user))!
    const z = a.z
    expect(
      await actions.restackFrames(
        canvasId,
        [
          { id: a.id, z: 99 },
          { id: 'gone', z: 0 },
        ],
        user,
      ),
    ).toBeUndefined()
    expect(
      await actions.restackFrames(
        canvasId,
        [
          { id: a.id, z: 99 },
          { id: elsewhere.id, z: 0 },
        ],
        user,
      ),
    ).toBeUndefined()
    expect((await store.getFrame(a.id))?.z).toBe(z)
    expect(await order()).toEqual(['a', 'b'])
  })

  it('keeps an explicit z when a frame changes page (undoing a page move)', async () => {
    const pages = (await store.syncCanvas(canvasId))!.pages ?? []
    await store.setPages(canvasId, [...pages, { id: 'p2', name: 'Page 2' }], pages)
    const a = (await actions.createFrame(canvasId, { name: 'a', z: 5 }, user))!
    await actions.createFrame(canvasId, { name: 'b', z: 10 }, user)
    await actions.updateFrame(a.id, { pageId: 'p2' }, user)
    await actions.updateFrame(a.id, { pageId: pages[0]!.id, z: 5 }, user)
    expect((await store.getFrame(a.id))?.z).toBe(5)
    expect(await order()).toEqual(['a', 'b'])
  })
})
