import { describe, expect, it } from 'vitest'
import { derotateDelta, selectionBox } from '../src/lib/elementRotate'

const rect = { x: 100, y: 50, width: 200, height: 100 }

describe('selectionBox', () => {
  it('is the bounds themselves on an unturned element', () => {
    expect(selectionBox(rect)).toEqual({ left: 100, top: 50, width: 200, height: 100 })
    expect(selectionBox(rect, 0, { width: 150, height: 80 })).toEqual({ left: 100, top: 50, width: 200, height: 100 })
  })
  it('centres the unturned box on the bounds and turns it', () => {
    expect(selectionBox({ x: 0, y: 0, width: 141.42, height: 141.42 }, 45, { width: 100, height: 100 })).toEqual({
      left: 70.71,
      top: 70.71,
      width: 100,
      height: 100,
      transform: 'translate(-50%, -50%) rotate(45deg)',
    })
  })
})

describe('derotateDelta', () => {
  it('leaves an unturned element alone', () => {
    expect(derotateDelta({ dx: 10, dy: 4 }, 0)).toEqual({ dx: 10, dy: 4 })
  })
  it("turns the travel into the element's own axes", () => {
    const d = derotateDelta({ dx: 0, dy: 10 }, 90)
    expect(d.dx).toBeCloseTo(10)
    expect(d.dy).toBeCloseTo(0)
    const e = derotateDelta({ dx: 10, dy: 0 }, -90)
    expect(e.dx).toBeCloseTo(0)
    expect(e.dy).toBeCloseTo(10)
  })
})
