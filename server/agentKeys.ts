import { createHash } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import { agentKeys } from './db/schema.ts'

/**
 * Agent keys: account-scoped bearer credentials for the /mcp endpoint.
 *
 * The OAuth flow assumes a human at a browser to approve the connection;
 * a headless agent (a Mastra workflow, n8n, CI) has neither. A key minted
 * here goes into that client's `Authorization: Bearer dpk_…` header and
 * resolves to its owner on EVERY request — so revocation (row deletion)
 * and account bans bite immediately, with no issued-token grace window.
 *
 * The secret leaves the server exactly once, in the create response. At
 * rest only its sha256 lives here: the nanoid carries ~190 bits of entropy,
 * so a plain hash is preimage-proof without bcrypt's cost per MCP call.
 */

const PREFIX = 'dpk_'

/** Keys per account. A ceiling against unbounded growth, not a plan limit. */
const MAX_KEYS = 25

export interface AgentKeyInfo {
  id: string
  name: string
  /** the secret's first characters — enough to recognise, never to use */
  start: string
  createdAt: number
  lastUsedAt: number | null
}

const publicColumns = {
  id: agentKeys.id,
  name: agentKeys.name,
  start: agentKeys.start,
  createdAt: agentKeys.createdAt,
  lastUsedAt: agentKeys.lastUsedAt,
}

function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Whether a bearer credential is ours — routes it away from the OAuth path
 *  before any lookup, so a malformed key never triggers OAuth discovery. */
export function isAgentKeySecret(bearer: string): boolean {
  return bearer.startsWith(PREFIX)
}

/** null = the account is at MAX_KEYS. The ceiling is enforced by the insert
 *  itself (guarded INSERT ... SELECT, the same shape as allowance.ts's
 *  guarded upsert): counting first and inserting after would let concurrent
 *  requests each see room and all take it. An empty `returning` is the
 *  database refusing, and the column order below must match the schema's. */
export async function createAgentKey(
  userId: string,
  name: string,
): Promise<(AgentKeyInfo & { secret: string }) | null> {
  const secret = PREFIX + nanoid(32)
  const info: AgentKeyInfo = {
    id: nanoid(8),
    name: name.trim().slice(0, 60) || 'Agent key',
    start: secret.slice(0, PREFIX.length + 4),
    createdAt: Date.now(),
    lastUsedAt: null,
  }
  const inserted = await db
    .insert(agentKeys)
    .select(
      sql`select ${info.id}::text, ${hash(secret)}::text, ${userId}::text, ${info.name}::text, ${info.start}::text,
          ${info.createdAt}::bigint, null::bigint
          where (select count(*) from ${agentKeys} where ${agentKeys.userId} = ${userId}) < ${MAX_KEYS}`,
    )
    .returning({ id: agentKeys.id })
  if (!inserted.length) return null
  return { ...info, secret }
}

export function listAgentKeys(userId: string): Promise<AgentKeyInfo[]> {
  return db.select(publicColumns).from(agentKeys).where(eq(agentKeys.userId, userId)).orderBy(desc(agentKeys.createdAt))
}

/** Revocation is deletion: the next MCP request with the secret gets a 401. */
export async function deleteAgentKey(userId: string, id: string): Promise<boolean> {
  const gone = await db
    .delete(agentKeys)
    .where(and(eq(agentKeys.id, id), eq(agentKeys.userId, userId)))
    .returning({ id: agentKeys.id })
  return gone.length > 0
}

/* lastUsedAt is display metadata ("still in use?"), not an audit log — one
   design task is dozens of MCP calls, so touch the row at most once a
   minute per key rather than on every call */
const touched = new Map<string, number>()
const TOUCH_INTERVAL_MS = 60_000

/** The MCP gate: a valid secret resolves to the account it acts as. */
export async function verifyAgentKey(secret: string): Promise<{ userId: string } | null> {
  if (!/^dpk_[\w-]{20,}$/.test(secret)) return null
  const [key] = await db
    .select({ id: agentKeys.id, userId: agentKeys.userId })
    .from(agentKeys)
    .where(eq(agentKeys.secretHash, hash(secret)))
  if (!key) return null
  const now = Date.now()
  if (now - (touched.get(key.id) ?? 0) > TOUCH_INTERVAL_MS) {
    touched.set(key.id, now)
    db.update(agentKeys)
      .set({ lastUsedAt: now })
      .where(eq(agentKeys.id, key.id))
      .catch((err: unknown) => console.error('[agent-keys] lastUsedAt write failed', err))
  }
  return { userId: key.userId }
}
