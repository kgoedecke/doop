import WebSocket from 'ws'
import { canvasActor, prepareCanvasSocket } from './frame-sync.ts'
import type { CanvasCommand, CanvasEvent, CanvasSnapshot, FrameDrag } from '../src/actor.ts'
import type { Actor, ServerMessage } from '../shared/types.ts'

/* Room frames: clients built before canvas actors (installed iOS apps, tabs
   left open across a deploy) read frames from the /ws room, as on main. Newer
   clients write to the canvas actor directly, past the server, so while an
   older client is in a canvas's room the server holds one socket to that
   canvas actor and turns its changes into the room's frame messages. */

type Listener = (message: ServerMessage) => void
type Feed = {
  listeners: Set<Listener>
  socket?: WebSocket
  retry?: ReturnType<typeof setTimeout>
  stopped: boolean
  revision: number
  /** each frame's saved version as last passed on; empty until the first snapshot */
  frames: Map<string, number>
  /** settles once the first snapshot is in, so later messages are changes since it */
  ready: Promise<void>
  markReady: () => void
}
const feeds = new Map<string, Feed>()

/** Who the room says changed a frame when a snapshot only shows that it changed. */
const SNAPSHOT_ACTOR: Actor = { name: 'Doop', kind: 'user', color: '#9c9b99' }
/** The clientId the room gives drags that come from the canvas actor. */
const ACTOR_CLIENT_ID = 'canvas-actor'

/** Follow a canvas's frames as room messages. Resolves once the feed has the
 *  canvas, so a frame list read afterwards is at least as new as the feed. */
export async function followRoomFrames(canvasId: string, listener: Listener): Promise<() => void> {
  let feed = feeds.get(canvasId)
  if (!feed) {
    let markReady = () => {}
    const ready = new Promise<void>((resolve) => (markReady = resolve))
    feed = { listeners: new Set(), stopped: false, revision: -1, frames: new Map(), ready, markReady }
    feeds.set(canvasId, feed)
    void connect(canvasId, feed)
  }
  const current = feed
  current.listeners.add(listener)
  // An actor that cannot be reached leaves the client with the frames it is about to read.
  await Promise.race([current.ready, new Promise((resolve) => setTimeout(resolve, 10_000))])
  return () => {
    current.listeners.delete(listener)
    if (current.listeners.size) return
    current.stopped = true
    clearTimeout(current.retry)
    current.socket?.close()
    feeds.delete(canvasId)
  }
}

/** A drag from an older client, passed to the canvas actor so newer clients see it too. */
export function forwardRoomDrag(canvasId: string, drag: Omit<FrameDrag, 'type' | 'updatedAt'>) {
  const feed = feeds.get(canvasId)
  const updatedAt = feed?.frames.get(drag.frameId)
  if (feed?.socket?.readyState !== WebSocket.OPEN || updatedAt === undefined) return
  feed.socket.send(JSON.stringify({ type: 'drag', ...drag, updatedAt } satisfies CanvasCommand))
}

async function connect(canvasId: string, feed: Feed) {
  try {
    const accessVersion = await canvasActor(canvasId).accessVersion()
    // The server's own socket: it only reads changes and relays drags.
    const grant = await prepareCanvasSocket({
      actorId: canvasId,
      metadata: { actor: SNAPSHOT_ACTOR, readOnly: false, accessVersion },
    })
    if (feed.stopped) return
    const socket = new WebSocket(grant.websocketUrl)
    feed.socket = socket
    socket.on('message', (data) => {
      if (feed.socket === socket) receive(feed, JSON.parse(String(data)))
    })
    socket.on('error', () => socket.close())
    // An access change closes actor sockets; reconnecting takes a fresh grant.
    socket.on('close', () => {
      if (feed.socket === socket) retry(canvasId, feed)
    })
  } catch (error) {
    console.error('[room frames]', error)
    retry(canvasId, feed)
  }
}

function retry(canvasId: string, feed: Feed) {
  if (feed.stopped || feed.retry) return
  feed.retry = setTimeout(() => {
    feed.retry = undefined
    void connect(canvasId, feed)
  }, 1000)
}

function emit(feed: Feed, message: ServerMessage) {
  for (const listener of feed.listeners) listener(message)
}

type Received =
  | CanvasSnapshot
  | FrameDrag
  | { type: 'state_update'; changes: { committed?: CanvasEvent | null } }
  | { type: 'state' }
  | { type: 'error' }

function receive(feed: Feed, event: Received) {
  if (event.type === 'canvas-snapshot') return applySnapshot(feed, event)
  if (event.type === 'drag') {
    const { frameId, x, y, width, height } = event
    return emit(feed, { type: 'frame:drag', clientId: ACTOR_CLIENT_ID, frameId, x, y, width, height })
  }
  if (event.type !== 'state_update' || !event.changes.committed) return
  const change = event.changes.committed
  if (change.type === 'canvas-snapshot') return applySnapshot(feed, change)
  if (change.revision <= feed.revision) return
  if (change.revision > feed.revision + 1) {
    feed.socket?.send(JSON.stringify({ type: 'snapshot' } satisfies CanvasCommand))
    return
  }
  feed.revision = change.revision
  // Page lists reach the room from the server, which makes every page change.
  if (change.type === 'pages-change') return
  if (change.type === 'frame-removal') {
    feed.frames.delete(change.frameId)
    return emit(feed, { type: 'frame:deleted', frameId: change.frameId, actor: change.actor })
  }
  const known = feed.frames.has(change.frame.id)
  feed.frames.set(change.frame.id, change.frame.updatedAt)
  emit(feed, { type: known ? 'frame:updated' : 'frame:created', frame: change.frame, actor: change.actor })
}

/** The first snapshot sets the baseline; later ones (after a reconnect or a
 *  missed change) become one message per frame that differs. */
function applySnapshot(feed: Feed, snapshot: CanvasSnapshot) {
  if (snapshot.revision < feed.revision) return
  const first = feed.revision === -1
  feed.revision = snapshot.revision
  const present = new Set(snapshot.frames.map((frame) => frame.id))
  for (const frameId of [...feed.frames.keys()]) {
    if (present.has(frameId)) continue
    feed.frames.delete(frameId)
    emit(feed, { type: 'frame:deleted', frameId, actor: SNAPSHOT_ACTOR })
  }
  for (const frame of snapshot.frames) {
    const seen = feed.frames.get(frame.id)
    feed.frames.set(frame.id, frame.updatedAt)
    if (first || seen === frame.updatedAt) continue
    emit(feed, { type: seen === undefined ? 'frame:created' : 'frame:updated', frame, actor: SNAPSHOT_ACTOR })
  }
  feed.markReady()
}
