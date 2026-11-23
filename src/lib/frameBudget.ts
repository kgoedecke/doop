import type { WorldBox } from './viewFit'
import { FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY } from './layoutZoom'

export interface FrameBounds extends WorldBox {
  id: string
}

export interface CameraView {
  x: number
  y: number
  zoom: number
}

export interface FrameMountPolicy {
  margin: number
  maxCount: number
  maxCssPixels: number
  /** the box around every mounted frame: the scaled world's own GPU layer
   *  spans it, and mobile Safari backs that layer whole once zoomed out */
  maxUnionPixels: number
  overviewZoom: number
}

const MOBILE_MAX_COUNT = 6
const MOBILE_HI_DPI_CSS_PIXELS = 6_000_000
const MOBILE_CSS_PIXELS = 12_000_000
const MOBILE_HI_DPI_UNION_PIXELS = 8_000_000
const MOBILE_UNION_PIXELS = 16_000_000
const MOBILE_OVERVIEW_ZOOM = 0.18

const WEBKIT_MAX_COUNT = 24
const WEBKIT_HI_DPI_CSS_PIXELS = 40_000_000
const WEBKIT_CSS_PIXELS = 80_000_000
const WEBKIT_OVERVIEW_ZOOM = 0.12

const CHROMIUM_MAX_COUNT = 64
const CHROMIUM_CSS_PIXELS = 180_000_000

const MOBILE_WEBKIT_LAYOUT_DEVICE_PIXELS = 80_000_000
const DESKTOP_WEBKIT_LAYOUT_DEVICE_PIXELS = 240_000_000
const MOBILE_WEBKIT_MAX_LAYOUT_ZOOM = 4

