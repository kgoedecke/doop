import { and, asc, eq, gt, inArray, notInArray } from 'drizzle-orm'
import { actors } from '../generated/actors/index.js'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import type { ActorFrame, ActorFrameVersion } from '../src/actor.ts'

/**
 * Moving one canvas between Postgres and its Terse canvas actor
 * (server/actorFrames.ts). The owner's canvas-actors flag decides where a
 * canvas belongs; store.load moves a canvas that is in the wrong place before
 * it reads it, so nothing else has the canvas in hand while it moves.
 * `bun run flags move-back` moves every canvas of an owner back at once.
 *
 * Both moves copy first and switch last, in one Postgres transaction that
 * also flips `canvases.frame_store`: a move that dies halfway leaves the
 * canvas where it was, whole, and the next one starts over.
 */

/** Onto its actor: every frame whole and every frame's design history. The
 *  frames rows stay, emptied of their html, as the index boot reads. */
export async function moveCanvasToActor(canvasId: string): Promise<MoveCount> {
  const actor = actors.CanvasActor.get(canvasId)
  /* whatever an earlier move left there, in either direction */
  await actor.destroy()
  const rows = await db.select().from(t.frames).where(eq(t.frames.canvasId, canvasId))
  for (const batch of batches(rows.map(actorFrame), (frame) => frame.html.length))
    await actor.save(batch.map((frame) => ({ type: 'put', frame })))

  let versions = 0
  for (let after = ''; ;) {
    const page = await db
      .select()
      .from(t.frameVersions)
      .where(and(eq(t.frameVersions.canvasId, canvasId), gt(t.frameVersions.id, after)))
      .orderBy(asc(t.frameVersions.id))
      .limit(VERSION_PAGE_ROWS)
    const last = page.at(-1)
    if (!last) break
    for (const batch of batches(page.map(actorVersion), (version) => version.html.length))
      await actor.importVersions(batch)
    versions += page.length
    after = last.id
  }

  await db.transaction(async (tx) => {
    await tx.update(t.canvases).set({ frameStore: 'actor' }).where(eq(t.canvases.id, canvasId))
    await tx.update(t.frames).set({ html: '' }).where(eq(t.frames.canvasId, canvasId))
    await tx.delete(t.frameVersions).where(eq(t.frameVersions.canvasId, canvasId))
  })
  return { frames: rows.length, versions }
}

/** Back into Postgres, as the actor holds the canvas now. The actor keeps its
 *  copy; the caller drops it once nothing writes there any more. */
export async function moveCanvasToPostgres(canvasId: string): Promise<MoveCount> {
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
  return { frames: ids.length, versions }
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
/** history is read a few rows at a time: each may be a whole design */
const VERSION_PAGE_ROWS = 20

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

function actorFrame({
  pageId,
  demo,
  hidden,
  locked,
  z,
  rotation,
  approval,
  ...row
}: typeof t.frames.$inferSelect): ActorFrame {
  return {
    ...row,
    ...(pageId === null ? {} : { pageId }),
    ...(demo === null ? {} : { demo }),
    ...(hidden ? { hidden: true } : {}),
    ...(locked ? { locked: true } : {}),
    ...(z === null ? {} : { z }),
    ...(rotation ? { rotation } : {}),
    ...(approval ? { approval } : {}),
  }
}

function actorVersion({
  canvasId: _canvasId,
  savedByKind,
  ...row
}: typeof t.frameVersions.$inferSelect): ActorFrameVersion {
  return { ...row, ...(savedByKind === 'user' || savedByKind === 'agent' ? { savedByKind } : {}) }
}

/** Calls small enough for the actor's request limit. */
function batches<T>(items: readonly T[], bytes: (item: T) => number): T[][] {
  const out: T[][] = []
  let size = Infinity
  for (const item of items) {
    if (size + bytes(item) > BATCH_BYTES) {
      out.push([])
      size = 0
    }
    out.at(-1)!.push(item)
    size += bytes(item)
  }
  return out
}
