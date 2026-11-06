import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { actors } from '../generated/actors/index.js'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import { frameRow } from './db/frameRows.ts'

/**
 * The way back from canvas actors: copy a canvas's pages and frames, as its
 * actor holds them now, into Postgres (`canvases.pages`, the `frames` table)
 * and clear its `frame_store` mark, so the server serves it from Postgres
 * again. Design history filed while it was on its actor stays there.
 *
 * A running server decides where a canvas lives once per process, so restart
 * it afterwards; edits made to the canvas between the move and the restart
 * still land on its actor.
 */
export async function moveCanvasToPostgres(canvasId: string): Promise<{ frames: number } | undefined> {
  const snapshot = await actors.CanvasActor.get(canvasId).snapshot()
  if (!snapshot.initialized || snapshot.deleted) return undefined
  const ids = snapshot.frames.map((frame) => frame.id)
  await db.transaction(async (tx) => {
    for (const frame of snapshot.frames) {
      const { id: _id, createdAt: _createdAt, ...set } = frameRow(frame)
      await tx.insert(t.frames).values(frameRow(frame)).onConflictDoUpdate({ target: t.frames.id, set })
    }
    /* frames deleted on the actor are gone here too */
    await tx
      .delete(t.frames)
      .where(
        ids.length
          ? and(eq(t.frames.canvasId, canvasId), notInArray(t.frames.id, ids))
          : eq(t.frames.canvasId, canvasId),
      )
    await tx.update(t.canvases).set({ pages: snapshot.pages, frameStore: null }).where(eq(t.canvases.id, canvasId))
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
