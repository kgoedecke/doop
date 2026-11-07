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

type Connection = { canvasId: string; socket: Promise<WebSocket> }
type Pending = { resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type Received =
  | { type: 'state_update'; changes: { committed?: FramesEvent | null } }
  | { type: 'error'; requestId: string; message: string }
  | { type: string }

const EDITABLE = new Set(['name', 'x', 'y', 'width', 'height', 'html', 'hidden', 'locked', 'z'])
const TIMEOUT_MS = 30_000
let connection: Connection | undefined
const pending = new Map<string, Pending>()
const queues = new Map<string, Promise<Frame>>()

async function send(canvasId: string, frameId: string, patch: BrowserPatch): Promise<Frame> {
  const socket = await connect(canvasId)
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('The canvas did not confirm the edit in time'))
    }, TIMEOUT_MS)
    pending.set(requestId, { resolve, reject, timer })
    socket.send(JSON.stringify({ type: 'edit', frameId, patch, requestId } satisfies FrameCommand))
  })
}

/** The open socket to this canvas's actor, opened on the first edit. */
function connect(canvasId: string): Promise<WebSocket> {
  if (connection?.canvasId === canvasId) return connection.socket
  close()
  const current: Connection = { canvasId, socket: open(canvasId) }
  connection = current
  current.socket.catch(() => {
    if (connection === current) connection = undefined
  })
  return current.socket
}

async function open(canvasId: string): Promise<WebSocket> {
  const query = `clientId=${encodeURIComponent(getIdentity().clientId)}`
  const response = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/actor?${query}`)
  if (!response.ok) throw new Error(`Canvas actor unavailable (${response.status})`)
  const { websocketUrl } = (await response.json()) as { websocketUrl: string }
  const socket = new WebSocket(websocketUrl)
  socket.onmessage = ({ data }) => receive(JSON.parse(String(data)) as Received)
  socket.onclose = () => {
    if (connection?.canvasId === canvasId) connection = undefined
    failPending(new Error('The canvas connection closed'))
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('Could not reach the canvas'))
  })
  return socket
}

function receive(message: Received) {
  if (message.type === 'error') {
    const { requestId, message: text } = message as { requestId: string; message: string }
    settle(requestId)?.reject(new Error(text))
    return
  }
  if (message.type !== 'state_update') return
  const event = (message as { changes: { committed?: FramesEvent | null } }).changes.committed
  if (event?.type === 'frame-edit') settle(event.requestId)?.resolve(event.frame)
}

function settle(requestId: string): Pending | undefined {
  const request = pending.get(requestId)
  if (!request) return undefined
  clearTimeout(request.timer)
  pending.delete(requestId)
  return request
}

function close() {
  const previous = connection
  connection = undefined
  previous?.socket.then((socket) => socket.close()).catch(() => {})
}

function failPending(error: Error) {
  for (const requestId of [...pending.keys()]) settle(requestId)?.reject(error)
}
