import type { actors } from '../../generated/actors/index.js'
import type { FrameChange, FrameSnapshot, FrameWrite } from '../actor'
import type { Frame } from '../../shared/types'
import { getIdentity } from './identity'
import { useStore } from './store'
import { healPartialHtml } from '../../shared/frame-html'

type Incoming = actors.CanvasFrames.Outgoing
type Committed = actors.CanvasFrames.State['committed']
let connection:
  | {
      id: string
      socket?: WebSocket
      ready: Promise<void>
      revision: number
      stopped: boolean
      retry?: ReturnType<typeof setTimeout>
    }
  | undefined
const pending = new Map<
  string,
  { resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>()
const reveals = new Map<string, ReturnType<typeof setTimeout>>()

function showFrame(event: FrameChange) {
  const state = useStore.getState()
  const frame = event.frame
  clearTimeout(reveals.get(frame.id))
  reveals.delete(frame.id)
  if (event.operation === 'delete') {
    state.removeFrame(frame.id)
    return
  }
  if (event.operation === 'append') {
    state.setStream(frame.id, event.streaming ? { name: event.actor.name, color: event.actor.color } : null)
    state.upsertFrame(event.streaming ? { ...frame, html: healPartialHtml(frame.html) } : frame)
    return
  }
  const previous = state.canvas?.frames.find((candidate) => candidate.id === frame.id)?.html ?? ''
  let shown = 0
  while (shown < previous.length && shown < frame.html.length && previous[shown] === frame.html[shown]) shown++
  // Keep Doop's one-shot AI reveal in the presentation layer. Actor state and
  // backend reads always contain the full committed HTML.
  if (
    event.actor.kind !== 'agent' ||
    previous === frame.html ||
    (shown >= frame.html.length * 0.5 && shown >= previous.length * 0.5)
  ) {
    state.setStream(frame.id, null)
    state.upsertFrame(frame)
    return
  }
  const deadline = Date.now() + Math.min(5000, Math.max(2500, (frame.html.length - shown) / 8))
  state.setStream(frame.id, { name: event.actor.name, color: event.actor.color })
  const tick = () => {
    const ticks = Math.max(1, Math.ceil((deadline - Date.now()) / 80))
    shown = Math.min(frame.html.length, shown + Math.ceil((frame.html.length - shown) / ticks))
    state.upsertFrame(
      shown === frame.html.length ? frame : { ...frame, html: healPartialHtml(frame.html.slice(0, shown)) },
    )
    if (shown < frame.html.length) reveals.set(frame.id, setTimeout(tick, 80))
    else {
      reveals.delete(frame.id)
      state.setStream(frame.id, null)
    }
  }
  tick()
}

function apply(event: FrameSnapshot | FrameChange) {
  const current = connection
  if (!current) return
  if (event.type === 'change' && event.requestId) {
    const request = pending.get(event.requestId)
    if (request) {
      clearTimeout(request.timer)
      pending.delete(event.requestId)
      request.resolve(event.frame)
    }
  }
  if (event.revision < current.revision) return
  if (event.type === 'change' && event.revision > current.revision + 1) {
    current.socket?.send(JSON.stringify({ type: 'snapshot' } satisfies actors.CanvasFrames.Incoming))
    return
  }
  current.revision = event.revision
  const state = useStore.getState()
  if (state.canvas?.id !== current.id) return
  if (event.type === 'snapshot') {
    for (const timer of reveals.values()) clearTimeout(timer)
    reveals.clear()
    for (const id of Object.keys(state.streams)) state.setStream(id, null)
    if (event.deleted) {
      location.href = '/'
      return
    }
    for (const frame of state.canvas.frames)
      if (!event.frames.some((next) => next.id === frame.id)) state.removeFrame(frame.id)
    for (const frame of event.frames) state.upsertFrame(frame)
    const activity = new Map([...state.activity, ...event.activity].map((item) => [item.id, item]))
    state.setActivity([...activity.values()].sort((a, b) => b.at - a.at).slice(0, 100))
  } else {
    showFrame(event)
    if (event.activity) state.pushActivity(event.activity)
    if (event.actor.clientId !== getIdentity().clientId && event.operation !== 'delete')
      state.flash(event.frame.id, event.actor.color)
  }
}

export function disconnectFrames() {
  for (const timer of reveals.values()) clearTimeout(timer)
  reveals.clear()
  if (connection) {
    connection.stopped = true
    clearTimeout(connection.retry)
    connection.socket?.close()
    connection = undefined
  }
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(new Error('Canvas connection closed. Reload to check whether your edit was saved.'))
  }
  pending.clear()
}

