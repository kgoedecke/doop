import type { PeerViewport } from './types'

/** A camera another client sent us is only usable if every field is a finite
 *  number and the zoom and stage size are positive — anything else would put
 *  a follower's transform at NaN or infinity. */
export function isPeerViewport(v: unknown): v is PeerViewport {
  if (!v || typeof v !== 'object') return false
  const { x, y, zoom, width, height } = v as Record<string, unknown>
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  return (
    finite(x) && finite(y) && finite(zoom) && zoom > 0 && finite(width) && width > 0 && finite(height) && height > 0
  )
}
