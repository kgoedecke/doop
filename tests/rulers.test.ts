import { describe, expect, it } from 'vitest'
import { RULER_LABEL_PX, boundsOf, formatRulerValue, minorStep, rulerStep, rulerTicks } from '../src/lib/rulers'

describe('rulerStep', () => {
  it('picks the smallest 1/2/5 step whose labels sit far enough apart', () => {
    expect(rulerStep(1)).toBe(100)
    expect(rulerStep(2)).toBe(50)
    expect(rulerStep(3)).toBe(20)
    expect(rulerStep(0.5)).toBe(200)
    expect(rulerStep(0.25)).toBe(500)
    expect(rulerStep(0.08)).toBe(1000)
    for (const zoom of [0.08, 0.13, 0.4, 0.77, 1, 1.6, 2.4, 3]) {
      const step = rulerStep(zoom)
      expect(step * zoom).toBeGreaterThanOrEqual(RULER_LABEL_PX)
      const mantissa = step / 10 ** Math.floor(Math.log10(step))
      expect([1, 2, 5]).toContain(Math.round(mantissa))
    }
  })

  it('never labels finer than one world px', () => {
    expect(rulerStep(100)).toBe(1)
    expect(rulerStep(Infinity)).toBe(1)
  })

  it('takes a custom spacing', () => {
    expect(rulerStep(1, 10)).toBe(10)
    expect(rulerStep(1, 11)).toBe(20)
  })
})

describe('minorStep', () => {
  it('splits 1-steps in tenths, 2-steps in quarters and 5-steps in fifths', () => {
    expect(minorStep(100, 1)).toBe(10)
    expect(minorStep(20, 3)).toBe(5)
    expect(minorStep(50, 2)).toBe(10)
  })

  it('falls back to halves, then to nothing, when ticks would crowd', () => {
    expect(minorStep(100, 0.3)).toBe(50)
    expect(minorStep(100, 0.05)).toBeUndefined()
    /* never between whole px */
    expect(minorStep(1, 100)).toBeUndefined()
  })
})

describe('rulerTicks', () => {
  it('labels every step in range and puts minor ticks between them', () => {
    const ticks = rulerTicks(-150, 250, 1)
    expect(ticks.step).toBe(100)
    expect(ticks.major).toEqual([-100, 0, 100, 200])
    expect(ticks.minor).toHaveLength(37)
    expect(ticks.minor).not.toContain(100)
    expect(ticks.minor[0]).toBe(-150)
    expect(ticks.minor.at(-1)).toBe(250)
  })

  it('handles a range that starts on a step', () => {
    expect(rulerTicks(0, 200, 0.5).major).toEqual([0, 200])
  })
})

describe('formatRulerValue', () => {
  it('prints whole px without a negative zero', () => {
    expect(formatRulerValue(12.4)).toBe('12')
    expect(formatRulerValue(-0.2)).toBe('0')
    expect(formatRulerValue(-40)).toBe('-40')
  })
})

describe('boundsOf', () => {
  it('fits every box, or none', () => {
    expect(boundsOf([])).toBeNull()
    expect(
      boundsOf([
        { x: 10, y: 20, width: 100, height: 50 },
        { x: -30, y: 40, width: 20, height: 100 },
      ]),
    ).toEqual({ x: -30, y: 20, width: 140, height: 120 })
  })
})