export function refreshFrames() {
  if (connection?.socket?.readyState === WebSocket.OPEN)
    connection.socket.send(JSON.stringify({ type: 'snapshot' } satisfies actors.CanvasFrames.Incoming))
}

export function previewFrame(frame: Pick<Frame, 'id' | 'x' | 'y' | 'width' | 'height' | 'updatedAt'>) {
  if (connection?.id !== useStore.getState().canvas?.id || connection?.socket?.readyState !== WebSocket.OPEN) return
  const { id: frameId, x, y, width, height, updatedAt } = frame
  connection.socket.send(
    JSON.stringify({ type: 'drag', frameId, x, y, width, height, updatedAt } satisfies actors.CanvasFrames.Incoming),
  )
}

export function connectFrames(id: string): Promise<void> {
  if (connection?.id === id) return connection.ready
  disconnectFrames()
  const current = { id, ready: Promise.resolve(), revision: -1, stopped: false } as NonNullable<typeof connection>
  connection = current
  function open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Canvas connection timed out'))
        current.socket?.close()
      }, 30_000)
      const ready = () => {
        clearTimeout(timeout)
        resolve()
      }
      const failed = (error: Error) => {
        clearTimeout(timeout)
        reject(error)
      }
      void (async () => {
        const response = await fetch(
          `/api/canvases/${encodeURIComponent(id)}/actor?clientId=${encodeURIComponent(getIdentity().clientId)}`,
        )
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) current.stopped = true
          throw new Error(`Canvas access denied (${response.status})`)
        }
        const grant = (await response.json()) as { websocketUrl: string }
        if (current.stopped) {
          failed(new Error('Canvas connection cancelled'))
          return
        }
        const socket = new WebSocket(grant.websocketUrl)
        current.socket = socket
        socket.onmessage = ({ data }) => {
          if (current.stopped || current.socket !== socket) return
          const event = JSON.parse(String(data)) as
            Incoming | { type: 'state' } | { type: 'state_update'; changes: { committed?: Committed } }
          if (event.type === 'snapshot') {
            apply(event)
            ready()
          } else if (event.type === 'drag') {
            const state = useStore.getState()
            const frame = state.canvas?.id === id && state.canvas.frames.find((frame) => frame.id === event.frameId)
            if (frame && frame.updatedAt === event.updatedAt) {
              const { x, y, width, height } = event
              state.patchFrameLocal(frame.id, { x, y, width, height })
            }
          } else if (event.type === 'state_update' && event.changes.committed) apply(event.changes.committed)
          else if (event.type === 'error') {
            const request = pending.get(event.requestId)
            if (request) {
              clearTimeout(request.timer)
              pending.delete(event.requestId)
              request.reject(new Error(event.message))
            }
          }
        }
        socket.onerror = () => failed(new Error('Canvas connection failed'))
        socket.onclose = () => {
          failed(new Error('Canvas connection closed'))
          if (current.stopped) return
          for (const request of pending.values()) {
            clearTimeout(request.timer)
            request.reject(new Error('Connection lost; reload to check whether your edit was saved.'))
          }
          pending.clear()
          current.ready = new Promise((resolveRetry, rejectRetry) => {
            current.retry = setTimeout(() => {
              void open().then(resolveRetry, rejectRetry)
            }, 1000)
          })
          void current.ready.catch(() => {})
        }
      })().catch((error: Error) => {
        failed(error)
        if (!current.stopped) {
          current.ready = new Promise((resolveRetry, rejectRetry) => {
            current.retry = setTimeout(() => {
              void open().then(resolveRetry, rejectRetry)
            }, 1000)
          })
          void current.ready.catch(() => {})
        }
      })
    })
  }
  current.ready = open()
  return current.ready
}

export async function writeFrame(write: FrameWrite, canvasId = useStore.getState().canvas?.id): Promise<Frame> {
  if (!canvasId) throw new Error('No canvas is open')
  await connectFrames(canvasId)
  const socket = connection?.socket
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Canvas is reconnecting; try again shortly')
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('Edit confirmation timed out; reload to check whether it was saved.'))
    }, 30_000)
    pending.set(requestId, { resolve, reject, timer })
    socket.send(JSON.stringify({ type: 'write', requestId, write } satisfies actors.CanvasFrames.Incoming))
  })
}
