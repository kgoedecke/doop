import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { localAgentPreferences } from './db/schema.ts'
import { normalizeClaudeModel, type LocalAgentPreference } from '../shared/localAgent.ts'

export async function getLocalAgentPreference(userId: string): Promise<LocalAgentPreference> {
  const [row] = await db.select().from(localAgentPreferences).where(eq(localAgentPreferences.userId, userId))
  return {
    transport: row?.transport === 'remote' ? 'remote' : 'local',
    enabled: row?.enabled ?? false,
    model: normalizeClaudeModel(row?.model),
  }
}

export async function saveLocalAgentPreference(userId: string, preference: LocalAgentPreference) {
  const normalized = {
    ...preference,
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
