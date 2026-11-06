import type { CanvasCommand, CanvasEvent, CanvasSnapshot, FrameChange, FrameWrite } from '../actor'
import type { ActivityItem, Frame } from '../../shared/types'
import { getIdentity } from './identity'
import { useStore } from './store'
import { healPartialHtml } from '../../shared/frame-html'

type Connection = {
  canvasId: string
  socket?: WebSocket
  ready: Promise<void>
  revision: number
  stopped: boolean
  retry?: ReturnType<typeof setTimeout>
  cancel?: () => void
}
let connection: Connection | undefined
/** The canvas's frames in canvas order, as the actor last sent them. */
let members: string[] = []
const savedFrames = new Map<string, Frame>()
const pending = new Map<
  string,
  {
    connection: Connection
    resolve: (frame: Frame) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()
const reveals = new Map<string, ReturnType<typeof setTimeout>>()
type UpdateBatch = {
  patch: Partial<Frame>
  waiters: { resolve: (frame: Frame) => void; reject: (error: unknown) => void }[]
}
const updates = new Map<string, { canvasId: string; next?: UpdateBatch }>()

/** One save per frame in flight; keep only the newest values behind it. */
export async function updateFrame(id: string, patch: Partial<Frame>): Promise<Frame> {
  const canvasId = useStore.getState().canvas?.id
  if (!canvasId) throw new Error('No canvas is open')
  await connectFrames(canvasId)
  if (connection?.canvasId !== canvasId || useStore.getState().canvas?.id !== canvasId)
    throw new Error('Canvas changed before the edit could be sent.')
  return new Promise((resolve, reject) => {
    const existing = updates.get(id)
    const queue = existing ?? { canvasId }
    const batch = (queue.next ??= { patch: {}, waiters: [] })
    Object.assign(batch.patch, patch)
    batch.waiters.push({ resolve, reject })
    if (existing) return
    updates.set(id, queue)
    void (async () => {
      while (queue.next && updates.get(id) === queue) {
        const next = queue.next
        queue.next = undefined
        try {
          const frame = await writeFrame({ type: 'update', id, patch: next.patch }, queue.canvasId)
          for (const waiter of next.waiters) waiter.resolve(frame)
        } catch (error) {
          // A lost confirmation can mean the write committed. Never replay it
          // or send queued work after a disconnect or canvas switch.
          const queued = updates.get(id) === queue ? updates.get(id)?.next : undefined
          for (const waiter of [...next.waiters, ...(queued?.waiters ?? [])]) waiter.reject(error)
          break
        }
      }
      if (updates.get(id) === queue) updates.delete(id)
    })()
  })
}

/** This tab's presence token, so the room can tell its own REST writes from others'. */
function restActor() {
  const { clientId, name } = getIdentity()
  return { clientId, name, kind: 'user' as const }
}

function paint(frame: Frame) {
  if (members.includes(frame.id)) useStore.getState().upsertFrame(frame)
}

function showFrame(event: FrameChange) {
  const state = useStore.getState()
  // An older acknowledgement must not paint over this browser's newer edit.
  const frame =
    event.operation === 'update' && event.actor.clientId === getIdentity().clientId
      ? { ...event.frame, ...updates.get(event.frame.id)?.next?.patch }
      : event.frame
  clearTimeout(reveals.get(frame.id))
  reveals.delete(frame.id)
  if (event.operation === 'append') {
    state.setStream(frame.id, event.streaming ? { name: event.actor.name, color: event.actor.color } : null)
    paint(event.streaming ? { ...frame, html: healPartialHtml(frame.html) } : frame)
    return
  }
  /* a stream that stopped before its end: never run what it left half-written */
  if (event.partial) {
    state.setStream(frame.id, null)
    paint({ ...frame, html: healPartialHtml(frame.html) })
    return
  }
  const previous = state.canvas?.frames.find((candidate) => candidate.id === frame.id)?.html ?? ''
  let shown = 0
  while (shown < previous.length && shown < frame.html.length && previous[shown] === frame.html[shown]) shown++
  // Keep Doop's one-shot AI reveal in the presentation layer. Actor state and
  // backend reads always contain the full committed HTML. A new frame shows as it is.
  if (
    event.operation === 'insert' ||
    event.actor.kind !== 'agent' ||
    previous === frame.html ||
    (shown >= frame.html.length * 0.5 && shown >= previous.length * 0.5)
  ) {
    state.setStream(frame.id, null)
    paint(frame)
    return
  }
  const deadline = Date.now() + Math.min(5000, Math.max(2500, (frame.html.length - shown) / 8))
  state.setStream(frame.id, { name: event.actor.name, color: event.actor.color })
  paint({ ...frame, html: healPartialHtml(frame.html.slice(0, shown)) })
  const tick = () => {
    const ticks = Math.max(1, Math.ceil((deadline - Date.now()) / 80))
    shown = Math.min(frame.html.length, shown + Math.ceil((frame.html.length - shown) / ticks))
    const live = useStore.getState().canvas?.frames.find((entry) => entry.id === frame.id)
    if (!live) return
    paint({ ...live, html: shown === frame.html.length ? frame.html : healPartialHtml(frame.html.slice(0, shown)) })
    if (shown < frame.html.length) reveals.set(frame.id, setTimeout(tick, 80))
    else {
      reveals.delete(frame.id)
      state.setStream(frame.id, null)
    }
  }
  tick()
}

function mergeActivity(items: ActivityItem[]) {
  const state = useStore.getState()
  const merged = new Map([...state.activity, ...items].map((item) => [item.id, item]))
  state.setActivity([...merged.values()].sort((a, b) => b.at - a.at).slice(0, 100))
}

function acknowledge(requestId: string | undefined, frame: Frame | undefined) {
  if (!requestId || !frame) return
  const request = pending.get(requestId)
  if (!request) return
  clearTimeout(request.timer)
  pending.delete(requestId)
  request.resolve(frame)
}

function rejectPending(current: Connection, error: Error) {
  for (const [id, request] of pending) {
    if (request.connection !== current) continue
    clearTimeout(request.timer)
    pending.delete(id)
    request.reject(error)
  }
}

function stop(current: Connection) {
  current.stopped = true
  clearTimeout(current.retry)
  current.cancel?.()
  current.socket?.close()
  rejectPending(current, new Error('Connection closed; reload to check whether your edit was saved.'))
}

function setMembers(ids: string[]) {
  members = ids
  useStore.getState().setFrameIndex(ids)
}

function remove(id: string) {
  setMembers(members.filter((member) => member !== id))
  savedFrames.delete(id)
  clearTimeout(reveals.get(id))
  reveals.delete(id)
  useStore.getState().removeFrame(id)
}

function applySnapshot(event: CanvasSnapshot, current: Connection) {
  if (event.revision < current.revision) return
  current.revision = event.revision
  if (event.deleted) {
    disconnectFrames()
    location.href = '/'
    return
  }
  useStore.getState().setPages(event.pages, current.canvasId)
  const ids = event.frames.map((frame) => frame.id)
  for (const frame of useStore.getState().canvas?.frames ?? []) if (!ids.includes(frame.id)) remove(frame.id)
  setMembers(ids)
  savedFrames.clear()
  for (const frame of event.frames) {
    savedFrames.set(frame.id, frame)
    clearTimeout(reveals.get(frame.id))
    reveals.delete(frame.id)
    useStore.getState().setStream(frame.id, null)
    paint(frame)
  }
  mergeActivity(event.activity)
}

function apply(event: CanvasEvent, current: Connection) {
  if (event.type === 'canvas-snapshot') return applySnapshot(event, current)
  if (event.type === 'frame-change') acknowledge(event.requestId, event.frame)
  if (event.revision < current.revision) return
  if (event.revision > current.revision + 1) {
    current.socket?.send(JSON.stringify({ type: 'snapshot' } satisfies CanvasCommand))
    return
  }
  current.revision = event.revision
  if (event.type === 'pages-change') {
    useStore.getState().setPages(event.pages, current.canvasId)
  } else if (event.type === 'frame-removal') {
    remove(event.frameId)
  } else {
    if (!members.includes(event.frame.id)) setMembers([...members, event.frame.id])
    savedFrames.set(event.frame.id, event.frame)
    showFrame(event)
    if (event.activity) mergeActivity([event.activity])
    if (
      event.operation !== 'insert' &&
      event.actor.clientId !== getIdentity().clientId &&
      !useStore.getState().streams[event.frame.id]
    )
      useStore.getState().flash(event.frame.id, event.actor.color)
  }
}

function open(current: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = new AbortController()
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      current.cancel = undefined
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error('Canvas connection timed out'))
      abort.abort()
      current.socket?.close()
      retry()
    }, 30_000)
    current.cancel = () => {
      abort.abort()
      finish(new Error('Canvas connection cancelled'))
    }
    const retry = () => {
      if (current.stopped || current.retry) return
      current.ready = new Promise<void>((resolveRetry, rejectRetry) => {
        current.retry = setTimeout(() => {
          current.retry = undefined
          void open(current).then(resolveRetry, rejectRetry)
        }, 1000)
      })
      void current.ready.catch(() => {})
    }
    void (async () => {
      if (current.stopped) throw new Error('Connection cancelled')
      const response = await fetch(
        `/api/canvases/${encodeURIComponent(current.canvasId)}/actor?clientId=${encodeURIComponent(getIdentity().clientId)}`,
        { signal: abort.signal },
      )
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) current.stopped = true
        throw new Error(`Canvas access denied (${response.status})`)
      }
      const grant = (await response.json()) as { websocketUrl: string }
      if (current.stopped || settled) throw new Error('Connection cancelled')
      const socket = new WebSocket(grant.websocketUrl)
      current.socket = socket
      socket.onmessage = ({ data }) => {
        if (current.stopped || current.socket !== socket || connection !== current) return
        const event = JSON.parse(String(data)) as
          | CanvasSnapshot
          | { type: 'drag'; frameId: string; x: number; y: number; width: number; height: number; updatedAt: number }
          | { type: 'state' }
          | { type: 'state_update'; changes: { committed?: CanvasEvent } }
          | { type: 'error'; requestId: string; message: string }
        if (event.type === 'canvas-snapshot') {
          applySnapshot(event, current)
          finish()
        } else if (event.type === 'state_update' && event.changes.committed) {
          apply(event.changes.committed, current)
        } else if (event.type === 'drag') {
          // Any committed frame edit invalidates previews from its previous version.
          if (savedFrames.get(event.frameId)?.updatedAt === event.updatedAt) {
            const { x, y, width, height } = event
            useStore.getState().patchFrameLocal(event.frameId, { x, y, width, height }, true)
          }
        } else if (event.type === 'error') {
          const request = pending.get(event.requestId)
          if (request?.connection === current) {
            clearTimeout(request.timer)
            pending.delete(event.requestId)
            request.reject(new Error(event.message))
          }
        }
      }
      socket.onerror = () => {
        finish(new Error('Canvas connection failed'))
        socket.close()
      }
      socket.onclose = () => {
        if (current.socket !== socket) return
        finish(new Error('Canvas connection closed'))
        rejectPending(current, new Error('Connection lost; reload to check whether your edit was saved.'))
        retry()
      }
    })().catch((error: Error) => {
      finish(error)
      retry()
    })
  })
}

