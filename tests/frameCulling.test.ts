// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { Frame } from '../shared/types'
import { KEEP_MARGIN, LIVE_MARGIN, liveFrameIds } from '../src/lib/frameCulling'

const stage = { width: 1000, height: 800 }
const frame = (id: string, x: number, y: number, size = 400, html = '<p>page</p>'): Frame => ({
  id,
  canvasId: 'c',
  name: id,
  x,
  y,
  width: size,
  height: size,
  html,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'test',
})
const cull = (
  frames: Frame[],
  options: { zoom?: number; x?: number; y?: number; pinned?: string[]; live?: string[]; stage?: typeof stage } = {},
) =>
  [
    ...liveFrameIds(frames, {
      viewport: { x: options.x ?? 0, y: options.y ?? 0, zoom: options.zoom ?? 1 },
      stage: options.stage ?? stage,
      pinned: new Set(options.pinned),
      live: new Set(options.live ?? []),
    }),
  ].sort()

describe('liveFrameIds', () => {
  it('keeps the frames in view and those within the margin, and drops the rest', () => {
    const frames = [
      frame('in', 100, 100),
      frame('edge', 1000 + 0.4 * 1000, 0), // inside the entry margin
      frame('far', 10_000, 0),
      frame('above', 0, -5000),
    ]
    expect(cull(frames)).toEqual(['edge', 'in'])
  })

  it('follows the camera', () => {
    const frames = [frame('near', 0, 0), frame('far', 10_000, 0)]
    expect(cull(frames, { x: -10_000 })).toEqual(['far'])
  })

  it('reads the viewport at its zoom', () => {
    /* at 2x the stage shows 500 world px: 1200 is beyond the margin, 700 inside it */
    expect(cull([frame('a', 700, 0, 100), frame('b', 1200, 0, 100)], { zoom: 2 })).toEqual(['a'])
  })

  it('lets a live frame stay past the entry margin, as far as the keep margin', () => {
    const between = 1000 * (1 + (LIVE_MARGIN + KEEP_MARGIN) / 2)
    const frames = [frame('between', between, 0), frame('beyond', 1000 * (2 + KEEP_MARGIN), 0)]
    expect(cull(frames)).toEqual([])
    expect(cull(frames, { live: ['between', 'beyond'] })).toEqual(['between'])
  })

  it('keeps pinned frames wherever they are, hidden ones never', () => {
    const hidden = { ...frame('hidden', 0, 0), hidden: true }
    expect(cull([frame('selected', 90_000, 0), hidden], { pinned: ['selected', 'hidden'] })).toEqual(['selected'])
  })

  it('turns a frame too small to read into a placeholder when zoomed far out', () => {
    const frames = [frame('big', 0, 0, 1440), frame('small', 3000, 0, 400)]
    /* 1440 * 0.1 = 144px and 400 * 0.1 = 40px, both under the floor; the wide one is above it at 0.12 */
    expect(cull(frames, { zoom: 0.1, x: 0, stage: { width: 20_000, height: 20_000 } })).toEqual([])
    expect(cull(frames, { zoom: 0.12, stage: { width: 20_000, height: 20_000 } })).toEqual(['big'])
  })

  it('keeps small frames live at a zoom where they are still a design', () => {
    expect(cull([frame('button', 100, 100, 100)], { zoom: 0.5 })).toEqual(['button'])
  })

  it('never shrinks a standalone drawing to a placeholder', () => {
    const shape = frame('shape', 0, 0, 40, '<html><body data-doop-canvas-element="rect"></body></html>')
    expect(cull([shape], { zoom: 0.1 })).toEqual(['shape'])
  })

  it('has nothing live before the stage is measured, but pinned frames', () => {
    const frames = [frame('a', 0, 0), frame('b', 0, 0)]
    expect(cull(frames, { stage: { width: 0, height: 0 } })).toEqual([])
    expect(cull(frames, { stage: { width: 0, height: 0 }, pinned: ['b'] })).toEqual(['b'])
  })
})
