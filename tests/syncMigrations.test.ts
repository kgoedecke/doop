import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { expect, it } from 'vitest'

it.each(['pre-chat', 'main', 'hosted-claude', 'current-hosted-claude'])(
  'upgrades %s without losing preferences or applying deferred Figma changes',
  async (history) => {
    const migrationsFolder = path.resolve('server/db/migrations')
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string; idx: number; when: number }[]
    }
    const baseline = await mkdtemp(path.join(tmpdir(), 'doop-sync-migrations-'))
    const client = new PGlite()
    try {
      await mkdir(path.join(baseline, 'meta'))
      const entries = journal.entries.filter((entry) =>
        history === 'main'
          ? entry.tag !== '0029_remote_claude'
          : entry.tag < (history === 'current-hosted-claude' ? '0028' : '0018'),
      )
      await writeFile(path.join(baseline, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
      for (const entry of entries) {
        await copyFile(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(baseline, `${entry.tag}.sql`))
      }
      const db = drizzle(client)
      await migrate(db, { migrationsFolder: baseline })
      await client.exec(
        "INSERT INTO local_agent_preferences (user_id, enabled, model) VALUES ('existing-user', true, 'default')",
      )
      if (history === 'hosted-claude' || history === 'current-hosted-claude') {
        // Earlier branch databases had these columns and a migration timestamp
        // newer than main's chat migration. Reproduce that historical state
        // without retaining obsolete migrations in the production directory.
        await client.exec(`
          ALTER TABLE local_agent_preferences
            ADD COLUMN transport text NOT NULL DEFAULT 'local',
            ADD COLUMN remote_auth_attempt text,
            ADD COLUMN remote_auth_required boolean NOT NULL DEFAULT false,
            ADD COLUMN remote_auth_generation integer NOT NULL DEFAULT 0;
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
            VALUES ('legacy-claude-branch', ${history === 'current-hosted-claude' ? 1791942090750 : 1790025364364});
          UPDATE local_agent_preferences SET transport = 'remote',
            remote_auth_attempt = 'keep-attempt', remote_auth_required = true,
            remote_auth_generation = 17;
        `)
      }
      if (history === 'main') {
        await client.exec(`INSERT INTO slack_installations (team_id, user_id, bot_user_id, name, bot_token, connected_at)
          VALUES ('existing-team', 'existing-user', 'bot', 'Team', 'keep-token', 1)`)
      }
      await migrate(db, { migrationsFolder })
      await migrate(db, { migrationsFolder })
      if (history === 'main') {
        expect((await client.query('SELECT bot_token FROM slack_installations')).rows).toEqual([
          { bot_token: 'keep-token' },
        ])
      }
      const existing = await client.query('SELECT user_id, enabled FROM local_agent_preferences')
      expect(existing.rows).toEqual([{ user_id: 'existing-user', enabled: true }])
      const preferences = await client.query(
        'SELECT transport, remote_auth_attempt, remote_auth_required, remote_auth_generation FROM local_agent_preferences',
      )
      expect(preferences.rows).toEqual([
        history === 'hosted-claude' || history === 'current-hosted-claude'
          ? {
              transport: 'remote',
              remote_auth_attempt: 'keep-attempt',
              remote_auth_required: true,
              remote_auth_generation: 17,
            }
          : { transport: 'local', remote_auth_attempt: null, remote_auth_required: false, remote_auth_generation: 0 },
      ])
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
          'slack_installations',
          'slack_oauth_states',
          'slack_sessions',
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
  },
  30_000,
)