export function connectFrames(id: string): Promise<void> {
  if (connection?.canvasId === id) return connection.ready
  disconnectFrames()
  const current: Connection = { canvasId: id, ready: Promise.resolve(), revision: -1, stopped: false }
  connection = current
  current.ready = open(current)
  return current.ready
}

export function disconnectFrames() {
  if (connection) stop(connection)
  connection = undefined
  members = []
  useStore.getState().setFrameIndex(null)
  savedFrames.clear()
  for (const timer of reveals.values()) clearTimeout(timer)
  reveals.clear()
  for (const queue of updates.values())
    for (const waiter of queue.next?.waiters ?? []) waiter.reject(new Error('Canvas connection closed.'))
  updates.clear()
}

export function refreshFrames() {
  if (connection?.socket?.readyState === WebSocket.OPEN)
    connection.socket.send(JSON.stringify({ type: 'snapshot' } satisfies CanvasCommand))
}

/** Stream drag geometry to peers; tagged with the saved version, so a commit since ends the preview. */
export function previewFrame(frame: Pick<Frame, 'id' | 'x' | 'y' | 'width' | 'height'>) {
  const saved = savedFrames.get(frame.id)
  if (
    connection?.canvasId !== useStore.getState().canvas?.id ||
    connection?.socket?.readyState !== WebSocket.OPEN ||
    !saved
  )
    return
  const { id: frameId, x, y, width, height } = frame
  connection.socket.send(
    JSON.stringify({ type: 'drag', frameId, x, y, width, height, updatedAt: saved.updatedAt } satisfies CanvasCommand),
  )
}

