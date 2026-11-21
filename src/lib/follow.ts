import type { Frame, PeerViewport, Presence } from '../../shared/types'
import type { Viewport, useStore } from './store'
import { locatePresence } from './locate'

export const FOLLOW_MIN_ZOOM = 0.08
/* the Stage's own limits: following never zooms past what the canvas allows */
export const FOLLOW_MAX_ZOOM = 16

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

type State = ReturnType<typeof useStore.getState>

/** The agent being followed: as the roster has it now, or, while it is idle
 *  and out of the roster, as it was last seen. Undefined when following a
 *  person, or nobody. */
export function followedAgent(s: State): Presence | undefined {
  const last = s.followedAgent
  if (!last || !s.following || last.clientId !== s.following) return undefined
  return s.presences[last.clientId] ?? last
}

/** Whoever is being followed, person or agent, for naming them. */
export function followedLeader(s: State): Presence | undefined {
  return s.following ? (s.presences[s.following] ?? followedAgent(s)) : undefined
}

/** The frame a followed agent is working on: where its presence says it is,
 *  or where it was last seen. An agent that has touched nothing yet has none,
 *  and the camera stays put. */
export function agentFollowFrame(s: State): Frame | undefined {
  const agent = followedAgent(s)
  const at = agent && locatePresence(agent, s)
  if (!at || !('frameId' in at)) return undefined
  return s.canvas?.frames.find((f) => f.id === at.frameId)
}

/** What makes the camera move again while following an agent: another frame,
 *  or the same frame moved or made wider. Not taller: a design streaming in
 *  grows its frame chunk by chunk, and refitting each time would zoom out
 *  step by step until the section being written is too small to read. */
export function agentFollowKey(frame: Frame | undefined): string {
  return frame ? `${frame.id}:${frame.x},${frame.y},${frame.width}` : ''
}

/** Whether locating the followed agent could have changed between two states:
 *  the store changes on every cursor and camera step, and the lookup scans
 *  frames, streams and tasks. */
export function agentFollowInputsChanged(s: State, prev: State): boolean {
  const id = s.following
  return (
    !id ||
    id !== prev.following ||
    s.followedAgent !== prev.followedAgent ||
    s.presences[id] !== prev.presences[id] ||
    s.canvas?.frames !== prev.canvas?.frames ||
    s.streams !== prev.streams ||
    s.tasks !== prev.tasks
  )
}
