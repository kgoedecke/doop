import { and, eq, sql } from 'drizzle-orm'
import { db } from './db/index.ts'
import { localAgentPreferences } from './db/schema.ts'
import { normalizeClaudeModel, type LocalAgentPreference } from '../shared/localAgent.ts'

export async function getLocalAgentPreference(userId: string): Promise<LocalAgentPreference> {
  const [row] = await db.select().from(localAgentPreferences).where(eq(localAgentPreferences.userId, userId))
  return {
    remoteAuthAttempt: row?.remoteAuthAttempt ?? null,
    remoteAuthRequired: row?.remoteAuthRequired ?? false,
    remoteAuthGeneration: row?.remoteAuthGeneration ?? 0,
    transport: row?.transport === 'remote' ? 'remote' : 'local',
    enabled: row?.enabled ?? false,
    model: normalizeClaudeModel(row?.model),
  }
}

export async function saveLocalAgentPreference(userId: string, preference: LocalAgentPreference) {
  const normalized = {
    enabled: preference.enabled,
    transport: preference.transport ?? 'local',
    model: normalizeClaudeModel(preference.model),
  }
  await db
    .insert(localAgentPreferences)
    .values({ userId, ...normalized })
    .onConflictDoUpdate({
      target: localAgentPreferences.userId,
      set: normalized,
    })
}

/** Only the run's credential generation may mark the account blocked. */
export async function requireRemoteAuth(userId: string, generation: number) {
  await db
    .update(localAgentPreferences)
    .set({ remoteAuthRequired: true, remoteAuthAttempt: null })
    .where(
      and(
        eq(localAgentPreferences.userId, userId),
        eq(localAgentPreferences.remoteAuthGeneration, generation),
        eq(localAgentPreferences.remoteAuthRequired, false),
      ),
    )
}
export async function clearRemoteAuth(userId: string, generation: number, attemptId?: string) {
  const updated = await db
    .update(localAgentPreferences)
    .set({
      remoteAuthRequired: false,
      remoteAuthAttempt: null,
      remoteAuthGeneration: sql`${localAgentPreferences.remoteAuthGeneration} + 1`,
    })
    .where(
      and(
        eq(localAgentPreferences.userId, userId),
        eq(localAgentPreferences.remoteAuthGeneration, generation),
        eq(localAgentPreferences.remoteAuthRequired, !!attemptId),
        ...(attemptId ? [eq(localAgentPreferences.remoteAuthAttempt, attemptId)] : []),
      ),
    )
    .returning({ userId: localAgentPreferences.userId })
  if (!updated.length) throw new Error('Claude connection changed. Refresh and reconnect.')
}

export async function beginRemoteReauth(userId: string, attemptId: string) {
  await db
    .update(localAgentPreferences)
    .set({ remoteAuthAttempt: attemptId })
    .where(and(eq(localAgentPreferences.userId, userId), eq(localAgentPreferences.remoteAuthRequired, true)))
}

/** Invalidate pending login attempts before stopping hosted work and signing out. */
export async function disableRemoteExecution(userId: string) {
  await db
    .insert(localAgentPreferences)
    .values({ userId, enabled: false, remoteAuthRequired: true, remoteAuthGeneration: 1 })
    .onConflictDoUpdate({
      target: localAgentPreferences.userId,
      set: {
        enabled: sql`case when ${localAgentPreferences.transport} = 'remote' then false else ${localAgentPreferences.enabled} end`,
        remoteAuthRequired: true,
        remoteAuthAttempt: null,
        remoteAuthGeneration: sql`${localAgentPreferences.remoteAuthGeneration} + 1`,
      },
    })
}