async function send(current: Connection, command: Extract<CanvasCommand, { type: 'write' }>): Promise<Frame> {
  const socket = current.socket
  if (current.stopped || socket?.readyState !== WebSocket.OPEN)
    throw new Error('Canvas is reconnecting; try again shortly')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(command.requestId)
      reject(new Error('Edit confirmation timed out; reload to check whether it was saved.'))
    }, 30_000)
    pending.set(command.requestId, { connection: current, resolve, reject, timer })
    socket.send(JSON.stringify(command))
  })
}

function waitForMembership(id: string, canvasId: string): Promise<void> {
  if (connection?.canvasId !== canvasId) return Promise.reject(new Error('Canvas changed before the frame was ready.'))
  if (members.includes(id)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error('Frame creation confirmation timed out; reload to check whether it was saved.'))
    }, 30_000)
    const unsubscribe = useStore.subscribe(() => {
      if (connection?.canvasId === canvasId && !members.includes(id)) return
      clearTimeout(timeout)
      unsubscribe()
      if (connection?.canvasId !== canvasId) reject(new Error('Canvas changed before the frame was ready.'))
      else resolve()
    })
    refreshFrames()
  })
}

export async function writeFrame(write: FrameWrite, canvasId = useStore.getState().canvas?.id): Promise<Frame> {
  if (!canvasId) throw new Error('No canvas is open')
  await connectFrames(canvasId)
  const current = connection
  if (current?.canvasId !== canvasId) throw new Error('Canvas changed before the edit could be sent')
  // Page moves go through the app API.
  if (write.type === 'update' && write.patch.pageId !== undefined) {
    const response = await fetch(`/api/frames/${encodeURIComponent(write.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...write.patch, actor: restActor() }),
    })
    if (!response.ok) throw new Error((await response.json()).error || 'Frame edit failed')
    return response.json() as Promise<Frame>
  }
  if (write.type === 'create' || write.type === 'delete') {
    if (write.type === 'create') write.id ??= `${canvasId}.${crypto.randomUUID()}`
    const path =
      write.type === 'create'
        ? `/api/canvases/${encodeURIComponent(canvasId)}/frames`
        : `/api/frames/${encodeURIComponent(write.id)}`
    const previous = write.type === 'delete' ? savedFrames.get(write.id) : undefined
    const response = await fetch(path, {
      method: write.type === 'create' ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        write.type === 'create' ? { ...write.input, id: write.id, actor: restActor() } : { actor: restActor() },
      ),
    })
    if (!response.ok) throw new Error((await response.json()).error || 'Frame edit failed')
    if (write.type === 'create') {
      const frame = (await response.json()) as Frame
      // REST can finish before the socket delivers the new frame.
      // Do not let the caller's immediate next edit race that notification.
      await waitForMembership(frame.id, canvasId)
      return frame
    }
    if (!previous) throw new Error('Frame not found')
    return previous
  }
  return send(current, {
    type: 'write',
    frameId: write.id,
    write: { type: 'update', patch: write.patch },
    requestId: crypto.randomUUID(),
  })
}
