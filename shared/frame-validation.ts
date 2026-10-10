import { MAX_FRAME_HTML_BYTES } from '../server/limits.js'
import type { Frame } from './types.js'

export function validateFrame(frame: Frame) {
  if (typeof frame.name !== 'string' || frame.name.length > 1024) throw new Error('Frame name is too long')
  if (typeof frame.html !== 'string' || new TextEncoder().encode(frame.html).length > MAX_FRAME_HTML_BYTES)
    throw new Error('Frame HTML is too large')
  for (const key of ['x', 'y', 'width', 'height'] as const)
    if (!Number.isFinite(frame[key]) || ((key === 'width' || key === 'height') && frame[key] <= 0))
      throw new Error(`Invalid frame ${key}`)
}
