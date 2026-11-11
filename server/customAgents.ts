import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import { AGENT_ROLES, type AgentRole, type Roster } from '../shared/agents.ts'
import {
  MAX_CUSTOM_AGENTS,
  type AgentScope,
  type BuiltInAgent,
  type BuiltInAgentPatch,
  type CustomAgent,
  type CustomAgentInput,
  type CustomAgentPatch,
} from '../shared/customAgents.ts'

/**
 * Custom agents (shared/customAgents.ts) and each team's changes to the
 * built-in ones (`agent_overrides`). Read on every comment, card and
 * resident run, so the whole table is mirrored in memory at boot and kept
 * current by the writes below; the database is written before the mirror.
 *
 * Who may change a scope is the caller's question (server/customAgentRoutes.ts
 * asks workspace membership). Writes take it as `allowed` and ask again once
 * their turn in the scope's queue comes, since membership can end meanwhile;
 * this module stays free of the store, which persist.ts imports it beside.
 */

type AgentRow = typeof t.customAgents.$inferSelect
type OverrideRow = typeof t.agentOverrides.$inferSelect

const rows = new Map<string, AgentRow>()
/** by `overrideKey(scope, roleId)` */
const overrides = new Map<string, OverrideRow>()

function overrideKey(scope: string, roleId: string): string {
  return `${scope}\n${roleId}`
}

export class AgentInputError extends Error {}

export async function hydrateCustomAgents(): Promise<void> {
  const [all, changed] = await Promise.all([db.select().from(t.customAgents), db.select().from(t.agentOverrides)])
  rows.clear()
  for (const row of all) rows.set(row.id, row)
  overrides.clear()
  for (const row of changed) overrides.set(overrideKey(row.scope, row.roleId), row)
}

/** A built-in agent with one team's changes applied. */
function withOverride(role: AgentRole, row: OverrideRow | undefined): AgentRole {
  if (!row) return role
  return {
    ...role,
    ...(row.color ? { color: row.color } : {}),
    ...(row.blurb ? { blurb: row.blurb } : {}),
    ...(row.brief ? { brief: row.brief, briefByTeam: true } : {}),
    ...(row.reviewer !== null ? { reviewer: row.reviewer } : {}),
  }
}

function builtInsIn(key: string): BuiltInAgent[] {
  return AGENT_ROLES.map((role) => {
    const row = overrides.get(overrideKey(key, role.id))
    const edited = !!row && (!!row.color || !!row.blurb || !!row.brief || row.reviewer !== null)
    return { ...withOverride(role, row), enabled: !row?.disabled, edited }
  })
}

/** The built-in team as one scope has it, switched-off agents included. */
export function listBuiltInAgents(scope: AgentScope, userId: string): BuiltInAgent[] {
  return builtInsIn(scopeKey(scope, userId))
}

function scopeKey(scope: AgentScope, userId: string): string {
  return 'workspaceId' in scope ? `ws:${scope.workspaceId}` : `user:${userId}`
}

function toAgent(row: AgentRow): CustomAgent {
  return {
    id: row.handle,
    name: row.name,
    color: row.color,
    blurb: row.blurb,
    brief: row.brief,
    ...(row.reviewer ? { reviewer: true } : {}),
    custom: true,
    createdAt: row.createdAt,
  }
}

function rowsIn(key: string): AgentRow[] {
  return [...rows.values()].filter((row) => row.scope === key).sort((a, b) => a.createdAt - b.createdAt)
}

export function listCustomAgents(scope: AgentScope, userId: string): CustomAgent[] {
  return rowsIn(scopeKey(scope, userId)).map(toAgent)
}

/** The scope a canvas takes its agents from: its workspace's, or its owner's. */
function canvasScopeKey(canvas: { workspaceId?: string | null; ownerId?: string | null }): string | undefined {
  if (canvas.workspaceId) return `ws:${canvas.workspaceId}`
  return canvas.ownerId ? `user:${canvas.ownerId}` : undefined
}

