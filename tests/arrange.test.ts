import { describe, expect, it } from 'vitest'
import { alignBoxes, distributeEdges, distributeSpacing, packBoxes, tidyUp, type Box } from '../src/lib/actions/arrange'

const box = (x: number, y: number, width = 10, height = 10): Box => ({ x, y, width, height })

describe('alignBoxes', () => {
  const boxes = [box(0, 0, 10, 10), box(30, 20, 20, 40)]
  it('lines boxes up on an edge of their bounds', () => {
    expect(alignBoxes(boxes, 'left').map((s) => s.x)).toEqual([0, 0])
    expect(alignBoxes(boxes, 'right').map((s) => s.x)).toEqual([40, 30])
    expect(alignBoxes(boxes, 'bottom').map((s) => s.y)).toEqual([50, 20])
  })
  it('centres on the bounds', () => {
    expect(alignBoxes(boxes, 'hcenter').map((s) => s.x)).toEqual([20, 15])
    expect(alignBoxes(boxes, 'vcenter').map((s) => s.y)).toEqual([25, 10])
  })
  it('leaves the other axis alone', () => {
    expect(alignBoxes(boxes, 'left').map((s) => s.y)).toEqual([0, 20])
  })
})

describe('distribute', () => {
  it('evens the gaps, the outer boxes staying put', () => {
    const spots = distributeSpacing([box(0, 0, 10), box(100, 0, 10), box(15, 0, 30)], 'x')
    expect(spots.map((s) => s.x)).toEqual([0, 100, 40])
  })
  it('evens the centres', () => {
    const spots = distributeEdges([box(0, 0, 10), box(12, 0, 20), box(90, 0, 10)], 'x', 'center')
    expect(spots[1]!.x + 10).toBe(50)
  })
  it('does nothing for fewer than three', () => {
    expect(distributeSpacing([box(0, 0), box(50, 0)], 'x')).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ])
  })
})

describe('packBoxes', () => {
  it('abuts the boxes in order from the first', () => {
    expect(packBoxes([box(50, 0, 10), box(0, 0, 20), box(200, 0, 5)], 'x').map((s) => s.x)).toEqual([20, 0, 30])
  })
})

describe('tidyUp', () => {
  it('puts a messy row on an even grid', () => {
    const spots = tidyUp([box(0, 0, 100, 50), box(130, 5, 100, 50), box(270, -3, 100, 50)])
    expect(spots.map((s) => s.y)).toEqual([-3, -3, -3])
    const gap = spots[1]!.x - (spots[0]!.x + 100)
    expect(spots[2]!.x - (spots[1]!.x + 100)).toBe(gap)
  })
  it('keeps the rows it finds', () => {
    const spots = tidyUp([box(0, 0), box(40, 0), box(0, 40), box(40, 45)])
    expect(new Set(spots.map((s) => s.y)).size).toBe(2)
    expect(new Set(spots.map((s) => s.x)).size).toBe(2)
  })
})
