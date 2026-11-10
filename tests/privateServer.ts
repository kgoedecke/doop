import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Client as PgClient } from 'pg'
import { startServer, type Server } from './harness.ts'

/** Dedicated opt-in test authority: never inherit the application's DATABASE_URL. */
export async function startPrivateServer(overrides: Record<string, string> = {}) {
  const authority = process.env.DOOP_TEST_DATABASE_URL
  if (!authority) throw new Error('DOOP_TEST_DATABASE_URL must name an owned disposable PostgreSQL server')
  const control = new PgClient({ connectionString: authority })
  const name = `doop_private_${randomUUID().replaceAll('-', '')}`
  const database = new URL(authority)
  database.pathname = `/${name}`
  const db = new PgClient({ connectionString: database.toString() })
  let server: Server | undefined
  let created = false
  let closed: Promise<void> | undefined
  const close = () =>
    (closed ??= (async () => {
      try {
        if (server) {
          server.stop({ keepData: true })
          await server.stopped
          await rm(server.dataDir, { recursive: true, force: true })
          server = undefined
        }
      } finally {
        await db.end()
        try {
          if (created) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        } finally {
          await control.end()
        }
      }
    })())
  try {
    await control.connect()
    await control.query(`CREATE DATABASE "${name}"`)
    created = true
    server = await startServer({ DATABASE_URL: database.toString(), BUCKET: '', ...overrides })
    await db.connect()
    return {
      get server(): Server {
        if (!server) throw new Error('private test server is closed')
        return server
      },
      databaseUrl: database.toString(),
      db,
      async restart() {
        if (!server || closed) throw new Error('private test server is closed')
        server.stop({ keepData: true })
        await server.stopped
        server = await startServer({ DATABASE_URL: database.toString(), BUCKET: '', ...overrides }, server.dataDir)
        return server
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
