import type { BrowserPatch, FrameCommand, FramesEvent } from '../actor'
import type { Frame } from '../../shared/types'
import { getIdentity } from './identity'

/**
 * canvas-actors: on a canvas whose frames live in its Terse actor (one made by
 * an owner with the canvas-actors flag), frame edits go straight to the actor.
 * The server folds them in and the room carries them to everyone, as with any
 * edit. Nothing here runs on any other canvas.
 */

/** Whether an edit can go to the actor: page moves, sign-off and version-checked saves take the app API. */
export function actorTakes(patch: Partial<Frame>, expectedUpdatedAt: number | undefined): patch is BrowserPatch {
  return expectedUpdatedAt === undefined && Object.keys(patch).every((key) => EDITABLE.has(key))
}

/** Send one frame's edit to the canvas's actor. Resolves with the frame once
 *  the actor has committed it; one frame's edits go one at a time, in order. */
export function editOnActor(canvasId: string, frameId: string, patch: BrowserPatch): Promise<Frame> {
  const previous = queues.get(frameId) ?? Promise.resolve()
  const edit = previous.catch(() => {}).then(() => send(canvasId, frameId, patch))
  queues.set(frameId, edit)
  void edit
    .finally(() => {
      if (queues.get(frameId) === edit) queues.delete(frameId)
    })
    .catch(() => {})
  return edit
}

type Connection = {
  canvasId: string
  socket: Promise<WebSocket>
  /** edits sent on this connection: only its own failure fails them */
  pending: Map<string, Pending>
  /** stops the ticket request, the socket and the wait for it to open */
  abort: AbortController
}
type Pending = { resolve: (frame: Frame) => void; reject: (error: Error) => void }
type Received =
  | { type: 'state_update'; changes: { committed?: FramesEvent | null } }
  | { type: 'error'; requestId: string; message: string }
  | { type: string }

const EDITABLE = new Set(['name', 'x', 'y', 'width', 'height', 'html', 'hidden', 'locked', 'z'])
/** from asking for a ticket to the actor confirming the edit; after that the app API saves it */
const DEADLINE_MS = 10_000
let connection: Connection | undefined
const queues = new Map<string, Promise<Frame>>()

function send(canvasId: string, frameId: string, patch: BrowserPatch): Promise<Frame> {
  const current = connect(canvasId)
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    /* a connection that cannot confirm in time is dropped, so the next edit opens a fresh one */
    const timer = setTimeout(() => drop(current, new Error('The canvas did not confirm the edit in time')), DEADLINE_MS)
    current.pending.set(requestId, {
      resolve: (frame) => {
        clearTimeout(timer)
        resolve(frame)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    current.socket.then(
      (socket) => {
        if (current.pending.has(requestId))
          socket.send(JSON.stringify({ type: 'edit', frameId, patch, requestId } satisfies FrameCommand))
      },
      (error: unknown) =>
        settle(current, requestId)?.reject(error instanceof Error ? error : new Error('Could not reach the canvas')),
    )
  })
}

/** The connection to this canvas's actor, opened on the first edit. */
function connect(canvasId: string): Connection {
  if (connection?.canvasId === canvasId) return connection
  if (connection) drop(connection, new Error('The canvas changed'))
  const abort = new AbortController()
  const current: Connection = { canvasId, pending: new Map(), abort, socket: open(canvasId, abort.signal) }
  current.socket.then(
    (socket) => {
      socket.onmessage = ({ data }) => receive(current, JSON.parse(String(data)) as Received)
      socket.onclose = () => drop(current, new Error('The canvas connection closed'))
    },
    () => drop(current, new Error('Could not reach the canvas')),
  )
  connection = current
  return current
}

async function open(canvasId: string, signal: AbortSignal): Promise<WebSocket> {
  const query = `clientId=${encodeURIComponent(getIdentity().clientId)}`
  const response = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/actor?${query}`, { signal })
  if (!response.ok) throw new Error(`Canvas actor unavailable (${response.status})`)
  const { websocketUrl } = (await response.json()) as { websocketUrl: string }
  signal.throwIfAborted()
  const socket = new WebSocket(websocketUrl)
  signal.addEventListener('abort', () => socket.close(), { once: true })
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('Could not reach the canvas'))
    signal.addEventListener('abort', () => reject(new Error('The canvas connection closed')), { once: true })
  })
  return socket
}

/** Close a connection and fail the edits waiting on it; each then saves through the app API. */
function drop(current: Connection, error: Error) {
  if (connection === current) connection = undefined
  current.abort.abort()
  for (const requestId of [...current.pending.keys()]) settle(current, requestId)?.reject(error)
}

function receive(current: Connection, message: Received) {
  if (message.type === 'error') {
    const { requestId, message: text } = message as { requestId: string; message: string }
    settle(current, requestId)?.reject(new Error(text))
    return
  }
  if (message.type !== 'state_update') return
  const event = (message as { changes: { committed?: FramesEvent | null } }).changes.committed
  if (event?.type === 'frame-edit') settle(current, event.requestId)?.resolve(event.frame)
}

function settle(current: Connection, requestId: string): Pending | undefined {
  const request = current.pending.get(requestId)
  current.pending.delete(requestId)
  return request
}
