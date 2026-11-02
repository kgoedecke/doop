import type { Frame } from './types.ts'

/** Where a frame sits in its page's stack, back to front: its own `z` once
 *  something has placed it (a create, a reorder in the Layers panel), its
 *  creation time before that, so frames made before stacking existed keep
 *  the order they always had. Only the comparison means anything. */
export function stackOf(frame: Pick<Frame, 'z' | 'createdAt'>): number {
  return frame.z ?? frame.createdAt
}

/** Back to front; ties fall back to creation, then keep the order they
 *  came in (the sort is stable). */
export function byStack(a: Pick<Frame, 'z' | 'createdAt'>, b: Pick<Frame, 'z' | 'createdAt'>): number {
  return stackOf(a) - stackOf(b) || a.createdAt - b.createdAt
}

/** The frames in paint order: the canvas draws them in this order, so the
 *  last one is in front. */
export function sortByStack<T extends Pick<Frame, 'z' | 'createdAt'>>(frames: readonly T[]): T[] {
  return [...frames].sort(byStack)
}

/** The `z` that puts a frame in front of every one of these. */
export function frontOf(frames: readonly Pick<Frame, 'z' | 'createdAt'>[]): number | undefined {
  return frames.length ? Math.max(...frames.map(stackOf)) + 1 : undefined
}

/** One frame's new place in its page's stack. */
export type StackWrite = { id: string; z: number }

/** The most frames one stacking save may write: a page renumbered whole. */
export const MAX_STACK_WRITES = 2000

/** The `z` for a frame put at `index` of `frames` (back to front, without
 *  it): just past the end it is in front, at 0 behind, otherwise halfway
 *  between its neighbours. Undefined for an empty page, or when the two
 *  neighbours are too close to fit anything between them. */
export function zAt(frames: readonly Pick<Frame, 'z' | 'createdAt'>[], index: number): number | undefined {
  const below = frames[index - 1]
  const above = frames[index]
  if (!above) return below && stackOf(below) + 1
  if (!below) return stackOf(above) - 1
  const lo = stackOf(below)
  const hi = stackOf(above)
  const mid = lo + (hi - lo) / 2
  return mid > lo && mid < hi ? mid : undefined
}

/* `order` numbered 0, 1, 2…: the writes for the frames not there already */
function renumber(order: readonly Pick<Frame, 'id' | 'z'>[]): StackWrite[] {
  return order.flatMap((f, i) => (f.z === i ? [] : [{ id: f.id, z: i }]))
}

/** Room for a frame put at `index` of `frames` (back to front, without it):
 *  its `z`, and the writes that renumber the page first when its new
 *  neighbours are too close to fit it between them (keeping their order,
 *  so they can be saved on their own). `z` is undefined on an empty page. */
export function roomAt(
  frames: readonly Pick<Frame, 'id' | 'z' | 'createdAt'>[],
  index: number,
): { z: number | undefined; renumber: StackWrite[] } {
  const z = zAt(frames, index)
  if (z !== undefined || !frames.length) return { z, renumber: [] }
  return { z: Math.max(0, Math.min(index, frames.length)) - 0.5, renumber: renumber(frames) }
}

/** The writes that move `frameId` to `index` of the page's back-to-front
 *  order (`frames`, already sorted, the moved frame among them). Usually one
 *  write, a `z` between its new neighbours; when there is no room left
 *  between them, every frame on the page is renumbered. Empty when the
 *  frame is already there. */
export function restack(
  frames: readonly Pick<Frame, 'id' | 'z' | 'createdAt'>[],
  frameId: string,
  index: number,
): StackWrite[] {
  const from = frames.findIndex((f) => f.id === frameId)
  if (from === -1) return []
  const rest = frames.filter((f) => f.id !== frameId)
  const at = Math.max(0, Math.min(index, rest.length))
  if (at === from) return []
  const z = zAt(rest, at)
  if (z !== undefined) return [{ id: frameId, z }]
  return renumber([...rest.slice(0, at), frames[from]!, ...rest.slice(at)])
}
