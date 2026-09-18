import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { localAgentPreferences } from './db/schema.ts'
import type { LocalAgentPreference } from '../shared/localAgent.ts'

export async function getLocalAgentPreference(userId: string): Promise<LocalAgentPreference> {
  const [row] = await db.select().from(localAgentPreferences).where(eq(localAgentPreferences.userId, userId))
  return {
    enabled: row?.enabled ?? false,
    model: row?.model === 'sonnet' || row?.model === 'opus' ? row.model : 'default',
  }
}

export async function saveLocalAgentPreference(userId: string, preference: LocalAgentPreference) {
  await db
    .insert(localAgentPreferences)
    .values({ userId, ...preference })
    .onConflictDoUpdate({
      target: localAgentPreferences.userId,
      set: preference,
    })
}
