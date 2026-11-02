import { describe, expect, it } from 'vitest'
import { COMPOSER_GAP, COMPOSER_WIDTH, placeComposer } from '../src/lib/composerPlacement'

/**
 * The canvas-comment composer hangs off its pin: to the right when that
 * fits, else to the left, else on the roomier side slid back onto the stage
 * so a 240px box never starts at a negative x on a phone-width stage.
 */

const span = (x: number, p: ReturnType<typeof placeComposer>) =>
  p.side === 'right'
    ? [x + COMPOSER_GAP + p.shift, x + COMPOSER_GAP + COMPOSER_WIDTH + p.shift]
    : [x - COMPOSER_GAP - COMPOSER_WIDTH + p.shift, x - COMPOSER_GAP + p.shift]

describe('placeComposer', () => {
  it('prefers the right of the pin when it fits', () => {
    expect(placeComposer(300, 0, 1400)).toEqual({ side: 'right', shift: 0 })
  })

  it('flips left when the right would run off the stage or under the side panel', () => {
    expect(placeComposer(1080, 0, 1400 - 312)).toEqual({ side: 'left', shift: 0 })
    expect(placeComposer(1300, 0, 1400)).toEqual({ side: 'left', shift: 0 })
  })

  it('on a narrow stage takes the roomier side and slides the box inside the edges', () => {
    /* a 375px stage, pin at 150: more room on the right, but not enough */
    const narrow = placeComposer(150, 0, 375)
    expect(narrow.side).toBe('right')
    const [l, r] = span(150, narrow)
    expect(l).toBeGreaterThanOrEqual(0)
    expect(r).toBeLessThanOrEqual(375)
    /* pin near the right edge: the left side has more room, still too little */
    const tight = placeComposer(300, 0, 375)
    expect(tight.side).toBe('left')
    const [tl, tr] = span(300, tight)
    expect(tl).toBeGreaterThanOrEqual(0)
    expect(tr).toBeLessThanOrEqual(375)
  })

  it('never slides the box off the far edge when the stage is narrower than the box', () => {
    const tiny = placeComposer(100, 0, 200)
    const [l] = span(100, tiny)
    expect(l).toBeGreaterThanOrEqual(0)
  })
})
