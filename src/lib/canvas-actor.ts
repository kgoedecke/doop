import type { FrameChange, FrameCommand, FrameSnapshot, FrameWrite } from '../actor'
import type { ActivityItem, Frame, FrameIndex } from '../../shared/types'
import { createFrameId } from '../../shared/types'
import { getIdentity } from './identity'
import { useStore } from './store'
import { healPartialHtml } from '../../shared/frame-html'

type Connection = {
  id: string
  canvasId: string
  socket?: WebSocket
  ready: Promise<void>
  revision: number
  stopped: boolean
  retry?: ReturnType<typeof setTimeout>
  cancel?: () => void
}
type CanvasConnection = {
  canvasId: string
  revision: number
  ready: Promise<void>
  stopped: boolean
}
let connection: CanvasConnection | undefined
const frames = new Map<string, Connection>()
const members = new Set<string>()
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
// Initial grants/snapshots are bounded; established sockets stay independent.
let opening = 0
const waiting: (() => void)[] = []
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (opening >= 4) await new Promise<void>((resolve) => waiting.push(resolve))
  else opening++
  try {
    return await work()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else opening--
  }
}
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

function paint(frame: Frame) {
  if (members.has(frame.id)) useStore.getState().upsertFrame(frame)
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
    paint(frame)
    return
  }
  const deadline = Date.now() + Math.min(5000, Math.max(2500, (frame.html.length - shown) / 8))
  state.setStream(frame.id, { name: event.actor.name, color: event.actor.color })
  const tick = () => {
    const ticks = Math.max(1, Math.ceil((deadline - Date.now()) / 80))
    shown = Math.min(frame.html.length, shown + Math.ceil((frame.html.length - shown) / ticks))
    paint(shown === frame.html.length ? frame : { ...frame, html: healPartialHtml(frame.html.slice(0, shown)) })
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

function remove(id: string) {
  const current = frames.get(id)
  if (current) stop(current)
  frames.delete(id)
  members.delete(id)
  useStore.getState().setFrameIndex([...members])
  savedFrames.delete(id)
  clearTimeout(reveals.get(id))
  reveals.delete(id)
  useStore.getState().removeFrame(id)
}

export function applyFrameIndex(event: FrameIndex) {
  const current = connection
  if (!current || current.stopped || event.canvasId !== current.canvasId) return
  if (event.revision < current.revision) return
  current.revision = event.revision
  if (event.deleted) {
    disconnectFrames()
    location.href = '/'
    return
  }
  const ids = new Set(event.frameIds)
  for (const id of members) if (!ids.has(id)) remove(id)
  for (const frame of useStore.getState().canvas?.frames ?? []) if (!ids.has(frame.id)) remove(frame.id)
  members.clear()
  for (const id of event.frameIds) members.add(id)
  useStore.getState().setFrameIndex(event.frameIds)
  for (const id of event.frameIds) {
    const frame = savedFrames.get(id)
    if (frame && !useStore.getState().canvas?.frames.some((entry) => entry.id === id)) paint(frame)
    void connectFrame(id).catch((error) => console.error('[frame]', error))
  }
}

function applyFrame(event: FrameSnapshot | FrameChange, current: Connection) {
  if (!members.has(current.id)) return
  if (event.type === 'frame-change') acknowledge(event.requestId, event.frame)
  if (event.revision < current.revision) return
  if (event.type === 'frame-change' && event.revision > current.revision + 1) {
    current.socket?.send(JSON.stringify({ type: 'snapshot' }))
    return
  }
  current.revision = event.revision
  if (!event.frame || (event.type === 'frame-snapshot' && event.deleted)) {
    remove(current.id)
    if (connection) void refreshIndex(connection).catch((error) => console.error('[frame membership]', error))
    return
  }
  const frame = event.frame
  savedFrames.set(current.id, frame)
  if (event.type === 'frame-snapshot') {
    clearTimeout(reveals.get(frame.id))
    reveals.delete(frame.id)
    useStore.getState().setStream(frame.id, null)
    paint(frame)
    mergeActivity(event.activity)
  } else {
    showFrame(event)
    if (event.activity) mergeActivity([event.activity])
    if (event.actor.clientId !== getIdentity().clientId && !useStore.getState().streams[frame.id])
      useStore.getState().flash(frame.id, event.actor.color)
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
      finish(new Error('Frame connection timed out'))
      abort.abort()
      current.socket?.close()
      retry()
    }, 30_000)
    current.cancel = () => {
      abort.abort()
      finish(new Error('Frame connection cancelled'))
    }
    const retry = () => {
      if (current.stopped || current.retry) return
      current.ready = new Promise<void>((resolveRetry, rejectRetry) => {
        current.retry = setTimeout(() => {
          current.retry = undefined
          const reconnect = () => open(current)
          void slot(reconnect).then(resolveRetry, rejectRetry)
        }, 1000)
      })
      void current.ready.catch(() => {})
    }
    void (async () => {
      if (current.stopped) throw new Error('Connection cancelled')
      const response = await fetch(
        `/api/frames/${encodeURIComponent(current.id)}/actor?clientId=${encodeURIComponent(getIdentity().clientId)}`,
        { signal: abort.signal },
      )
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) current.stopped = true
        throw new Error(`Frame access denied (${response.status})`)
      }
      const grant = (await response.json()) as { websocketUrl: string }
      if (current.stopped || settled) throw new Error('Connection cancelled')
      const socket = new WebSocket(grant.websocketUrl)
      current.socket = socket
      socket.onmessage = ({ data }) => {
        if (current.stopped || current.socket !== socket || connection?.canvasId !== current.canvasId) return
        const event = JSON.parse(String(data)) as
          | FrameSnapshot
          | { type: 'drag'; frameId: string; x: number; y: number; width: number; height: number; updatedAt: number }
          | { type: 'state' }
          | {
              type: 'state_update'
              changes: { committed?: FrameChange | FrameSnapshot }
            }
          | { type: 'error'; requestId: string; message: string }
        if (event.type === 'frame-snapshot') {
          applyFrame(event, current)
          finish()
        } else if (event.type === 'state_update' && event.changes.committed) {
          applyFrame(event.changes.committed, current)
        } else if (event.type === 'drag') {
          // Any committed frame edit invalidates previews from its previous version.
          if (event.frameId === current.id && savedFrames.get(event.frameId)?.updatedAt === event.updatedAt) {
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
        finish(new Error('Frame connection failed'))
        socket.close()
      }
      socket.onclose = () => {
        if (current.socket !== socket) return
        finish(new Error('Frame connection closed'))
        rejectPending(current, new Error('Connection lost; reload to check whether your edit was saved.'))
        retry()
      }
    })().catch((error: Error) => {
      finish(error)
      retry()
    })
  })
}

