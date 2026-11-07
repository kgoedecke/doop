import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { actors } from '../generated/actors/index.js'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import type { ActorFrame } from '../src/actor.ts'

/**
 * The way back from canvas actors (`bun run flags move-back`): copy a
 * canvas's frames, as its actor holds them now, into the Postgres frames
 * table and clear its `frame_store` mark, so the canvas is an ordinary one
 * again. Pages, history and activity never left Postgres.
 *
 * The server reads `frame_store` at boot, so restart it afterwards; edits made
 * between the move and the restart still land on the actor.
 */
export async function moveCanvasToPostgres(canvasId: string): Promise<{ frames: number }> {
  const { frames } = await actors.CanvasActor.get(canvasId).snapshot()
  const ids = frames.map((frame) => frame.id)
  await db.transaction(async (tx) => {
    for (const frame of frames) {
      const { id: _id, createdAt: _createdAt, ...set } = frameRow(frame)
      await tx.insert(t.frames).values(frameRow(frame)).onConflictDoUpdate({ target: t.frames.id, set })
    }
    await tx
      .delete(t.frames)
      .where(
        ids.length
          ? and(eq(t.frames.canvasId, canvasId), notInArray(t.frames.id, ids))
          : eq(t.frames.canvasId, canvasId),
      )
    await tx.update(t.canvases).set({ frameStore: null }).where(eq(t.canvases.id, canvasId))
  })
  return { frames: ids.length }
}

/** The canvases these owners have on actors. */
export async function actorCanvasesOf(ownerIds: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (!ownerIds.length) return []
  return db
    .select({ id: t.canvases.id, name: t.canvases.name })
    .from(t.canvases)
    .where(and(inArray(t.canvases.ownerId, [...ownerIds]), eq(t.canvases.frameStore, 'actor')))
}

function frameRow(frame: ActorFrame): typeof t.frames.$inferInsert {
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
