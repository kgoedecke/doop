import { getTableColumns, getTableName, isNotNull, sql } from 'drizzle-orm'
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'
import type { Db } from './db/index.ts'
import {
  githubConnections,
  integrations,
  linearInstallations,
  modelAccounts,
  slackInstallations,
  webhooks,
} from './db/schema.ts'
import { needsReseal, open } from './secretBox.ts'

/** Every sealed column (`sealedText` in server/db/schema.ts), with its table's key. */
const SEALED: { table: PgTable; key: AnyPgColumn; columns: AnyPgColumn[] }[] = [
  {
    table: modelAccounts,
    key: modelAccounts.userId,
    columns: [modelAccounts.accessToken, modelAccounts.refreshToken, modelAccounts.apiKey],
  },
  { table: integrations, key: integrations.id, columns: [integrations.accessToken] },
  { table: githubConnections, key: githubConnections.id, columns: [githubConnections.token] },
  { table: webhooks, key: webhooks.id, columns: [webhooks.secret] },
  {
    table: linearInstallations,
    key: linearInstallations.organizationId,
    columns: [linearInstallations.accessToken, linearInstallations.refreshToken],
  },
  { table: slackInstallations, key: slackInstallations.teamId, columns: [slackInstallations.botToken] },
]

/** The table's property name for a column, which is what `.set()` is keyed by. */
function propertyOf(table: PgTable, column: AnyPgColumn): string {
  const entry = Object.entries(getTableColumns(table)).find(([, c]) => c === column)
  if (!entry) throw new Error(`${column.name} is not a column of ${getTableName(table)}`)
  return entry[0]
}

/**
 * Seals what is not yet sealed under the active key: rows written before
 * encryption existed or while no key was configured, and rows sealed under a
 * key that has since been rotated out. The read goes around the column's
 * decoder (a bare `sql` field) to see the stored form; the write goes through
 * it, so it seals. A row changed between the read and the write is left alone
 * (its new value was sealed by whoever wrote it).
 */
export async function resealSecrets(db: Db): Promise<{ resealed: number; failed: number }> {
  let resealed = 0
  let failed = 0
  for (const { table, key, columns } of SEALED) {
    for (const column of columns) {
      const property = propertyOf(table, column)
      const rows = await db
        .select({ key: sql<string>`${key}`, stored: sql<string>`${column}` })
        .from(table)
        .where(isNotNull(column))
      for (const row of rows) {
        if (!needsReseal(row.stored)) continue
        try {
          const updated = await db
            .update(table)
            .set({ [property]: open(row.stored) })
            .where(sql`${key} = ${row.key} and ${column} = ${row.stored}`)
            .returning({ key: sql<string>`${key}` })
          resealed += updated.length
        } catch (err) {
          failed++
          /* only the error's code: a driver error can carry the bound
             parameters, and for a legacy row one of them is the credential */
          const code = (err as { code?: unknown } | null)?.code
          console.error(
            `[secrets] could not reseal ${getTableName(table)}.${column.name}${typeof code === 'string' ? ` (${code})` : ''}`,
          )
        }
      }
    }
  }
  return { resealed, failed }
}
