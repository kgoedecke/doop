import type { PeerViewport } from '../../shared/types'
import type { Viewport } from './store'

export const FOLLOW_MIN_ZOOM = 0.08
export const FOLLOW_MAX_ZOOM = 3

/** The camera that shows the same stretch of canvas a peer is looking at.
 *  Screens differ in size, so the peer's visible world rect is fitted (never
 *  cropped) into ours and centred — the follower may see a little more, but
 *  everything the leader sees is on screen. */
export function cameraToFollow(leader: PeerViewport, stage: { width: number; height: number }): Viewport {
  const worldW = leader.width / leader.zoom
  const worldH = leader.height / leader.zoom
  const centerX = -leader.x / leader.zoom + worldW / 2
  const centerY = -leader.y / leader.zoom + worldH / 2
  const zoom = Math.min(
    FOLLOW_MAX_ZOOM,
    Math.max(FOLLOW_MIN_ZOOM, Math.min(stage.width / worldW, stage.height / worldH)),
  )
  return {
    x: stage.width / 2 - centerX * zoom,
    y: stage.height / 2 - centerY * zoom,
    zoom,
  }
}

/** Fallback when a peer has not shared a camera yet (older client, or one
 *  that never moved): keep our zoom and put their cursor at the centre. */
export function cameraOnCursor(
  cursor: { x: number; y: number },
  stage: { width: number; height: number },
  zoom: number,
): Viewport {
  return { x: stage.width / 2 - cursor.x * zoom, y: stage.height / 2 - cursor.y * zoom, zoom }
}
