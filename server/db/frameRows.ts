import { eq } from 'drizzle-orm'
import { db } from './index.ts'
import * as t from './schema.ts'
import type { Frame } from '../../shared/types.ts'

/**
 * Frame rows in Postgres, for canvases whose frames are not in a canvas actor
 * (server/postgresCanvas.ts). The canvas keeps its frames in memory and writes
 * them through here as main always has: creates land at once, edits are
 * debounced so a stream's chunks become one row write per burst. Each frame's
 * writes and its deletion run in order, so a late write can never bring back
 * a row its deletion removed.
 */

/** Every frame of a canvas, oldest first. */
export async function loadFrameRows(canvasId: string): Promise<Frame[]> {
  const rows = await db
    .select()
    .from(t.frames)
    .where(eq(t.frames.canvasId, canvasId))
    .orderBy(t.frames.createdAt, t.frames.id)
  return rows.map(toFrame)
}

/** Write a frame now and resolve once it is stored (a create, an import). */
export async function insertFrameRow(frame: Frame): Promise<void> {
  cancelPending(frame.id)
  await queue(frame.id, () => upsert(frame))
}

/** Write a frame's latest state after a short pause; repeats fold into one write. */
export function saveFrameRow(frame: Frame) {
  pending.set(frame.id, frame)
  if (timers.has(frame.id)) return
  timers.set(
    frame.id,
    setTimeout(() => {
      timers.delete(frame.id)
      writePending(frame.id)
    }, FRAME_DEBOUNCE_MS),
  )
}

export async function deleteFrameRow(frameId: string): Promise<void> {
  cancelPending(frameId)
  await queue(frameId, () => db.delete(t.frames).where(eq(t.frames.id, frameId)))
}

/** Remove every frame of a deleted canvas. */
export async function deleteCanvasFrameRows(canvasId: string, frameIds: readonly string[]): Promise<void> {
  for (const id of frameIds) cancelPending(id)
  await Promise.all(frameIds.map((id) => queue(id, async () => {})))
  await db.delete(t.frames).where(eq(t.frames.canvasId, canvasId))
}

/** Write every debounced frame now and wait for all writes (shutdown). */
export async function flushFrameRows(): Promise<void> {
  for (const [id, timer] of timers) {
    clearTimeout(timer)
    timers.delete(id)
    writePending(id)
  }
  await Promise.allSettled([...queues.values()])
}

const FRAME_DEBOUNCE_MS = 400
const pending = new Map<string, Frame>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** The newest write or delete per frame; the next one waits for it. */
const queues = new Map<string, Promise<unknown>>()

function writePending(frameId: string) {
  const frame = pending.get(frameId)
  pending.delete(frameId)
  if (frame)
    queue(frameId, () => upsert(frame)).catch((error: unknown) =>
      console.error('[frames] write failed', frameId, error),
    )
}

function cancelPending(frameId: string) {
  clearTimeout(timers.get(frameId))
  timers.delete(frameId)
  pending.delete(frameId)
}

function queue(frameId: string, work: () => Promise<unknown>): Promise<unknown> {
  const queued = (queues.get(frameId) ?? Promise.resolve()).catch(() => {}).then(work)
  queues.set(frameId, queued)
  void queued
    .finally(() => {
      if (queues.get(frameId) === queued) queues.delete(frameId)
    })
    .catch(() => {})
  return queued
}

async function upsert(frame: Frame) {
  const row = frameRow(frame)
  const { id: _id, createdAt: _createdAt, ...set } = row
  await db.insert(t.frames).values(row).onConflictDoUpdate({ target: t.frames.id, set })
}

/** A frame as its frames-table row. */
export function frameRow(frame: Frame): typeof t.frames.$inferInsert {
  return {
    id: frame.id,
    canvasId: frame.canvasId,
    pageId: frame.pageId ?? null,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    html: frame.html,
    createdAt: frame.createdAt,
    updatedAt: frame.updatedAt,
    updatedBy: frame.updatedBy,
    demo: frame.demo ?? null,
    hidden: frame.hidden ? true : null,
    locked: frame.locked ? true : null,
    z: frame.z ?? null,
    approval: frame.approval ?? null,
  }
}

function toFrame(row: typeof t.frames.$inferSelect): Frame {
  const { demo, pageId, hidden, locked, approval, z, ...frame } = row
  return {
    ...frame,
    ...(pageId === null ? {} : { pageId }),
    ...(z === null ? {} : { z }),
    ...(demo === null ? {} : { demo }),
    ...(hidden ? { hidden: true } : {}),
    ...(locked ? { locked: true } : {}),
    ...(approval ? { approval } : {}),
  }
}