function connectFrame(id: string): Promise<void> {
  const existing = frames.get(id)
  if (existing) return existing.ready
  const canvasId = connection?.canvasId
  if (!canvasId || !members.has(id)) return Promise.reject(new Error('Frame is no longer on this canvas'))
  const current: Connection = { id, canvasId, ready: Promise.resolve(), revision: -1, stopped: false }
  frames.set(id, current)
  current.ready = slot(() => open(current))
  return current.ready
}

async function refreshIndex(current: CanvasConnection): Promise<void> {
  const response = await fetch(`/api/canvases/${encodeURIComponent(current.canvasId)}/frame-index`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Canvas access denied (${response.status})`)
  const snapshot = (await response.json()) as FrameIndex
  if (connection === current && !current.stopped) applyFrameIndex(snapshot)
}

export function connectFrames(id: string): Promise<void> {
  if (connection?.canvasId === id) {
    const current = connection
    if (current.revision >= 0) return Promise.resolve()
    return current.ready.catch(() => (current.ready = refreshIndex(current)))
  }
  disconnectFrames()
  const current: CanvasConnection = { canvasId: id, ready: Promise.resolve(), revision: -1, stopped: false }
  connection = current
  current.ready = refreshIndex(current)
  return current.ready
}

export function disconnectFrames() {
  if (connection) connection.stopped = true
  for (const current of frames.values()) stop(current)
  connection = undefined
  frames.clear()
  members.clear()
  useStore.getState().setFrameIndex(null)
  savedFrames.clear()
  for (const timer of reveals.values()) clearTimeout(timer)
  reveals.clear()
  for (const queue of updates.values())
    for (const waiter of queue.next?.waiters ?? []) waiter.reject(new Error('Canvas connection closed.'))
  updates.clear()
}

export async function refreshFrames() {
  if (connection) await refreshIndex(connection)
  for (const current of frames.values())
    if (current?.socket?.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ type: 'snapshot' }))
}

export function previewFrame(frame: Pick<Frame, 'id' | 'x' | 'y' | 'width' | 'height' | 'updatedAt'>) {
  const current = frames.get(frame.id)
  const saved = savedFrames.get(frame.id)
  if (current?.canvasId !== useStore.getState().canvas?.id || current?.socket?.readyState !== WebSocket.OPEN || !saved)
    return
  const { id: frameId, x, y, width, height } = frame
  current.socket.send(
    JSON.stringify({ type: 'drag', frameId, x, y, width, height, updatedAt: saved.updatedAt } satisfies FrameCommand),
  )
}

async function send(current: Connection, command: Extract<FrameCommand, { type: 'write' }>): Promise<Frame> {
  const socket = current.socket
  if (current.stopped || socket?.readyState !== WebSocket.OPEN)
    throw new Error('Frame is reconnecting; try again shortly')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(command.requestId)
      reject(new Error('Edit confirmation timed out; reload to check whether it was saved.'))
    }, 30_000)
    pending.set(command.requestId, { connection: current, resolve, reject, timer })
    socket.send(JSON.stringify(command))
  })
}

export async function writeFrame(write: FrameWrite, canvasId = useStore.getState().canvas?.id): Promise<Frame> {
  if (!canvasId) throw new Error('No canvas is open')
  await connectFrames(canvasId)
  if (connection?.canvasId !== canvasId) throw new Error('Canvas changed before the edit could be sent')
  if (write.type === 'create' || write.type === 'delete') {
    if (write.type === 'create') write.id ??= createFrameId(canvasId, write.input.name, crypto.randomUUID())
    const path =
      write.type === 'create'
        ? `/api/canvases/${encodeURIComponent(canvasId)}/frames`
        : `/api/frames/${encodeURIComponent(write.id)}`
    const previous = write.type === 'delete' ? savedFrames.get(write.id) : undefined
    const response = await fetch(path, {
      method: write.type === 'create' ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      ...(write.type === 'create' ? { body: JSON.stringify({ ...write.input, id: write.id }) } : {}),
    })
    if (!response.ok) throw new Error((await response.json()).error || 'Frame edit failed')
    if (write.type === 'create') {
      const frame = (await response.json()) as Frame
      // Read the committed membership directly so an immediate edit doesn't
      // depend on the app WebSocket delivering its notification first.
      if (connection?.canvasId !== canvasId) throw new Error('Canvas changed before the frame was ready.')
      await refreshIndex(connection)
      if (connection?.canvasId !== canvasId || !members.has(frame.id))
        throw new Error('Frame is no longer on this canvas')
      return frame
    }
    if (!previous) throw new Error('Frame not found')
    return previous
  }
  await connectFrame(write.id)
  const current = frames.get(write.id)
  if (!current || current.canvasId !== canvasId || connection?.canvasId !== canvasId)
    throw new Error('Frame connection changed')
  if (write.type === 'append')
    return send(current, {
      type: 'write',
      write: { type: 'append', chunk: write.chunk, start: write.start, done: write.done },
      requestId: crypto.randomUUID(),
    })
  return send(current, {
    type: 'write',
    write: { type: 'update', patch: write.patch },
    requestId: crypto.randomUUID(),
  })
}
