import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import type { Frame } from '../../shared/types'
import { isCanvasElement } from './drawing'
import { useStore, type Viewport } from './store'

/* Every frame is a document in an iframe of its own, so a page of a hundred
   frames is a hundred browsing contexts however much of it is on screen. The
   Stage keeps live only the frames a person can see; the rest stand in as
   placeholders of the same size and swap back when the camera reaches them.
   `FrameView` does the swapping; this decides which frames are live. */

/** How far past the stage's edge a frame goes live, as a share of the stage's
 *  size on each side: a pan reveals a running frame, not a placeholder. */
export const LIVE_MARGIN = 0.5
/** How far past it a live frame stays live. Wider than `LIVE_MARGIN`, so a frame
 *  at the border is not unmounted and reloaded by every nudge of the camera. */
export const KEEP_MARGIN = 1
/** Zoomed out below this, a frame whose longest side is under `MIN_LIVE_PX` on
 *  screen is a placeholder: at that size a document is a smudge, and the
 *  overview of a big page is exactly where all of them are on screen at once. */
export const MIN_LIVE_ZOOM = 0.25
export const MIN_LIVE_PX = 160

export interface StageSize {
  width: number
  height: number
}

export interface CullInput {
  viewport: Viewport
  /** the stage's box; until it is measured (zero) only pinned frames are live */
  stage: StageSize
  /** frames that stay live wherever they are: selected, streamed into, edited by a peer */
  pinned: ReadonlySet<string>
  /** the frames live now, which get the wider `KEEP_MARGIN` */
  live: ReadonlySet<string>
}

/* a standalone drawing is a transparent shape, not a page: shrunk to a
   placeholder it would vanish, so it is never culled for being small */
const standalone = new WeakMap<Frame, boolean>()
function isStandalone(frame: Frame): boolean {
  let known = standalone.get(frame)
  if (known === undefined) standalone.set(frame, (known = isCanvasElement(frame.html)))
  return known
}

/** The ids of `frames` that get a live document under `input`. */
export function liveFrameIds(frames: readonly Frame[], { viewport, stage, pinned, live }: CullInput): Set<string> {
  const measured = stage.width > 0 && stage.height > 0
  const { x, y, zoom } = viewport
  /* the world rectangle `margin` stage-sizes beyond the stage on every side */
  const reach = (margin: number) => ({
    left: (-x - stage.width * margin) / zoom,
    right: (stage.width * (1 + margin) - x) / zoom,
    top: (-y - stage.height * margin) / zoom,
    bottom: (stage.height * (1 + margin) - y) / zoom,
  })
  const enter = reach(LIVE_MARGIN)
  const keep = reach(KEEP_MARGIN)
  const small = zoom < MIN_LIVE_ZOOM
  const next = new Set<string>()
  for (const f of frames) {
    if (f.hidden) continue
    if (pinned.has(f.id)) {
      next.add(f.id)
      continue
    }
    if (!measured) continue
    const box = live.has(f.id) ? keep : enter
    if (f.x > box.right || f.x + f.width < box.left || f.y > box.bottom || f.y + f.height < box.top) continue
    if (small && Math.max(f.width, f.height) * zoom < MIN_LIVE_PX && !isStandalone(f)) continue
    next.add(f.id)
  }
  return next
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

const NONE: ReadonlySet<string> = new Set()

/* The live set as an external store. The camera never renders a component
   (Stage writes the world transform straight to the DOM), so the set is
   recomputed on every store change and a subscriber hears of it only when the
   set itself differs. */
class LiveFrames {
  private frames: readonly Frame[] = []
  private size: StageSize = { width: 0, height: 0 }
  private snapshot: ReadonlySet<string> = NONE
  private listeners = new Set<() => void>()
  private unwatch: (() => void) | null = null

  constructor(private stage: RefObject<HTMLElement | null>) {}

  setFrames(frames: readonly Frame[]) {
    this.frames = frames
    this.update()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.watch()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.unwatch?.()
        this.unwatch = null
      }
    }
  }

  getSnapshot = (): ReadonlySet<string> => this.snapshot

  /* subscriptions start once the tree is committed, which is when the stage
     element exists to be measured */
  private watch() {
    const stopStore = useStore.subscribe(() => this.update())
    const element = this.stage.current
    const resize = new ResizeObserver(() => {
      this.measure(element)
      this.update()
    })
    if (element) resize.observe(element)
    this.measure(element)
    this.update()
    this.unwatch = () => {
      stopStore()
      resize.disconnect()
    }
  }

  /* measured on resize, not per update: reading a size on every store
     change would force a layout each time a peer's cursor moves */
  private measure(element: HTMLElement | null) {
    this.size = { width: element?.clientWidth ?? 0, height: element?.clientHeight ?? 0 }
  }

  private update() {
    const s = useStore.getState()
    /* prototype mode draws its connectors from the documents' own hotspots */
    const pinned = new Set<string>(s.prototypeMode ? this.frames.map((f) => f.id) : s.selectedIds)
    if (s.selectedElement) pinned.add(s.selectedElement.frameId)
    if (s.ctxMenu) pinned.add(s.ctxMenu.frameId)
    for (const id of Object.keys(s.streams)) pinned.add(id)
    for (const p of Object.values(s.presences)) if (p.activeFrameId) pinned.add(p.activeFrameId)
    const next = liveFrameIds(this.frames, { viewport: s.viewport, stage: this.size, pinned, live: this.snapshot })
    if (sameIds(next, this.snapshot)) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/** The ids of `frames` that should be live right now. `stage` is the element
 *  the camera looks through. */
export function useLiveFrameIds(frames: readonly Frame[], stage: RefObject<HTMLElement | null>): ReadonlySet<string> {
  const [source] = useState(() => new LiveFrames(stage))
  useLayoutEffect(() => source.setFrames(frames), [source, frames])
  return useSyncExternalStore(source.subscribe, source.getSnapshot)
}
