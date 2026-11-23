import { describe, expect, it } from 'vitest'
import {
  frameMountPolicy,
  safeMaxLayoutZoom,
  sameFrameIdSet,
  selectMountedFrames,
  type FrameBounds,
} from '../src/lib/frameBudget'

function makeChartRow(): FrameBounds[] {
  const heights = [2500, 7950, 10250, 6700, 5914, 6250, 16000, 9180, 12520, 13760, 21570, 11760, 12260, 8780, 8180]
  return heights.map((height, i) => ({
    id: `chart-${i}`,
    x: i * 1600,
    y: 120,
    width: 1440,
    height,
  }))
}

function makeComponentGrid(count: number): FrameBounds[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `comp-${i}`,
    x: (i % 10) * 320,
    y: Math.floor(i / 10) * 240,
    width: 240,
    height: 160,
  }))
}

describe('frameBudget', () => {
  it('defers all giant frames when zoomed out to an overview on mobile', () => {
    const frames = makeChartRow()
    const policy = frameMountPolicy({ isMobile: true, density: false, dpr: 3 })
    const mounted = selectMountedFrames(
      frames,
      { x: 20, y: 80, zoom: 0.08 },
      { width: 420, height: 746 },
      new Set(),
      policy,
    )
    expect(mounted.size).toBe(0)
  })

  it('mounts only the single focused giant frame even when its area exceeds the pixel budget', () => {
    const frames = makeChartRow()
    const table = frames[10]!
    const policy = frameMountPolicy({ isMobile: true, density: false, dpr: 3 })
    const vp = { x: 16 - table.x * 0.27, y: 120 - table.y * 0.27, zoom: 0.27 }
    const mounted = selectMountedFrames(frames, vp, { width: 420, height: 746 }, new Set([table.id]), policy)
    expect([...mounted]).toEqual([table.id])
  })

  it('unmounts an off-screen priority frame when the user pans to another frame', () => {
    const frames = makeChartRow()
    const table = frames[10]!
    const radar = frames[11]!
    const policy = frameMountPolicy({ isMobile: true, density: false, dpr: 3 })
    const vp = { x: 16 - radar.x * 0.27, y: 120 - radar.y * 0.27, zoom: 0.27 }
    const mounted = selectMountedFrames(frames, vp, { width: 420, height: 746 }, new Set([table.id]), policy)
    expect(mounted.has(table.id)).toBe(false)
    expect(mounted.has(radar.id)).toBe(true)
  })

  it('culls off-screen component frames and caps live iframes on huge component pages', () => {
    const frames = makeComponentGrid(157)
    const mobilePolicy = frameMountPolicy({ isMobile: true, density: false, dpr: 3 })
    const mountedMobile = selectMountedFrames(
      frames,
      { x: 0, y: 0, zoom: 1 },
      { width: 420, height: 746 },
      new Set(),
      mobilePolicy,
    )
    expect(mountedMobile.size).toBeGreaterThan(0)
    expect(mountedMobile.size).toBeLessThanOrEqual(mobilePolicy.maxCount)

    const webkitPolicy = frameMountPolicy({ isMobile: false, density: false, dpr: 2 })
    const mountedWebkit = selectMountedFrames(
      frames,
      { x: 0, y: 0, zoom: 0.5 },
      { width: 1280, height: 800 },
      new Set(),
      webkitPolicy,
    )
    expect(mountedWebkit.size).toBeLessThanOrEqual(webkitPolicy.maxCount)
  })

  it('keeps layoutZoom uncapped on Chromium density path and caps tall frames on mobile WebKit', () => {
    const table = { x: 0, y: 0, width: 1440, height: 21570 }
    const cover = { x: 0, y: 0, width: 1440, height: 1420 }
    const button = { x: 0, y: 0, width: 200, height: 80 }

    expect(safeMaxLayoutZoom([table], { maxZoom: 16, density: true, dpr: 3, isMobile: true })).toBe(16)
    expect(safeMaxLayoutZoom([table], { maxZoom: 16, density: false, dpr: 3, isMobile: true })).toBe(1)

    const coverCap = safeMaxLayoutZoom([cover], { maxZoom: 16, density: false, dpr: 3, isMobile: true })
    expect(coverCap).toBeGreaterThan(1.5)
    expect(coverCap).toBeLessThanOrEqual(4)

    expect(safeMaxLayoutZoom([button], { maxZoom: 16, density: false, dpr: 3, isMobile: true })).toBe(4)
  })

  it('compares frame id sets accurately', () => {
    expect(sameFrameIdSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(sameFrameIdSet(new Set(['a']), new Set(['a', 'b']))).toBe(false)
    expect(sameFrameIdSet(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false)
  })
})
