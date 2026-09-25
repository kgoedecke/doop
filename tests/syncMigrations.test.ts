import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { expect, it } from 'vitest'

it('upgrades an existing OSS database without the deferred Figma migration', async () => {
  const migrationsFolder = path.resolve('server/db/migrations')
  const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string; idx: number; when: number }[]
  }
  const baseline = await mkdtemp(path.join(tmpdir(), 'doop-sync-migrations-'))
  const client = new PGlite()
  try {
    await mkdir(path.join(baseline, 'meta'))
    const entries = journal.entries.filter((entry) => entry.tag < '0018')
    await writeFile(path.join(baseline, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    for (const entry of entries) {
      await copyFile(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(baseline, `${entry.tag}.sql`))
    }
    const db = drizzle(client)
    await migrate(db, { migrationsFolder: baseline })
    await client.exec(
      "INSERT INTO local_agent_preferences (user_id, enabled, model) VALUES ('existing-user', true, 'default')",
    )
    await migrate(db, { migrationsFolder })
    await migrate(db, { migrationsFolder })
    const existing = await client.query('SELECT user_id, enabled FROM local_agent_preferences')
    expect(existing.rows).toEqual([{ user_id: 'existing-user', enabled: true }])
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'chat_messages',
        'image_prefs',
        'agent_keys',
        'linear_installations',
        'linear_oauth_states',
        'linear_sessions',
      ]),
    )
    const deferred = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'integrations' AND column_name = 'refresh_token'",
    )
    expect(deferred.rows).toEqual([])
  } finally {
    await client.close()
    await rm(baseline, { recursive: true, force: true })
  }
}, 30_000)
