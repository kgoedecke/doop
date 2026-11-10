import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Canvas } from '../shared/types.ts'
import * as schema from '../server/db/schema.ts'
import { Client } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'

const connection = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('../server/db/index.ts', () => ({
  get db() {
    return connection.db
  },
}))
let fixture: Awaited<ReturnType<typeof startPrivateServer>>
let pool: Pool
let canvas: Canvas
let persist: typeof import('../server/db/persist.ts')
beforeAll(async () => {
  fixture = await startPrivateServer()
  const owner = await new Client(fixture.server).signUp('revision@test.dev', 'Revision owner')
  canvas = await (await owner.post('/api/canvases', { name: 'Pooled revision' })).json()
  pool = new Pool({ connectionString: fixture.databaseUrl, max: 4 })
  connection.db = drizzle(pool, { schema })
  persist = await import('../server/db/persist.ts')
  await fixture.db.query(`
    CREATE TABLE revision_write_observations(revision bigint NOT NULL);
    CREATE FUNCTION observe_revision_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO revision_write_observations VALUES (NEW.updated_at); RETURN NEW; END $$;
    CREATE TRIGGER observe_revision_write AFTER UPDATE ON canvases
      FOR EACH ROW EXECUTE FUNCTION observe_revision_write();
  `)
}, 60000)
afterAll(async () => {
  await pool?.end()
  await fixture?.close()
})

it('keeps the highest document revision after a late older snapshot and competing pooled writers', async () => {
  const newest = canvas.updatedAt + 1000
  persist.saveCanvas({ ...canvas, updatedAt: newest })
  await expect
    .poll(async () => (await fixture.db.query('SELECT count(*)::int n FROM revision_write_observations')).rows[0].n)
    .toBe(1)
  persist.saveCanvas({ ...canvas, updatedAt: newest - 1 })
  await expect
    .poll(async () => (await fixture.db.query('SELECT count(*)::int n FROM revision_write_observations')).rows[0].n)
    .toBe(2)
  expect(
    Number((await fixture.db.query('SELECT updated_at FROM canvases WHERE id=$1', [canvas.id])).rows[0].updated_at),
  ).toBe(newest)
  // All calls enter the real pooled production persister without waiting for
  // each other. The trigger observes completion rather than assuming timing.
  for (let index = 0; index < 32; index++) persist.saveCanvas({ ...canvas, updatedAt: newest + 32 - index })
  await expect
    .poll(async () => (await fixture.db.query('SELECT count(*)::int n FROM revision_write_observations')).rows[0].n)
    .toBe(34)
  expect(
    Number((await fixture.db.query('SELECT updated_at FROM canvases WHERE id=$1', [canvas.id])).rows[0].updated_at),
  ).toBe(newest + 32)
})
