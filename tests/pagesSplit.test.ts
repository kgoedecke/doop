import { describe, expect, it } from 'vitest'
import { LAYERS_MIN_PX, PAGES_MIN_PX, clampPagesPx, pagesPxAfterKey, readPagesPct } from '../src/lib/pagesSplit'

describe('clampPagesPx', () => {
  it('holds the Pages section between its minimum and the room the Layers tree keeps', () => {
    expect(clampPagesPx(-500, 800)).toBe(PAGES_MIN_PX)
    expect(clampPagesPx(10_000, 800)).toBe(800 - LAYERS_MIN_PX)
    expect(clampPagesPx(300, 800)).toBe(300)
  })

  it('keeps one row of Pages in a rail too short to hold both lists', () => {
    expect(clampPagesPx(400, 200)).toBe(PAGES_MIN_PX)
  })
})

describe('pagesPxAfterKey', () => {
  it('moves the split one step per arrow press and stops at its limits', () => {
    expect(pagesPxAfterKey('ArrowDown', 300, 800)).toBe(310)
    expect(pagesPxAfterKey('ArrowUp', 300, 800)).toBe(290)
    expect(pagesPxAfterKey('ArrowUp', PAGES_MIN_PX, 800)).toBe(PAGES_MIN_PX)
  })

  it('takes Home and End to the two limits', () => {
    expect(pagesPxAfterKey('Home', 300, 800)).toBe(PAGES_MIN_PX)
    expect(pagesPxAfterKey('End', 300, 800)).toBe(800 - LAYERS_MIN_PX)
  })

  it('leaves every other key to the page', () => {
    expect(pagesPxAfterKey('a', 300, 800)).toBeUndefined()
  })
})

describe('readPagesPct', () => {
  it('keeps a stored split', () => {
    expect(readPagesPct('37.5')).toBe(37.5)
  })

  it('drops anything that is not a split of the rail, so a bad value falls back to the default', () => {
    expect(readPagesPct(null)).toBeNull()
    expect(readPagesPct('')).toBeNull()
    expect(readPagesPct('tall')).toBeNull()
    expect(readPagesPct('0')).toBeNull()
    expect(readPagesPct('100')).toBeNull()
  })
})
