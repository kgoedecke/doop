import { PGlite } from '@electric-sql/pglite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('persists legacy membership before reordering, including after reopening the database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doop-legacy-pages-'))
  let db = new PGlite(dir)
  try {
    await db.exec(`CREATE TABLE canvases (id text PRIMARY KEY); CREATE TABLE frames (id text PRIMARY KEY, canvas_id text);
      INSERT INTO canvases VALUES ('legacy'); INSERT INTO frames VALUES ('old', 'legacy');`)
    const migration = (name: string) =>
      readFileSync(new URL(`../server/db/migrations/${name}`, import.meta.url), 'utf8').replaceAll(
        '--> statement-breakpoint',
        '',
      )
    await db.exec(migration('0026_canvas_pages.sql'))
    await db.exec(migration('0027_persist_legacy_page_membership.sql'))
    await db.exec(
      `UPDATE canvases SET pages = '[{"id":"new","name":"New"},{"id":"legacy:page1","name":"Page 1"}]'::jsonb`,
    )
    await db.close()
    db = new PGlite(dir)
    expect((await db.query('SELECT page_id FROM frames')).rows).toEqual([{ page_id: 'legacy:page1' }])
    expect((await db.query<{ pages: { id: string }[] }>('SELECT pages FROM canvases')).rows[0]!.pages[0]!.id).toBe(
      'new',
    )
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