export function customAgentsForCanvas(canvas: { workspaceId?: string | null; ownerId?: string | null }): CustomAgent[] {
  const key = canvasScopeKey(canvas)
  return key ? rowsIn(key).map(toAgent) : []
}

/** A canvas's team as its viewers get it (the canvas GET, the room):
 *  everything the mention picker and the marks need, but no instructions,
 *  which stay with the people who manage the agents (anyone with a view link
 *  would read them otherwise). */
export function teamOfCanvas(canvas: { workspaceId?: string | null; ownerId?: string | null }): AgentRole[] {
  return rosterFor(canvas).map(({ briefByTeam: _briefByTeam, ...role }) => ({ ...role, brief: '' }))
}

/** The team a canvas's work is addressed with: the built-in agents its team
 *  has on (with its changes), then its custom agents. The built-in team as it
 *  ships for a canvas that is gone or has no owner. */
export function rosterFor(canvas: { workspaceId?: string | null; ownerId?: string | null } | undefined): Roster {
  const key = canvas && canvasScopeKey(canvas)
  if (!key) return AGENT_ROLES
  const builtIns = builtInsIn(key)
    .filter((role) => role.enabled)
    .map(({ enabled: _enabled, edited: _edited, ...role }) => role)
  return [...builtIns, ...rowsIn(key).map(toAgent)]
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

export async function createCustomAgent(
  scope: AgentScope,
  userId: string,
  input: CustomAgentInput,
  allowed: () => boolean,
): Promise<CustomAgent> {
  const key = scopeKey(scope, userId)
  return inScopeOrder(key, async () => {
    /* checked in the queue: the person may have left the workspace meanwhile */
    if (!allowed()) throw new AgentInputError('this workspace no longer exists or you left it')
    const existing = rowsIn(key)
    if (existing.length >= MAX_CUSTOM_AGENTS)
      throw new AgentInputError(`a team has room for ${MAX_CUSTOM_AGENTS} custom agents — remove one first`)
    if (existing.some((r) => r.handle === input.handle))
      throw new AgentInputError(`@${input.handle} is already taken here`)
    if (existing.some((r) => r.name.toLowerCase() === input.name.toLowerCase()))
      throw new AgentInputError(`${input.name} is already on the team`)
    const now = Date.now()
    const row: AgentRow = {
      id: nanoid(10),
      scope: key,
      handle: input.handle,
      name: input.name,
      color: input.color,
      blurb: input.blurb,
      brief: input.brief,
      reviewer: input.reviewer,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    }
    await db.insert(t.customAgents).values(row)
    rows.set(row.id, row)
    return toAgent(row)
  })
}

function findRow(key: string, handle: string): AgentRow | undefined {
  for (const row of rows.values()) if (row.scope === key && row.handle === handle) return row
  return undefined
}

export async function updateCustomAgent(
  scope: AgentScope,
  userId: string,
  handle: string,
  patch: CustomAgentPatch,
  allowed: () => boolean,
): Promise<CustomAgent | undefined> {
  const key = scopeKey(scope, userId)
  return inScopeOrder(key, async () => {
    const row = findRow(key, handle)
    if (!row || !allowed()) return undefined
    const next: AgentRow = { ...row, ...patch, updatedAt: Date.now() }
    await db
      .update(t.customAgents)
      .set({
        color: next.color,
        blurb: next.blurb,
        brief: next.brief,
        reviewer: next.reviewer,
        updatedAt: next.updatedAt,
      })
      .where(eq(t.customAgents.id, row.id))
    rows.set(row.id, next)
    return toAgent(next)
  })
}

/** Remove an agent. Work still waiting on it goes to the default agent
 *  (`roleName` falls back), and its finished work keeps its name. */
export async function deleteCustomAgent(
  scope: AgentScope,
  userId: string,
  handle: string,
  allowed: () => boolean,
): Promise<boolean> {
  const key = scopeKey(scope, userId)
  return inScopeOrder(key, async () => {
    const row = findRow(key, handle)
    if (!row || !allowed()) return false
    await db.delete(t.customAgents).where(eq(t.customAgents.id, row.id))
    rows.delete(row.id)
    return true
  })
}

/** Change a built-in agent for one scope. Fields left out keep their current
 *  value; a row that ends up changing nothing is removed. */
export async function updateBuiltInAgent(
  scope: AgentScope,
  userId: string,
  roleId: string,
  patch: BuiltInAgentPatch,
  allowed: () => boolean,
): Promise<BuiltInAgent | undefined> {
  const key = scopeKey(scope, userId)
  const stock = AGENT_ROLES.find((role) => role.id === roleId)
  if (!stock) return undefined
  return inScopeOrder(key, async () => {
    if (!allowed()) throw new AgentInputError('this workspace no longer exists or you left it')
    const current = overrides.get(overrideKey(key, roleId))
    /* a value equal to how the agent ships is stored as no change, so
       "Reset" and an edit back to the original read the same */
    const differs = <T>(value: T | undefined, shipped: T | undefined, kept: T | null): T | null =>
      value === undefined ? kept : value === shipped ? null : value
    const next: OverrideRow = {
      scope: key,
      roleId,
      disabled: patch.disabled ?? current?.disabled ?? false,
      color: differs(patch.color, stock.color.toUpperCase(), current?.color ?? null),
      blurb: differs(patch.blurb, stock.blurb, current?.blurb ?? null),
      brief: differs(patch.brief, stock.brief, current?.brief ?? null),
      reviewer: differs(patch.reviewer, stock.reviewer ?? false, current?.reviewer ?? null),
      updatedBy: userId,
      updatedAt: Date.now(),
    }
    await writeOverride(next)
    return builtInsIn(key).find((role) => role.id === roleId)
  })
}

/** Undo a team's edits to a built-in agent; whether it is on stays as it is. */
export async function resetBuiltInAgent(
  scope: AgentScope,
  userId: string,
  roleId: string,
  allowed: () => boolean,
): Promise<BuiltInAgent | undefined> {
  const key = scopeKey(scope, userId)
  if (!AGENT_ROLES.some((role) => role.id === roleId)) return undefined
  return inScopeOrder(key, async () => {
    if (!allowed()) throw new AgentInputError('this workspace no longer exists or you left it')
    const disabled = overrides.get(overrideKey(key, roleId))?.disabled ?? false
    await writeOverride({
      scope: key,
      roleId,
      disabled,
      color: null,
      blurb: null,
      brief: null,
      reviewer: null,
      updatedBy: userId,
      updatedAt: Date.now(),
    })
    return builtInsIn(key).find((role) => role.id === roleId)
  })
}

async function writeOverride(row: OverrideRow): Promise<void> {
  const unchanged = !row.disabled && !row.color && !row.blurb && !row.brief && row.reviewer === null
  if (unchanged) return removeOverride(row.scope, row.roleId)
  await db
    .insert(t.agentOverrides)
    .values(row)
    .onConflictDoUpdate({ target: [t.agentOverrides.scope, t.agentOverrides.roleId], set: row })
  overrides.set(overrideKey(row.scope, row.roleId), row)
}

async function removeOverride(scope: string, roleId: string): Promise<void> {
  await db.delete(t.agentOverrides).where(and(eq(t.agentOverrides.scope, scope), eq(t.agentOverrides.roleId, roleId)))
  overrides.delete(overrideKey(scope, roleId))
}

/** Drop a deleted workspace's agents. */
export async function dropWorkspaceAgents(workspaceId: string): Promise<void> {
  await dropScope(`ws:${workspaceId}`)
}

/** Drop a deleted account's own agents. */
export async function dropPersonalAgents(userId: string): Promise<void> {
  await dropScope(`user:${userId}`)
}

async function dropScope(key: string): Promise<void> {
  await inScopeOrder(key, async () => {
    await db.delete(t.customAgents).where(eq(t.customAgents.scope, key))
    await db.delete(t.agentOverrides).where(eq(t.agentOverrides.scope, key))
    for (const [id, row] of rows) if (row.scope === key) rows.delete(id)
    for (const [id, row] of overrides) if (row.scope === key) overrides.delete(id)
  })
}
