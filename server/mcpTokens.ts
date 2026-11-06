import { sql } from 'drizzle-orm'
import { db } from './db/index.ts'

/** An agent idle for less than this keeps its sign-in: every refresh issues a
 *  new refresh token with a fresh lifetime, so only a client unused for the
 *  whole window has to sign in again. better-auth's MCP plugin defaults to
 *  seven days, which logged out anyone who skipped a week. Kept at 30 rather
 *  than longer because the plugin neither rotates nor revokes refresh tokens:
 *  a leaked one stays valid until it expires. */
export const MCP_REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60

const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000
const FIRST_PRUNE_AFTER_MS = 60_000

/** Deletes token rows whose refresh token has expired, keeping the newest row
 *  per user and client. That newest row stays because `hasOwnAgent` in
 *  `allowance.ts` reads any row, expired or not, as proof the user once
 *  connected an agent. Returns the number of rows deleted. */
export async function pruneExpiredMcpTokens(now = new Date()): Promise<number> {
  const result = await db.execute(sql`
    delete from oauth_access_token where id in (
      select id from (
        select id, refresh_token_expires_at,
          row_number() over (partition by user_id, client_id order by created_at desc, id desc) as newest
        from oauth_access_token
      ) ranked
      where newest > 1 and refresh_token_expires_at < ${now}
    )`)
  /* node-postgres reports rowCount, PGlite affectedRows */
  const counts = result as { rowCount?: number | null; affectedRows?: number }
  return counts.rowCount ?? counts.affectedRows ?? 0
}

function prune() {
  pruneExpiredMcpTokens()
    .then((deleted) => {
      if (deleted) console.log(`[mcp-tokens] pruned ${deleted} expired token rows`)
    })
    .catch((err) => console.error('[mcp-tokens] prune failed', err))
}

export function startMcpTokenPrune() {
  setTimeout(prune, FIRST_PRUNE_AFTER_MS).unref()
  setInterval(prune, PRUNE_EVERY_MS).unref()
}
