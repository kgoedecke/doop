import { describe, expect, it } from 'vitest'
import { presentationScale, presentationZoomLimits, zoomedScroll } from '../src/lib/presentationView'

const stage = { width: 1200, height: 800 }
const tall = { width: 1440, height: 3600 }

describe('presentation viewing geometry', () => {
  it('fits the whole tall page or its width without changing its design viewport', () => {
    expect(presentationScale('fit', 1, stage, tall)).toBeCloseTo(800 / 3600)
    expect(presentationScale('width', 1, stage, tall)).toBeCloseTo(1200 / 1440)
    expect(presentationScale('custom', 1, stage, tall)).toBe(1)
  })

  it('adapts fit modes to rotation while keeping manual zoom unchanged', () => {
    const portrait = { width: 390, height: 700 }
    expect(presentationScale('fit', 1, portrait, tall)).toBeCloseTo(700 / 3600)
    expect(presentationScale('width', 1, portrait, tall)).toBeCloseTo(390 / 1440)
    expect(presentationScale('custom', 1.5, portrait, tall)).toBe(1.5)
  })

  it('allows stepping out of automatic fit even beyond the normal zoom limits', () => {
    expect(presentationZoomLimits(stage, { width: 100, height: 100 }).max).toBe(12)
    expect(presentationZoomLimits(stage, { width: 20000, height: 20000 }).min).toBe(0.04)
  })

  it('keeps the design point beneath the cursor when zooming a scrolled page', () => {
    // The cursor is over design y=700 before zoom, and y=1400 afterwards.
    expect(zoomedScroll(400, 300, 800, 3600, 1, 2)).toBe(1100)
  })

  it('accounts for centred letterboxing when zooming into an overflowing frame', () => {
    expect(zoomedScroll(0, 600, 1200, 1440, 0.5, 1)).toBe(120)
    expect(zoomedScroll(120, 600, 1200, 1440, 1, 0.5)).toBe(0)
  })

  it('clamps panning to the edges without leaving blank space', () => {
    expect(zoomedScroll(0, 50, 1200, 1440, 0.5, 1)).toBe(0)
    expect(zoomedScroll(240, 1200, 1200, 1440, 1, 2)).toBe(1680)
  })
})
