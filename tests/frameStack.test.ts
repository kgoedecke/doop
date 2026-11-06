import { describe, expect, it } from 'vitest'
import { frontOf, restack, roomAt, sortByStack, stackOf, zAt } from '../shared/frameStack'

const f = (id: string, createdAt: number, z?: number) => ({ id, createdAt, ...(z === undefined ? {} : { z }) })
const ids = (frames: { id: string }[]) => frames.map((frame) => frame.id)

/* apply restack's writes and read the order back */
function moved(frames: ReturnType<typeof f>[], id: string, index: number) {
  const writes = restack(frames, id, index)
  const next = frames.map((frame) => ({ ...frame, z: writes.find((w) => w.id === frame.id)?.z ?? frame.z }))
  return { writes, order: ids(sortByStack(next)) }
}

describe('frame stacking', () => {
  it('stacks a frame without z by its creation time', () => {
    expect(stackOf(f('a', 5))).toBe(5)
    expect(stackOf(f('a', 5, -2))).toBe(-2)
    expect(ids(sortByStack([f('b', 2), f('a', 1), f('c', 3, 0)]))).toEqual(['c', 'a', 'b'])
  })

  it('keeps the order frames came in when they tie', () => {
    expect(ids(sortByStack([f('b', 0), f('a', 0)]))).toEqual(['b', 'a'])
  })

  it('puts a new frame in front of the page', () => {
    expect(frontOf([f('a', 1), f('b', 2, 10)])).toBe(11)
    expect(frontOf([])).toBeUndefined()
  })

  it('finds the z between two neighbours, in front or behind', () => {
    const frames = [f('a', 0, 0), f('b', 0, 1)]
    expect(zAt(frames, 0)).toBe(-1)
    expect(zAt(frames, 1)).toBe(0.5)
    expect(zAt(frames, 2)).toBe(2)
    expect(zAt([], 0)).toBeUndefined()
  })

  it('moves a frame with one write', () => {
    const frames = [f('a', 1), f('b', 2), f('c', 3)]
    expect(moved(frames, 'c', 0)).toEqual({ writes: [{ id: 'c', z: 0 }], order: ['c', 'a', 'b'] })
    expect(moved(frames, 'a', 2)).toEqual({ writes: [{ id: 'a', z: 4 }], order: ['b', 'c', 'a'] })
    expect(moved(frames, 'a', 1)).toEqual({ writes: [{ id: 'a', z: 2.5 }], order: ['b', 'a', 'c'] })
  })

  it('writes nothing for a frame already in place', () => {
    expect(restack([f('a', 1), f('b', 2)], 'b', 1)).toEqual([])
    expect(restack([f('a', 1), f('b', 2)], 'gone', 0)).toEqual([])
  })

  it('renumbers the page when the neighbours leave no room', () => {
    const lo = 1_700_000_000_000
    /* the next double after lo: nothing fits between them */
    const hi = lo + 2 ** -12
    const frames = [f('a', 0, lo), f('b', 0, hi), f('c', 0, hi + 1)]
    const { writes, order } = moved(frames, 'c', 1)
    expect(order).toEqual(['a', 'c', 'b'])
    expect(writes).toEqual([
      { id: 'a', z: 0 },
      { id: 'c', z: 1 },
      { id: 'b', z: 2 },
    ])
  })

  it('makes room for a new frame where its neighbours leave none', () => {
    expect(roomAt([f('a', 0, 0), f('b', 0, 1)], 1)).toEqual({ z: 0.5, renumber: [] })
    const lo = 1_700_000_000_000
    const room = roomAt([f('a', 0, lo), f('b', 0, lo + 2 ** -12)], 1)
    expect(room).toEqual({
      z: 0.5,
      renumber: [
        { id: 'a', z: 0 },
        { id: 'b', z: 1 },
      ],
    })
    expect(roomAt([], 0)).toEqual({ z: undefined, renumber: [] })
  })
})
