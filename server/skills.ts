import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import type { AgentScope } from '../shared/customAgents.ts'
import { MAX_SKILLS, type Skill, type SkillInput, type SkillPatch } from '../shared/skills.ts'

/**
 * Skills (shared/skills.ts), stored per scope the way custom agents are
 * (server/customAgents.ts, whose shape this copies): read at the start of
 * every resident run, so the table is mirrored in memory at boot and kept
 * current by the writes below; the database is written before the mirror.
 *
 * Who may change a scope is the caller's question (server/skillRoutes.ts asks
 * workspace membership). Writes take it as `allowed` and ask again once their
 * turn in the scope's queue comes, since membership can end meanwhile.
 */

type SkillRow = typeof t.skills.$inferSelect

const rows = new Map<string, SkillRow>()

export class SkillInputError extends Error {}

export async function hydrateSkills(): Promise<void> {
  const all = await db.select().from(t.skills)
  rows.clear()
  for (const row of all) rows.set(row.id, row)
}

function scopeKey(scope: AgentScope, userId: string): string {
  return 'workspaceId' in scope ? `ws:${scope.workspaceId}` : `user:${userId}`
}

function toSkill(row: SkillRow): Skill {
  return {
    handle: row.handle,
    description: row.description,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function rowsIn(key: string): SkillRow[] {
  return [...rows.values()].filter((row) => row.scope === key).sort((a, b) => a.createdAt - b.createdAt)
}

function findRow(key: string, handle: string): SkillRow | undefined {
  for (const row of rows.values()) if (row.scope === key && row.handle === handle) return row
  return undefined
}

export function listSkills(scope: AgentScope, userId: string): Skill[] {
  return rowsIn(scopeKey(scope, userId)).map(toSkill)
}

/** The skills a canvas's work may ask for: its workspace's, or its owner's. */
export function skillsForCanvas(canvas: { workspaceId?: string | null; ownerId?: string | null }): Skill[] {
  const key = canvas.workspaceId ? `ws:${canvas.workspaceId}` : canvas.ownerId ? `user:${canvas.ownerId}` : undefined
  return key ? rowsIn(key).map(toSkill) : []
}

const scopeChains = new Map<string, Promise<unknown>>()

/** Run a scope's writes one after another, so two creations racing for one
 *  handle are checked one at a time. */
function inScopeOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (scopeChains.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => {})
  scopeChains.set(key, settled)
  void settled.then(() => {
    if (scopeChains.get(key) === settled) scopeChains.delete(key)
  })
  return next
}

export async function createSkill(
  scope: AgentScope,
  userId: string,
  input: SkillInput,
  allowed: () => boolean,
): Promise<Skill> {
  const key = scopeKey(scope, userId)
  return inScopeOrder(key, async () => {
    /* checked in the queue: the person may have left the workspace meanwhile */
    if (!allowed()) throw new SkillInputError('this workspace no longer exists or you left it')
    const existing = rowsIn(key)
    if (existing.length >= MAX_SKILLS)
      throw new SkillInputError(`a team has room for ${MAX_SKILLS} skills — remove one first`)
    if (existing.some((r) => r.handle === input.handle))
      throw new SkillInputError(`/${input.handle} is already taken here`)
    const now = Date.now()
    const row: SkillRow = { id: nanoid(10), scope: key, ...input, createdBy: userId, createdAt: now, updatedAt: now }
    await db.insert(t.skills).values(row)
    rows.set(row.id, row)
    return toSkill(row)
  })
}

export async function updateSkill(
  scope: AgentScope,
  userId: string,
  handle: string,
  patch: SkillPatch,
  allowed: () => boolean,
): Promise<Skill | undefined> {
  const key = scopeKey(scope, userId)
  return inScopeOrder(key, async () => {
    const row = findRow(key, handle)
    if (!row || !allowed()) return undefined
    const next: SkillRow = { ...row, ...patch, updatedAt: Date.now() }
    await db
      .update(t.skills)
      .set({ description: next.description, body: next.body, updatedAt: next.updatedAt })
      .where(eq(t.skills.id, row.id))
    rows.set(row.id, next)
    return toSkill(next)
  })
}

export async function deleteSkill(
  scope: AgentScope,
  userId: string,
  handle: string,
  allowed: () => boolean,
): Promise<boolean> {
  const key = scopeKey(scope, userId)
  return inScopeOrder(key, async () => {
    const row = findRow(key, handle)
    if (!row || !allowed()) return false
    await db.delete(t.skills).where(eq(t.skills.id, row.id))
    rows.delete(row.id)
    return true
  })
}

/** Drop a deleted workspace's skills. */
export async function dropWorkspaceSkills(workspaceId: string): Promise<void> {
  await dropScope(`ws:${workspaceId}`)
}

/** Drop a deleted account's own skills. */
export async function dropPersonalSkills(userId: string): Promise<void> {
  await dropScope(`user:${userId}`)
}

async function dropScope(key: string): Promise<void> {
  await inScopeOrder(key, async () => {
    await db.delete(t.skills).where(eq(t.skills.scope, key))
    for (const [id, row] of rows) if (row.scope === key) rows.delete(id)
  })
}
