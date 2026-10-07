import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, type Db } from './db/index.ts'
import { canvasFrameState, frameMemberships } from './db/schema.ts'
import { membershipChanged } from './frame-notifications.ts'
import type { FrameIndex } from '../shared/types.ts'

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0]
type State = typeof canvasFrameState.$inferSelect

/** SQL owns membership. Frame payloads remain exclusively in frame actors. */
export function frameRegistry(canvasId: string, database: Db = db) {
  const stateKey = eq(canvasFrameState.canvasId, canvasId)
  const entries = eq(frameMemberships.canvasId, canvasId)
  const entry = (id: string) => and(entries, eq(frameMemberships.id, id))

  async function write<T>(
    work: (tx: Transaction, state: State) => Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    const result = await database.transaction(async (tx) => {
      await tx.insert(canvasFrameState).values({ canvasId }).onConflictDoNothing()
      const [state] = await tx.select().from(canvasFrameState).where(stateKey).for('update')
      const result = await work(tx, state!)
      if (result.changed) {
        await tx
          .update(canvasFrameState)
          .set({ revision: sql`${canvasFrameState.revision} + 1` })
          .where(stateKey)
        // Delivered only after commit. PGlite uses the local callback below.
        if (process.env.DATABASE_URL) await tx.execute(sql`SELECT pg_notify('doop_frame_membership', ${canvasId})`)
      }
      return result
    })
    if (result.changed) membershipChanged(canvasId)
    return result.value
  }

  return {
    async snapshot(): Promise<FrameIndex> {
      return database.transaction(async (tx) => {
        // The shared lock keeps the revision and member list from different commits
        // from being combined. Every mutation takes the matching exclusive lock.
        await tx.insert(canvasFrameState).values({ canvasId }).onConflictDoNothing()
        const [state] = await tx.select().from(canvasFrameState).where(stateKey).for('share')
        const rows = await tx
          .select({ id: frameMemberships.id })
          .from(frameMemberships)
          .where(and(entries, eq(frameMemberships.status, 'active')))
          .orderBy(frameMemberships.position)
        return {
          type: 'frame-index',
          canvasId,
          revision: state!.revision,
          deleted: state!.deleted,
          frameIds: rows.map((r) => r.id),
        }
      })
    },

    async has(id: string): Promise<boolean> {
      const [row] = await database
        .select({ id: frameMemberships.id })
        .from(frameMemberships)
        .innerJoin(canvasFrameState, eq(frameMemberships.canvasId, canvasFrameState.canvasId))
        .where(and(entry(id), eq(frameMemberships.status, 'active'), eq(canvasFrameState.deleted, false)))
      return !!row
    },

    /** Reserve before actor initialization so an interrupted create stays discoverable. */
    reserve(id: string): Promise<boolean> {
      if (!id.startsWith(`${canvasId}.`)) throw new Error('Frame ID must belong to this canvas')
      return write(async (tx, state) => {
        if (state.deleted) return { value: false, changed: false }
        const [existing] = await tx.select().from(frameMemberships).where(entry(id))
        if (existing) return { value: ['creating', 'active'].includes(existing.status), changed: false }
        const [last] = await tx
          .select({ position: sql<number>`COALESCE(MAX(${frameMemberships.position}), -1) + 1` })
          .from(frameMemberships)
          .where(entries)
        await tx.insert(frameMemberships).values({ id, canvasId, position: Number(last!.position), status: 'creating' })
        return { value: true, changed: false }
      })
    },

    activate(id: string): Promise<boolean> {
      return write(async (tx, state) => {
        if (state.deleted) return { value: false, changed: false }
        const [row] = await tx.select().from(frameMemberships).where(entry(id))
        if (!row || !['creating', 'active'].includes(row.status)) return { value: false, changed: false }
        if (row.status === 'active') return { value: true, changed: false }
        await tx.update(frameMemberships).set({ status: 'active' }).where(entry(id))
        return { value: true, changed: true }
      })
    },

    remove(id: string): Promise<boolean> {
      return write(async (tx) => {
        const rows = await tx
          .update(frameMemberships)
          .set({ status: 'deleting' })
          .where(and(entry(id), inArray(frameMemberships.status, ['creating', 'active'])))
          .returning()
        return { value: rows.length > 0, changed: rows.length > 0 }
      })
    },

    async pending() {
      return database
        .select({ id: frameMemberships.id, status: frameMemberships.status })
        .from(frameMemberships)
        .where(and(entries, inArray(frameMemberships.status, ['creating', 'deleting'])))
    },

    async confirmDelete(id: string): Promise<void> {
      // Keep the tombstone: a retried creation must never reuse a removed ID.
      await database
        .update(frameMemberships)
        .set({ status: 'deleted' })
        .where(and(entry(id), eq(frameMemberships.status, 'deleting')))
    },

    destroy(): Promise<void> {
      return write(async (tx, state) => {
        if (state.deleted) return { value: undefined, changed: false }
        await tx.update(canvasFrameState).set({ deleted: true }).where(stateKey)
        await tx
          .update(frameMemberships)
          .set({ status: 'deleting' })
          .where(and(entries, inArray(frameMemberships.status, ['creating', 'active'])))
        return { value: undefined, changed: true }
      })
    },
  }
}

/** Pending work includes deleted canvases whose metadata has already been removed. */
export async function pendingFrameCanvases(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ canvasId: frameMemberships.canvasId })
    .from(frameMemberships)
    .where(inArray(frameMemberships.status, ['creating', 'deleting']))
  return rows.map((row) => row.canvasId)
}
