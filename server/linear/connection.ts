import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/index.ts'
import { integrations } from '../db/schema.ts'
import { LinearError, linearQuery } from './client.ts'

const owned = (userId: string) => and(eq(integrations.userId, userId), eq(integrations.provider, 'linear'))

export async function getConnection(userId: string) {
  const [row] = await db.select().from(integrations).where(owned(userId))
  return row
}

export async function connectionStatus(userId: string) {
  const row = await getConnection(userId)
  return row ? { connected: true, accountName: row.accountName, connectedAt: row.connectedAt } : { connected: false }
}

export async function connect(userId: string, token: string) {
  const accessToken = token.trim()
  if (!/^[A-Za-z0-9_-]{20,400}$/.test(accessToken)) throw new LinearError('Enter a valid Linear personal API key.', 400)
  const { viewer, organization } = await linearQuery(
    accessToken,
    'query DoopConnection { viewer { id name } organization { id name } }',
    {},
    z.object({
      viewer: z.object({ id: z.string(), name: z.string() }),
      organization: z.object({ id: z.string(), name: z.string() }),
    }),
  )
  const now = Date.now()
  const values = {
    accessToken,
    accountName: `${viewer.name} · ${organization.name}`,
    accounts: [],
    refreshToken: null,
    expiresAt: null,
    connectedAt: now,
    updatedAt: now,
  }
  await db
    .insert(integrations)
    .values({ id: nanoid(8), userId, provider: 'linear', ...values })
    .onConflictDoUpdate({ target: [integrations.userId, integrations.provider], set: values })
}

export async function disconnect(userId: string) {
  await db.delete(integrations).where(owned(userId))
}