export function frameMountPolicy(opts: { isMobile: boolean; density?: boolean; dpr?: number }): FrameMountPolicy {
  const density = opts.density ?? FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY
  const dpr = Math.max(1, opts.dpr ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
  if (opts.isMobile) {
    return {
      margin: 0.08,
      maxCount: MOBILE_MAX_COUNT,
      maxCssPixels: dpr >= 2.5 ? MOBILE_HI_DPI_CSS_PIXELS : MOBILE_CSS_PIXELS,
      maxUnionPixels: dpr >= 2.5 ? MOBILE_HI_DPI_UNION_PIXELS : MOBILE_UNION_PIXELS,
      overviewZoom: MOBILE_OVERVIEW_ZOOM,
    }
  }
  if (!density) {
    return {
      margin: 0.5,
      maxCount: WEBKIT_MAX_COUNT,
      maxCssPixels: dpr >= 2 ? WEBKIT_HI_DPI_CSS_PIXELS : WEBKIT_CSS_PIXELS,
      maxUnionPixels: Infinity,
      overviewZoom: WEBKIT_OVERVIEW_ZOOM,
    }
  }
  return {
    margin: 0.75,
    maxCount: CHROMIUM_MAX_COUNT,
    maxCssPixels: CHROMIUM_CSS_PIXELS,
    maxUnionPixels: Infinity,
    overviewZoom: 0,
  }
}

function frameArea(frame: WorldBox): number {
  return Math.max(1, frame.width) * Math.max(1, frame.height)
}

function centerDistanceSq(frame: WorldBox, cx: number, cy: number): number {
  const dx = frame.x + frame.width / 2 - cx
  const dy = frame.y + frame.height / 2 - cy
  return dx * dx + dy * dy
}

export function selectMountedFrames(
  frames: readonly FrameBounds[],
  viewport: CameraView,
  stage: { width: number; height: number },
  priorityIds: ReadonlySet<string>,
  policy: FrameMountPolicy,
): Set<string> {
  const mounted = new Set<string>()
  if (!frames.length) return mounted

  if (stage.width <= 0 || stage.height <= 0) {
    let used = 0
    for (const f of frames) {
      const area = frameArea(f)
      if (mounted.size > 0 && (mounted.size >= policy.maxCount || used + area > policy.maxCssPixels)) continue
      mounted.add(f.id)
      used += area
    }
    return mounted
  }

  const zoom = Math.max(viewport.zoom, 0.01)
  const screenLeft = -viewport.x / zoom
  const screenTop = -viewport.y / zoom
  const screenRight = (stage.width - viewport.x) / zoom
  const screenBottom = (stage.height - viewport.y) / zoom
  const padX = (stage.width * policy.margin) / zoom
  const padY = (stage.height * policy.margin) / zoom
  const left = screenLeft - padX
  const top = screenTop - padY
  const right = screenRight + padX
  const bottom = screenBottom + padY
  const viewCenterX = (stage.width / 2 - viewport.x) / zoom
  const viewCenterY = (stage.height / 2 - viewport.y) / zoom

  const priorityOnScreen: FrameBounds[] = []
  const onScreen: FrameBounds[] = []
  const inMargin: FrameBounds[] = []
  let visibleTotalPixels = 0

  for (const f of frames) {
    const inView = f.x + f.width >= left && f.x <= right && f.y + f.height >= top && f.y <= bottom
    if (!inView) continue
    visibleTotalPixels += frameArea(f)
    const touchesScreen =
      f.x + f.width >= screenLeft && f.x <= screenRight && f.y + f.height >= screenTop && f.y <= screenBottom
    if (touchesScreen && priorityIds.has(f.id)) priorityOnScreen.push(f)
    else if (touchesScreen) onScreen.push(f)
    else inMargin.push(f)
  }

  const deferOverview =
    policy.overviewZoom > 0 && viewport.zoom < policy.overviewZoom && visibleTotalPixels > policy.maxCssPixels
  if (deferOverview) return mounted

  const byCenter = (a: FrameBounds, b: FrameBounds) =>
    centerDistanceSq(a, viewCenterX, viewCenterY) - centerDistanceSq(b, viewCenterX, viewCenterY)
  priorityOnScreen.sort(byCenter)
  onScreen.sort(byCenter)
  inMargin.sort(byCenter)

  let usedPixels = 0
  let union: { left: number; top: number; right: number; bottom: number } | null = null
  const tryMount = (frame: FrameBounds) => {
    const area = frameArea(frame)
    if (mounted.size >= policy.maxCount) return
    if (mounted.size > 0 && usedPixels + area > policy.maxCssPixels) return
    const next = union
      ? {
          left: Math.min(union.left, frame.x),
          top: Math.min(union.top, frame.y),
          right: Math.max(union.right, frame.x + frame.width),
          bottom: Math.max(union.bottom, frame.y + frame.height),
        }
      : { left: frame.x, top: frame.y, right: frame.x + frame.width, bottom: frame.y + frame.height }
    if (mounted.size > 0 && (next.right - next.left) * (next.bottom - next.top) > policy.maxUnionPixels) return
    mounted.add(frame.id)
    usedPixels += area
    union = next
  }

  for (const f of priorityOnScreen) tryMount(f)
  for (const f of onScreen) tryMount(f)
  for (const f of inMargin) tryMount(f)

  return mounted
}

export function sameFrameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) {
    if (!b.has(id)) return false
  }
  return true
}

export function safeMaxLayoutZoom(
  mountedFrames: readonly WorldBox[],
  opts: {
    maxZoom: number
    density?: boolean
    dpr?: number
    isMobile: boolean
  },
): number {
  const density = opts.density ?? FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY
  if (density) return opts.maxZoom

  const hardCap = opts.isMobile ? Math.min(opts.maxZoom, MOBILE_WEBKIT_MAX_LAYOUT_ZOOM) : opts.maxZoom
  let largestArea = 0
  for (const f of mountedFrames) {
    const area = frameArea(f)
    if (area > largestArea) largestArea = area
  }
  if (largestArea <= 0) return hardCap

  const dpr = Math.max(1, opts.dpr ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
  const budget = opts.isMobile ? MOBILE_WEBKIT_LAYOUT_DEVICE_PIXELS : DESKTOP_WEBKIT_LAYOUT_DEVICE_PIXELS
  const ratio = budget / (largestArea * dpr * dpr)
  if (ratio <= 1) return 1
  return Math.min(hardCap, Math.max(1, Math.sqrt(ratio)))
}
