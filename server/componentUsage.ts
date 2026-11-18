import { INSTANCE_ATTR } from '../shared/components.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/**
 * Where every component of a canvas is used, from ONE pass over its frames.
 * The catalog in get_canvas used to split every frame's HTML once per
 * component: components × canvas bytes on each read. Here a frame's HTML is
 * scanned once for all instance markers (a string scan, never a parse) and the
 * counts are kept until that frame is written again: every frame write moves
 * the frame's `updatedAt`, which is what a kept count is checked against. So a
 * read after one frame changed scans that one frame, and a read after nothing
 * changed scans none.
 *
 * Only counts are kept, never HTML, so the cache holds nothing a dropped canvas
 * (store.evictIdle) would need back, and a canvas that is deleted takes its
 * entry along (the cache is keyed weakly by the canvas).
 */

export interface ComponentUsage {
  instances: number
  frames: { id: string; name: string; instances: number; approved: boolean }[]
}

interface FrameCounts {
  /** the frame's updatedAt when it was scanned */
  stamp: number
  counts: Map<string, number>
}

const scanned = new WeakMap<Canvas, Map<string, FrameCounts>>()

/* the leading space: an element's attribute, not a selector in a stylesheet */
const MARKER = ` ${INSTANCE_ATTR}="`

const tally = { passes: 0, framesScanned: 0 }

/** How often the index walked a canvas, and how many frames it had to read: what tests count. */
export function usageScans(): { passes: number; framesScanned: number } {
  return { ...tally }
}

/** Instance markers in one document, counted per component id. */
function countMarkers(html: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let at = html.indexOf(MARKER); at !== -1; at = html.indexOf(MARKER, at + MARKER.length)) {
    const from = at + MARKER.length
    const to = html.indexOf('"', from)
    if (to === -1) break
    const id = html.slice(from, to)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

function countsOf(kept: Map<string, FrameCounts>, frame: Frame): Map<string, number> {
  const known = kept.get(frame.id)
  if (known?.stamp === frame.updatedAt) return known.counts
  tally.framesScanned += 1
  const counts = countMarkers(frame.html)
  kept.set(frame.id, { stamp: frame.updatedAt, counts })
  return counts
}

/** Usage of every component used anywhere on the canvas, by component id. One pass. */
export function usageByComponent(canvas: Canvas): Map<string, ComponentUsage> {
  tally.passes += 1
  let kept = scanned.get(canvas)
  if (!kept) scanned.set(canvas, (kept = new Map()))
  const usage = new Map<string, ComponentUsage>()
  const present = new Set<string>()
  for (const frame of canvas.frames) {
    present.add(frame.id)
    for (const [id, instances] of countsOf(kept, frame)) {
      let entry = usage.get(id)
      if (!entry) usage.set(id, (entry = { instances: 0, frames: [] }))
      entry.instances += instances
      /* name and sign-off are read now, not kept: a rename or an approval is not a design write */
      entry.frames.push({
        id: frame.id,
        name: frame.name,
        instances,
        approved: frame.approval?.status === 'ready_for_dev',
      })
    }
  }
  for (const frameId of kept.keys()) if (!present.has(frameId)) kept.delete(frameId)
  return usage
}

export function usageOf(canvas: Canvas, id: string): ComponentUsage {
  return usageByComponent(canvas).get(id) ?? { instances: 0, frames: [] }
}
