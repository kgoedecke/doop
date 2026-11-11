import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { actors } from '../generated/actors/index.js'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import type { ActorFrame, ActorFrameVersion } from '../src/actor.ts'

/**
 * The way back from canvas actors (server/actorFrames.ts): copy a canvas's
 * frames and their design history, as its actor holds them now, into Postgres
 * and clear its `frame_store` mark, so the canvas is an ordinary one again.
 * store.load does this for a canvas whose owner no longer has the
 * canvas-actors flag, before it reads the canvas, so nothing else has it in
 * hand while it moves; `bun run flags move-back` does it for every canvas of
 * an owner at once. Nothing ever moves the other way: only canvases made
 * while their owner has the flag live on actors.
 *
 * The move copies first and switches last, in one Postgres transaction that
 * also clears the mark: one that dies halfway leaves the canvas on its actor,
 * whole, and the next one starts over.
 */

/** Back into Postgres, as the actor holds the canvas now. The actor first
 *  stops taking browsers' edits, so nothing lands there after it is read; it
 *  keeps its copy, which the caller drops once nothing writes there any more.
 *  Returns the frames as they were moved, for a caller holding older ones. */
export async function moveCanvasToPostgres(canvasId: string): Promise<MoveCount & { held: ActorFrame[] }> {
  const actor = actors.CanvasActor.get(canvasId)
  await actor.close()
  try {
    return await copyToPostgres(canvasId)
  } catch (error) {
    /* the canvas stays on its actor, so browsers may edit there again */
    await actor.reopen().catch((failure: unknown) => console.error('[canvas actors] reopen failed', canvasId, failure))
    throw error
  }
}

async function copyToPostgres(canvasId: string): Promise<MoveCount & { held: ActorFrame[] }> {
  const actor = actors.CanvasActor.get(canvasId)
  const { frames } = await actor.snapshot()
  const ids = frames.map((frame) => frame.id)

  /* history first and outside the switch: rows that land before a failure are
     ignored while the canvas is still on its actor, and replaced by the retry */
  let versions = 0
  for (let after: string | null = null; ;) {
    const page: ActorFrameVersion[] = await actor.exportVersions(after, BATCH_BYTES)
    const last = page.at(-1)
    if (!last) break
    await db
      .insert(t.frameVersions)
      .values(page.map((version) => ({ ...version, canvasId, savedByKind: version.savedByKind ?? null })))
      .onConflictDoNothing()
    versions += page.length
    after = last.id
  }

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
  return { frames: ids.length, versions, held: frames }
}

/** The canvases these owners have on actors. */
export async function actorCanvasesOf(ownerIds: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (!ownerIds.length) return []
  return db
    .select({ id: t.canvases.id, name: t.canvases.name })
    .from(t.canvases)
    .where(and(inArray(t.canvases.ownerId, [...ownerIds]), eq(t.canvases.frameStore, 'actor')))
}

export type MoveCount = { frames: number; versions: number }

/** a call to the actor carries at most about this much HTML */
const BATCH_BYTES = 4_000_000

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
    rotation: frame.rotation || null,
    approval: frame.approval ?? null,
  }
}
