/* Level of detail for frames on the stage. Every frame is a full document in
   its own iframe, and without this the browser holds all of them at once: a
   canvas with a few tall imported pages runs Safari on an iPad out of memory,
   and WebKit kills the tab ("a problem repeatedly occurred"). So only the frames
   worth a live document get one — on screen, big enough to work in, the
   largest first, within a per-device budget. The rest of the frames on
   screen show the server's rendered image of the same design, and frames
   off screen show nothing at all. */

import type { Frame } from '../../shared/types'
import type { Viewport } from './store'

/** How a frame is drawn on the stage. */
export type FrameLod = 'live' | 'image' | 'none'

export type LodRect = Pick<Frame, 'id' | 'x' | 'y' | 'width' | 'height' | 'hidden'>

export interface LodOptions {
  /** live documents allowed besides the pinned frames */
  budget: number
  /** live wherever they are: the selection, which edits talk to, or every
   *  frame in prototype mode */
  pinned: ReadonlySet<string>
  /** live ahead of larger frames while on screen: agent streams, so the
   *  design builds up in view instead of in a stale image */
  preferred: ReadonlySet<string>
}

/* how far past the screen edge a frame still counts as on screen, as a
   fraction of the screen: a short pan brings it in already drawn */
const MARGIN = 0.25
/* below this many screen px on its shorter side a frame is a thumbnail: its
   image reads the same, and nobody edits at that size */
export const MIN_LIVE_PX = 96

/** The drawing mode of every frame on the page. Frames left out are 'none'. */
export function frameLods(
  frames: readonly LodRect[],
  camera: Viewport,
  screen: { width: number; height: number },
  options: LodOptions,
): Map<string, FrameLod> {
  const lods = new Map<string, FrameLod>()
  const candidates: { id: string; area: number; preferred: boolean }[] = []
  const marginX = screen.width * MARGIN
  const marginY = screen.height * MARGIN
  for (const frame of frames) {
    /* the Stage draws hidden frames without a document */
    if (frame.hidden) continue
    if (options.pinned.has(frame.id)) {
      lods.set(frame.id, 'live')
      continue
    }
    const left = frame.x * camera.zoom + camera.x
    const top = frame.y * camera.zoom + camera.y
    const width = frame.width * camera.zoom
    const height = frame.height * camera.zoom
    const shownWidth = Math.min(left + width, screen.width + marginX) - Math.max(left, -marginX)
    const shownHeight = Math.min(top + height, screen.height + marginY) - Math.max(top, -marginY)
    if (shownWidth <= 0 || shownHeight <= 0) continue
    lods.set(frame.id, 'image')
    if (Math.min(width, height) < MIN_LIVE_PX) continue
    candidates.push({ id: frame.id, area: shownWidth * shownHeight, preferred: options.preferred.has(frame.id) })
  }
  candidates.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.area - a.area)
  for (const { id } of candidates.slice(0, options.budget)) lods.set(id, 'live')
  return lods
}

/* live documents besides the selection: touch-first devices (iPad, phones)
   run WebKit with a far smaller per-tab memory limit */
const TOUCH_BUDGET = 3
const DESKTOP_BUDGET = 12

/** The live-document budget for this device. */
export function liveFrameBudget(): number {
  return window.matchMedia('(pointer: coarse)').matches ? TOUCH_BUDGET : DESKTOP_BUDGET
}

/** The server-rendered image of a frame's current design. The version in
 *  the query busts the browser cache when the design changes; standalone
 *  elements keep their transparency as png, pages go as smaller jpeg. */
export function frameImageUrl(frame: Pick<Frame, 'id' | 'updatedAt'>, transparent: boolean): string {
  return transparent ? `/i/${frame.id}.png?v=${frame.updatedAt}` : `/i/${frame.id}.jpg?quality=80&v=${frame.updatedAt}`
}
