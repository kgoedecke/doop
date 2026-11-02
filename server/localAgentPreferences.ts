import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { localAgentPreferences } from './db/schema.ts'
import { isClaudeEffort, normalizeClaudeModel, type LocalAgentPreference } from '../shared/localAgent.ts'

export async function getLocalAgentPreference(userId: string): Promise<LocalAgentPreference> {
  const [row] = await db.select().from(localAgentPreferences).where(eq(localAgentPreferences.userId, userId))
  return {
    enabled: row?.enabled ?? false,
    model: normalizeClaudeModel(row?.model),
    ...(isClaudeEffort(row?.effort) ? { effort: row.effort } : {}),
  }
}

export async function saveLocalAgentPreference(userId: string, preference: LocalAgentPreference) {
  const normalized = {
    enabled: preference.enabled,
    model: normalizeClaudeModel(preference.model),
    effort: preference.effort ?? null,
  }
  await db
    .insert(localAgentPreferences)
    .values({ userId, ...normalized })
    .onConflictDoUpdate({
      target: localAgentPreferences.userId,
      set: normalized,
    })
}
