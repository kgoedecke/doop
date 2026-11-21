import { and, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { agentIdentities } from './db/schema.ts'
import { isAgentBrandChoice, type AgentBrandChoice } from '../shared/agentBrand.ts'

/* Owners choose their agents' icons once and every later MCP call reads the
   choice, so the table is loaded into memory per user and never re-read on the
   hot path. The cache holds at most the most recently touched users; a load is
   shared by concurrent callers so a burst of tool calls runs one SELECT. */
const MAX_CACHED_USERS = 1000
const cache = new Map<string, Map<string, AgentBrandChoice>>()
const loading = new Map<string, Promise<Map<string, AgentBrandChoice>>>()

export type AgentIdentity = { agentName: string; brand: AgentBrandChoice }

/* Most recently touched users survive eviction, matching the credential cache
   in server/mcp.ts. */
function remember(userId: string, identities: Map<string, AgentBrandChoice>) {
  cache.delete(userId)
  cache.set(userId, identities)
  if (cache.size > MAX_CACHED_USERS) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
}

function touch(userId: string): Map<string, AgentBrandChoice> | undefined {
  const identities = cache.get(userId)
  if (!identities) return undefined
  cache.delete(userId)
  cache.set(userId, identities)
  return identities
}

/* A stored brand the build no longer knows is dropped rather than trusted: one
   corrupt row must not break a tool call for every other agent of that user. */
function loadIdentities(userId: string): Promise<Map<string, AgentBrandChoice>> {
  /* the async body suspends on the SELECT before it reads `self.promise`, so
     the holder is assigned by then; comparing identity tells us whether a
     write superseded this load while it was in flight */
  const self: { promise?: Promise<Map<string, AgentBrandChoice>> } = {}
  const promise = (async () => {
    try {
      const rows = await db
        .select({ agentName: agentIdentities.agentName, brand: agentIdentities.brand })
        .from(agentIdentities)
        .where(eq(agentIdentities.userId, userId))
      const identities = new Map<string, AgentBrandChoice>()
      for (const row of rows) if (isAgentBrandChoice(row.brand)) identities.set(row.agentName, row.brand)
      /* A write that ran while this SELECT was in flight dropped this entry; its
         cache update is newer than these rows, so they must not overwrite it. */
      if (loading.get(userId) === self.promise) {
        remember(userId, identities)
        loading.delete(userId)
      }
      return identities
    } catch (error) {
      if (loading.get(userId) === self.promise) loading.delete(userId)
      throw error
    }
  })()
  self.promise = promise
  loading.set(userId, promise)
  return promise
}

async function identitiesFor(userId: string): Promise<Map<string, AgentBrandChoice>> {
  const cached = touch(userId)
  if (cached) return cached
  const pending = loading.get(userId)
  if (pending) {
    await pending
    /* a write may have superseded that load; its rows are older than the DB */
    return touch(userId) ?? loadIdentities(userId)
  }
  return loadIdentities(userId)
}

/** Every icon choice this owner has made, read through the same per-user cache
 *  MCP calls use. Absent agents are automatic. */
export async function listAgentIdentities(userId: string): Promise<AgentIdentity[]> {
  const identities = await identitiesFor(userId)
  return [...identities].map(([agentName, brand]) => ({ agentName, brand }))
}

/** A synchronous lookup for one owner's agents, loaded once per process. Values
 *  are 'doop' when the owner opted out (an explicit Doop mark that must not fall
 *  back to detection) or a product mark; undefined means automatic. */
export async function agentIdentitiesFor(
  userId: string,
): Promise<(agentName: string | undefined) => AgentBrandChoice | undefined> {
  const identities = await identitiesFor(userId)
  /* Presence names are trimmed by resolveActor and the PUT stores that trimmed
     name, so a raw tool argument padded with spaces must still find its row. */
  return (agentName) => (agentName ? identities.get(agentName.trim()) : undefined)
}

/** Store or clear one choice. null deletes the row: the agent returns to
 *  automatic. The DB write is awaited before the cache changes, and any load
 *  already in flight is superseded so it cannot cache the pre-write snapshot. */
export async function setAgentIdentity(
  userId: string,
  agentName: string,
  brand: AgentBrandChoice | null,
): Promise<AgentIdentity | null> {
  /* Drop any in-flight load before the write: it reads pre-write rows and its
     completion must not cache them over this change. */
  loading.delete(userId)
  if (brand === null) {
    await db
      .delete(agentIdentities)
      .where(and(eq(agentIdentities.userId, userId), eq(agentIdentities.agentName, agentName)))
    /* loads started while the write was in flight read pre-write rows */
    loading.delete(userId)
    const cached = cache.get(userId)
    if (cached) {
      const next = new Map(cached)
      next.delete(agentName)
      remember(userId, next)
    }
    return null
  }
  await db
    .insert(agentIdentities)
    .values({ userId, agentName, brand })
    .onConflictDoUpdate({
      target: [agentIdentities.userId, agentIdentities.agentName],
      set: { brand },
    })
  loading.delete(userId)
  const cached = cache.get(userId)
  /* An uncached owner stays uncached: a one-row map would hide their other
     choices, while the next read loads the whole account fresh from the DB. */
  if (cached) {
    const next = new Map(cached)
    next.set(agentName, brand)
    remember(userId, next)
  }
  return { agentName, brand }
}
