import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { frameActor } from '../server/frame-sync.ts'
import type { Frame } from '../shared/types.ts'

// Run with all old and new app/worker processes stopped. This deliberately
// avoids boot hydration: importing frames must not change SQL or AI queues.
async function migrate() {
  const verifyOnly = process.argv.slice(2).includes('--verify')
  if (process.argv.slice(2).some((arg) => arg !== '--verify'))
    throw new Error('Usage: bun run migrate:actors [--verify]')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must identify the existing PostgreSQL database.')
  if (!process.env.TERSE_ACTOR_URL && !process.env.DURABLE_ACTORS_CONTROL_PLANE_URL)
    throw new Error('Configure the destination actor project before migrating.')
  const sql = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'doop-actor-cutover',
    connectionTimeoutMillis: 10_000,
  })
  await sql.connect()
  try {
    await sql.query('BEGIN')
    // Stable source data; also excludes a second migration. Fail immediately
    // if a writer already holds a conflicting lock. This is no substitute for
    // stopping writers: queued SQL writes could resume when we release it.
    await sql.query('LOCK TABLE canvases, frames IN SHARE ROW EXCLUSIVE MODE NOWAIT')
    const orphan = await sql.query(
      'SELECT f.id FROM frames f LEFT JOIN canvases c ON c.id=f.canvas_id WHERE c.id IS NULL LIMIT 1',
    )
    if (orphan.rowCount) throw new Error(`Frame ${orphan.rows[0].id} has no canvas; repair SQL before migrating.`)
    const canvases = await sql.query<{ id: string }>('SELECT id FROM canvases ORDER BY id')
    let count = 0
    for (const { id } of canvases.rows) {
      const { rows } = await sql.query<Omit<Frame, 'demo'> & { demo: boolean | null }>(
        `SELECT id, canvas_id AS "canvasId", name, x, y, width, height, html,
                created_at::float8 AS "createdAt", updated_at::float8 AS "updatedAt",
                updated_by AS "updatedBy", demo
           FROM frames WHERE canvas_id=$1 ORDER BY created_at, id`,
        [id],
      )
      const frames: Frame[] = rows.map(({ demo, ...frame }) => ({ ...frame, ...(demo === null ? {} : { demo }) }))
      if (
        frames.some(
          (frame) =>
            ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) ||
            ![frame.createdAt, frame.updatedAt].every(Number.isSafeInteger),
        )
      )
        throw new Error(`Canvas ${id}: invalid numeric frame data; repair SQL before migrating.`)
      const actor = frameActor(id)
      const snapshot = verifyOnly ? await actor.snapshot() : await actor.initialize(frames)
      if (!snapshot.initialized || snapshot.deleted || snapshot.revision !== 0)
        throw new Error(
          `Canvas ${id}: actor is uninitialized, deleted, or already accepting edits. Keep writers stopped.`,
        )
      const byId = (frames: Frame[]) => [...frames].sort((a, b) => a.id.localeCompare(b.id))
      if (!isDeepStrictEqual(byId(frames), byId(snapshot.frames)))
        throw new Error(`Canvas ${id}: SQL and actor frames differ. Nothing was overwritten; do not start the app.`)
      count += frames.length
      console.log(`[cutover] Verified canvas ${id}: ${frames.length} frames`)
    }
    await sql.query('COMMIT')
    console.log(`[cutover] Verified ${canvases.rowCount} canvases and ${count} frames. SQL was not modified.`)
  } finally {
    // Disconnecting also rolls back and releases locks after any failure.
    await sql.end()
  }
}

try {
  await migrate()
} catch (error) {
  console.error(`[cutover] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
