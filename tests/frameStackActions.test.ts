import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

/* persistence is not under test: the batch's all-or-nothing is */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveActivity: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

const user: Actor = { name: 'kevin', kind: 'user', color: '#000' }
let canvasId: string
const order = () => store.getCanvas(canvasId)!.frames.map((f) => f.name)

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('stack', 'kevin').id
})

describe('restackFrames', () => {
  it('writes every frame of a renumbering', () => {
    const a = actions.createFrame(canvasId, { name: 'a' }, user)!
    const b = actions.createFrame(canvasId, { name: 'b' }, user)!
    const frames = actions.restackFrames(
      canvasId,
      [
        { id: b.id, z: 0 },
        { id: a.id, z: 1 },
      ],
      user,
    )
    expect(frames?.map((f) => f.z)).toEqual([0, 1])
    expect(order()).toEqual(['b', 'a'])
  })

  it('writes nothing when one frame is missing or on another canvas', () => {
    const a = actions.createFrame(canvasId, { name: 'a' }, user)!
    actions.createFrame(canvasId, { name: 'b' }, user)
    const elsewhere = actions.createFrame(store.createCanvas('other', 'kevin').id, { name: 'x' }, user)!
    const z = a.z
    expect(
      actions.restackFrames(
        canvasId,
        [
          { id: a.id, z: 99 },
          { id: 'gone', z: 0 },
        ],
        user,
      ),
    ).toBeUndefined()
    expect(
      actions.restackFrames(
        canvasId,
        [
          { id: a.id, z: 99 },
          { id: elsewhere.id, z: 0 },
        ],
        user,
      ),
    ).toBeUndefined()
    expect(store.getFrame(a.id)?.z).toBe(z)
    expect(order()).toEqual(['a', 'b'])
  })

  it('keeps an explicit z when a frame changes page (undoing a page move)', () => {
    const canvas = store.getCanvas(canvasId)!
    store.setPages(canvasId, [...(canvas.pages ?? []), { id: 'p2', name: 'Page 2' }])
    const a = actions.createFrame(canvasId, { name: 'a', z: 5 }, user)!
    actions.createFrame(canvasId, { name: 'b', z: 10 }, user)
    actions.updateFrame(a.id, { pageId: 'p2' }, user)
    actions.updateFrame(a.id, { pageId: canvas.pages![0]!.id, z: 5 }, user)
    expect(store.getFrame(a.id)?.z).toBe(5)
    expect(order()).toEqual(['a', 'b'])
  })
})
