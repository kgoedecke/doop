import { describe, expect, it } from 'vitest'
import { formatDistance, lineLength, measureBetween } from '../src/lib/measure'

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('measureBetween', () => {
  it('measures a box inside another to each matching edge, through its own middle', () => {
    const { lines, guides } = measureBetween(rect(20, 30, 100, 40), rect(0, 0, 200, 100))
    expect(guides).toEqual([])
    expect(lines).toEqual([
      { axis: 'x', from: 0, to: 20, at: 50 },
      { axis: 'x', from: 120, to: 200, at: 50 },
      { axis: 'y', from: 0, to: 30, at: 70 },
      { axis: 'y', from: 70, to: 100, at: 70 },
    ])
  })

  it('gives the same distances whichever of the two is selected', () => {
    const inner = rect(20, 30, 100, 40)
    const outer = rect(0, 0, 200, 100)
    expect(measureBetween(outer, inner)).toEqual(measureBetween(inner, outer))
  })

  it('leaves out an edge that already meets the other', () => {
    const { lines } = measureBetween(rect(0, 10, 50, 20), rect(0, 0, 200, 100))
    expect(lines.map((l) => [l.axis, lineLength(l)])).toEqual([
      ['x', 150],
      ['y', 10],
      ['y', 70],
    ])
  })

  it('measures the gap to a box beside it, through what the two share', () => {
    expect(measureBetween(rect(0, 0, 100, 100), rect(140, 50, 60, 100))).toEqual({
      lines: [{ axis: 'x', from: 100, to: 140, at: 75 }],
      guides: [],
    })
    expect(measureBetween(rect(140, 50, 60, 100), rect(0, 0, 100, 100)).lines).toEqual([
      { axis: 'x', from: 100, to: 140, at: 75 },
    ])
  })

  it('measures only the gap to a box below it, not their offset', () => {
    expect(measureBetween(rect(0, 0, 100, 40), rect(30, 100, 100, 40)).lines).toEqual([
      { axis: 'y', from: 40, to: 100, at: 65 },
    ])
  })

  it('carries a diagonal box’s edges out to the lines', () => {
    expect(measureBetween(rect(0, 0, 100, 100), rect(150, 200, 50, 50))).toEqual({
      lines: [
        { axis: 'x', from: 100, to: 150, at: 50 },
        { axis: 'y', from: 100, to: 200, at: 50 },
      ],
      guides: [
        { axis: 'y', from: 50, to: 200, at: 150 },
        { axis: 'x', from: 50, to: 150, at: 200 },
      ],
    })
  })

  it('measures up and left as well', () => {
    const { lines, guides } = measureBetween(rect(150, 200, 50, 50), rect(0, 0, 100, 100))
    expect(lines).toEqual([
      { axis: 'x', from: 100, to: 150, at: 225 },
      { axis: 'y', from: 100, to: 200, at: 175 },
    ])
    expect(guides).toEqual([
      { axis: 'y', from: 100, to: 225, at: 100 },
      { axis: 'x', from: 100, to: 175, at: 100 },
    ])
  })

  it('shows nothing between boxes that touch', () => {
    expect(measureBetween(rect(0, 0, 100, 100), rect(100, 0, 50, 100)).lines).toEqual([])
  })
})

describe('formatDistance', () => {
  it('keeps at most two decimals and none it does not need', () => {
    expect(formatDistance(12)).toBe('12')
    expect(formatDistance(5.836)).toBe('5.84')
    expect(formatDistance(1.5)).toBe('1.5')
  })
})
