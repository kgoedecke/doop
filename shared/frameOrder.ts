import type { Frame } from './types.ts'

type Placed = Pick<Frame, 'x' | 'y' | 'height'>

/**
 * Frames in reading order: rows top to bottom, each row left to right.
 *
 * Frames laid out side by side rarely share an exact top edge, so a frame
 * joins the current row when its top sits above the middle of the row's
 * first frame. Ties keep the input order, so the result is deterministic.
 */
export function readingOrder<T extends Placed>(frames: readonly T[]): T[] {
  const byTop = [...frames].sort((a, b) => a.y - b.y)
  const rows: T[][] = []
  for (const frame of byTop) {
    const row = rows.at(-1)
    const lead = row?.[0]
    if (row && lead && frame.y < lead.y + lead.height / 2) row.push(frame)
    else rows.push([frame])
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x))
}
