import { MAX_RENDER_PIXELS } from '../shared/exportScale.ts'
import type { Frame } from '../shared/types.ts'

/** The CSS px height a render of `frame` covers: the frame, cut at
 *  `maxHeight` and at the pixel budget. */
export function renderedHeight(frame: Pick<Frame, 'width' | 'height'>, scale: number, maxHeight?: number): number {
  const width = Math.max(1, Math.round(frame.width))
  const budget = Math.max(1, Math.floor(MAX_RENDER_PIXELS / (width * scale * scale)))
  const cap = maxHeight ? Math.round(maxHeight) : Infinity
  return Math.max(1, Math.min(Math.round(frame.height), cap, budget))
}
