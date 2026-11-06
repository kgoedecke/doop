import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { actors } from '../generated/actors/index.js'
import { db } from '../server/db/index.ts'
import * as t from '../server/db/schema.ts'
import * as persist from '../server/db/persist.ts'
import { moveCanvasToPostgres } from '../server/canvasMoves.ts'
import { reloadEnv } from '../server/env.ts'
import { CANVAS_ACTORS, featureFlags } from '../server/featureFlags.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* DOOP_CANVAS_ACTORS=flag, production's default: a canvas keeps its frames in
   a canvas actor when its owner has the canvas-actors flag, and in the
   Postgres frames table otherwise. */

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
  vi.stubEnv('DOOP_CANVAS_ACTORS', 'flag')
  reloadEnv()
  await db.insert(t.featureFlags).values({ flag: CANVAS_ACTORS, userId: FLAGGED, createdAt: Date.now() })
  await featureFlags.refresh()
}, 30_000)

afterAll(() => {
  vi.unstubAllEnvs()
  reloadEnv()
})

describe('the canvas-actors flag', () => {
  it('keeps an unflagged owner’s canvas in Postgres and never touches its actor', async () => {
    const canvas = store.createCanvas('Everyday', UNFLAGGED)
    const created = (await store.createFrame(canvas.id, { name: 'Hero', html: '<p>hi</p>' }, 'Bob'))!
    expect(await store.frameStoreOf(canvas.id)).toBe('postgres')
    expect(canvas.frameStore).toBeUndefined()
    expect(await storedHtml(created.id)).toBe('<p>hi</p>')
    expect(await actors.CanvasActor.get(canvas.id).summary()).toMatchObject({ initialized: false, frames: [] })
  })

  it('starts a flagged owner’s new canvases on their actor, with nothing in the frames table', async () => {
    const canvas = store.createCanvas('Dogfood', FLAGGED)
    const created = (await store.createFrame(canvas.id, { name: 'Hero', html: '<p>hi</p>' }, 'Ada'))!
    expect(await store.frameStoreOf(canvas.id)).toBe('actor')
    expect(canvas.frameStore).toBe('actor')
    expect(await storedHtml(created.id)).toBeUndefined()
    const summary = await actors.CanvasActor.get(canvas.id).summary()
    expect(summary.frames.map((frame) => frame.id)).toEqual([created.id])
  })

  it('gives a flagged owner’s copy of anyone’s canvas an actor of its own', async () => {
    const source = store.createCanvas('Shared', UNFLAGGED)
    await store.createFrame(source.id, { name: 'Hero', html: '<p>source</p>' }, 'Bob')
    const copy = (await store.duplicateCanvas(source.id, FLAGGED, 'Ada'))!
    expect(await store.frameStoreOf(copy.id)).toBe('actor')
    expect(await store.frameStoreOf(source.id)).toBe('postgres')
    const frames = (await actors.CanvasActor.get(copy.id).snapshot()).frames
    expect(frames.map((frame) => frame.html)).toEqual(['<p>source</p>'])
  })

  it('moves a flagged owner’s existing canvas on its first open, frames included, and records it', async () => {
    const id = randomUUID()
    const page = { id: 'page', name: 'Page 1' }
    await db
      .insert(t.canvases)
      .values({ id, name: 'Older', ownerId: FLAGGED, pages: [page], createdAt: 1, updatedAt: 1 })
    await db.insert(t.frames).values({
      id: `${id}.legacy`,
      canvasId: id,
      pageId: page.id,
      name: 'Legacy',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      html: '<p>from before</p>',
      createdAt: 1,
      updatedAt: 1,
      updatedBy: 'Ada',
    })
    store.init([(await persist.loadCanvas(id))!])

    const opened = (await store.syncCanvas(id))!
    expect(opened.frames.map((frame) => frame.html)).toEqual(['<p>from before</p>'])
    expect(await store.frameStoreOf(id)).toBe('actor')
    await persist.flush()
    const [row] = await db.select({ frameStore: t.canvases.frameStore }).from(t.canvases).where(eq(t.canvases.id, id))
    expect(row?.frameStore).toBe('actor')
  })

  it('leaves a canvas on its actor once moved, whoever owns it now', async () => {
    const moved: Canvas = {
      id: randomUUID(),
      name: 'Moved',
      ownerId: UNFLAGGED,
      frameStore: 'actor',
      pages: [{ id: 'page', name: 'Page 1' }],
      createdAt: 1,
      updatedAt: 1,
      frames: [],
    }
    store.init([moved])
    expect(await store.frameStoreOf(moved.id)).toBe('actor')
  })
})

describe('moving a canvas back to Postgres', () => {
  it('copies its frames and pages as the actor holds them and clears the mark', async () => {
    const canvas = store.createCanvas('Way back', FLAGGED)
    const kept = (await store.createFrame(canvas.id, { name: 'Kept', html: '<p>v1</p>' }, 'Ada'))!
    const dropped = (await store.createFrame(canvas.id, { name: 'Dropped' }, 'Ada'))!
    await store.updateFrame(kept.id, { html: '<p>v2</p>' }, 'Ada')
    await store.deleteFrame(dropped.id, { name: 'Ada', kind: 'user', color: '#000' })
    await persist.flush()
    /* a stale row from before the move, as an imported canvas leaves behind */
    await db.insert(t.frames).values(staleRow(`${canvas.id}.stale`, canvas.id))

    expect(await moveCanvasToPostgres(canvas.id)).toEqual({ frames: 1 })
    const rows = await db.select().from(t.frames).where(eq(t.frames.canvasId, canvas.id))
    expect(rows.map((row) => [row.id, row.html])).toEqual([[kept.id, '<p>v2</p>']])
    const [row] = await db.select().from(t.canvases).where(eq(t.canvases.id, canvas.id))
    expect(row).toMatchObject({ frameStore: null, pages: canvas.pages })
  })
})

const FLAGGED = 'user-ada'
const UNFLAGGED = 'user-bob'

async function storedHtml(frameId: string): Promise<string | undefined> {
  const [row] = await db.select({ html: t.frames.html }).from(t.frames).where(eq(t.frames.id, frameId))
  return row?.html
}

/** A frames-table row the canvas actor does not have. */
function staleRow(frameId: string, canvasId: string): typeof t.frames.$inferInsert {
  return {
    id: frameId,
    canvasId,
    pageId: 'page',
    name: 'Stale',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    html: '<p>old</p>',
    createdAt: 1,
    updatedAt: 1,
    updatedBy: 'Ada',
  }
}
