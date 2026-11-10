import type { Request, Response } from 'express'
import type { UserEvent } from '../shared/userEvents.ts'

/**
 * A per-user push channel for what happens outside any canvas room: the
 * canvas WebSocket only exists while a canvas is open, so Home learns that
 * a canvas was shared with (or taken from) its user through this instead.
 * One Server-Sent Events stream per open tab, `GET /api/me/events`; the
 * events are pings ("your list changed"), and the page refetches.
 *
 * In memory, per process: a reconnecting EventSource is told to refetch on
 * open, so a ping lost to a restart costs nothing.
 */

const HEARTBEAT_MS = 25_000

const streams = new Map<string, Set<Response>>()
const canvasObservers = new Set<(userIds: ReadonlySet<string>) => void>()

/** In-process current-access observers; registration belongs to the server, not a client. */
export function onCanvasesChanged(observer: (userIds: ReadonlySet<string>) => void): () => void {
  canvasObservers.add(observer)
  return () => {
    canvasObservers.delete(observer)
  }
}

export function subscribe(req: Request, res: Response): void {
  const userId = req.user!.id
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    /* nginx-style proxies buffer responses unless told otherwise */
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')
  let set = streams.get(userId)
  if (!set) streams.set(userId, (set = new Set()))
  set.add(res)
  /* idle proxies cut silent connections; a comment line keeps it open */
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  heartbeat.unref?.()
  req.on('close', () => {
    clearInterval(heartbeat)
    set.delete(res)
    if (!set.size) streams.delete(userId)
  })
}

export function notifyUsers(userIds: Iterable<string>, event: UserEvent): void {
  const changed = new Set(userIds)
  // Update idle canvas rooms before writing to optional (possibly disconnected) Home streams.
  if (event.type === 'canvases') for (const observer of canvasObservers) observer(changed)
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const id of changed) for (const res of streams.get(id) ?? []) res.write(line)
}

/** Test seam: open streams for a user. */
export function streamCount(userId: string): number {
  return streams.get(userId)?.size ?? 0
}
