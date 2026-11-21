import { describe, expect, it } from 'vitest'
import {
  LAYERS_MIN_PX,
  PAGES_BASE_MIN_PX,
  PAGES_MOVE_PICKER_PX,
  clampPagesPx,
  pagesMaxPx,
  pagesMinPx,
  pagesPxAfterKey,
  readPagesPct,
} from '../src/lib/pagesSplit'

describe('pagesMinPx', () => {
  it('reserves room for the move picker only while it is shown', () => {
    expect(pagesMinPx(false)).toBe(PAGES_BASE_MIN_PX)
    expect(pagesMinPx(true)).toBe(PAGES_BASE_MIN_PX + PAGES_MOVE_PICKER_PX)
  })
})

describe('clampPagesPx', () => {
  const min = pagesMinPx(false)

  it('holds the Pages section between its minimum and the room the Layers tree keeps', () => {
    expect(clampPagesPx(-500, 800, min)).toBe(min)
    expect(clampPagesPx(10_000, 800, min)).toBe(800 - LAYERS_MIN_PX)
    expect(clampPagesPx(300, 800, min)).toBe(300)
  })

  it('keeps the Pages minimum in a rail too short to hold both lists', () => {
    expect(clampPagesPx(400, 200, min)).toBe(min)
    expect(pagesMaxPx(200, min)).toBe(min)
  })

  it('lets a section without the picker go lower than one with it', () => {
    expect(clampPagesPx(0, 800, pagesMinPx(false))).toBeLessThan(clampPagesPx(0, 800, pagesMinPx(true)))
  })
})

describe('pagesPxAfterKey', () => {
  const min = pagesMinPx(true)

  it('moves the split one step per arrow press and stops at its limits', () => {
    expect(pagesPxAfterKey('ArrowDown', 300, 800, min)).toBe(310)
    expect(pagesPxAfterKey('ArrowUp', 300, 800, min)).toBe(290)
    expect(pagesPxAfterKey('ArrowUp', min, 800, min)).toBe(min)
  })

  it('takes Home and End to the two limits', () => {
    expect(pagesPxAfterKey('Home', 300, 800, min)).toBe(min)
    expect(pagesPxAfterKey('End', 300, 800, min)).toBe(800 - LAYERS_MIN_PX)
  })

  it('leaves every other key to the page', () => {
    expect(pagesPxAfterKey('a', 300, 800, min)).toBeUndefined()
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
