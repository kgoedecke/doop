import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { localAgentPreferences } from './db/schema.ts'
import { normalizeClaudeModel, type LocalAgentPreference } from '../shared/localAgent.ts'

export async function getLocalAgentPreference(userId: string): Promise<LocalAgentPreference> {
  const [row] = await db.select().from(localAgentPreferences).where(eq(localAgentPreferences.userId, userId))
  return {
    enabled: row?.enabled ?? false,
    model: normalizeClaudeModel(row?.model),
  }
}

export async function saveLocalAgentPreference(userId: string, preference: LocalAgentPreference) {
  const normalized = { ...preference, model: normalizeClaudeModel(preference.model) }
  await db
    .insert(localAgentPreferences)
    .values({ userId, ...normalized })
    .onConflictDoUpdate({
      target: localAgentPreferences.userId,
      set: normalized,
    })
}
