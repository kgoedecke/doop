import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema.ts'

/**
 * DATABASE_URL set   -> real Postgres (production: Railway/Fly managed PG)
 * DATABASE_URL unset -> PGlite, an embedded Postgres persisted to ./data/pg
 * Same dialect, same schema, same queries either way.
 *
 * Schema changes: edit schema.ts / auth-schema.ts, then `npx drizzle-kit
 * generate` — the SQL lands in ./migrations and is applied here at boot.
 * Migration 0000 doubles as a baseline: fully idempotent, so databases
 * created by the pre-migration boot DDL adopt the journal cleanly.
 */

export type Db = NodePgDatabase<typeof schema>

export let db: Db

/* resolved from this file, not process.cwd() — the server may be launched
   from anywhere (tests spawn it from a temp working directory) */
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function initDb(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (url) {
    const { drizzle } = await import('drizzle-orm/node-postgres')
    db = drizzle(url, { schema })
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    await migrate(db, { migrationsFolder: MIGRATIONS })
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    const { drizzle } = await import('drizzle-orm/pglite')
    const dir = path.join(process.cwd(), 'data', 'pg')
    fs.mkdirSync(dir, { recursive: true }) // PGlite's own mkdir isn't recursive
    const pidFile = path.join(dir, 'postmaster.pid')
    if (fs.existsSync(pidFile)) {
      try {
        fs.unlinkSync(pidFile)
      } catch {
        /* ignore if already removed or inaccessible */
      }
    }
    const client = new PGlite(dir)
    const pgliteDb = drizzle(client, { schema })
    const { migrate } = await import('drizzle-orm/pglite/migrator')
    await migrate(pgliteDb, { migrationsFolder: MIGRATIONS })
    db = pgliteDb as unknown as Db
  }
}
