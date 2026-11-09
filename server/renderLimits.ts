import { MAX_EXPORT_PIXELS } from '../shared/exportScale.ts'
import type { Frame } from '../shared/types.ts'

/** The device pixels one screenshot may hold. A 1440px frame at 2x keeps
 *  about 8,600 CSS px of height; past that the image is cut at the bottom
 *  rather than asking Chromium for a bitmap big enough to stall the browser
 *  every other render shares. Exports never reach it: `fitExportScale`
 *  brings their scale down to this same budget first. */
export const MAX_RENDER_PIXELS = MAX_EXPORT_PIXELS

/** The CSS px height a render of `frame` covers: the frame, cut at
 *  `maxHeight` and at the pixel budget. */
export function renderedHeight(frame: Pick<Frame, 'width' | 'height'>, scale: number, maxHeight?: number): number {
  const width = Math.max(1, Math.round(frame.width))
  const budget = Math.max(1, Math.floor(MAX_RENDER_PIXELS / (width * scale * scale)))
  const cap = maxHeight ? Math.round(maxHeight) : Infinity
  return Math.max(1, Math.min(Math.round(frame.height), cap, budget))
}
