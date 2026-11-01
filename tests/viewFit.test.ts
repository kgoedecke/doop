import { describe, expect, it } from 'vitest'
import { FIT_PAD, NO_INSETS, fitBox } from '../src/lib/viewFit'

const stage = { width: 1600, height: 1000 }
const limits = { min: 0.08, max: 16 }
const box = { x: 100, y: 200, width: 400, height: 300 }

/** where the box lands on screen under a camera */
function onScreen(cam: { x: number; y: number; zoom: number }) {
  return {
    left: cam.x + box.x * cam.zoom,
    top: cam.y + box.y * cam.zoom,
    right: cam.x + (box.x + box.width) * cam.zoom,
    bottom: cam.y + (box.y + box.height) * cam.zoom,
  }
}

describe('fitBox', () => {
  it('fits and centres in the whole stage without insets', () => {
    const cam = fitBox(box, stage, NO_INSETS, limits)
    expect(cam.zoom).toBeCloseTo((1000 - FIT_PAD * 2) / 300)
    const r = onScreen(cam)
    expect((r.left + r.right) / 2).toBeCloseTo(800)
    expect((r.top + r.bottom) / 2).toBeCloseTo(500)
  })

  it('fits into the area the panels leave open and centres there', () => {
    const insets = { top: 50, right: 600, bottom: 0, left: 400 }
    const cam = fitBox(box, stage, insets, limits)
    /* 600px open across, 950 down: the width decides */
    expect(cam.zoom).toBeCloseTo((600 - FIT_PAD * 2) / 400)
    const r = onScreen(cam)
    expect(r.left).toBeCloseTo(400 + FIT_PAD)
    expect(r.right).toBeCloseTo(1000 - FIT_PAD)
    expect((r.top + r.bottom) / 2).toBeCloseTo(50 + 950 / 2)
  })

  it('caps the zoom at the limit', () => {
    const cam = fitBox({ x: 0, y: 0, width: 10, height: 10 }, stage, NO_INSETS, { min: 0.08, max: 1.25 })
    expect(cam.zoom).toBe(1.25)
  })

  it('falls back to the whole axis when the panels leave no room', () => {
    const insets = { top: 0, right: 900, bottom: 0, left: 600 }
    const cam = fitBox(box, stage, insets, limits)
    const r = onScreen(cam)
    expect((r.left + r.right) / 2).toBeCloseTo(800)
  })
})
