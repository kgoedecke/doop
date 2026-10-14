import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.ts'
import { linearInstallations, linearOAuthStates } from '../db/schema.ts'
import { LinearError, linearQuery } from './client.ts'

export type Installation = typeof linearInstallations.$inferSelect
export const publicOrigin = () => (process.env.BETTER_AUTH_URL || 'http://localhost:4300').replace(/\/$/, '')
export const redirectUri = () => `${publicOrigin()}/api/integrations/linear/callback`
export const agentEnabled = () =>
  !!(process.env.LINEAR_CLIENT_ID && process.env.LINEAR_CLIENT_SECRET && process.env.LINEAR_WEBHOOK_SECRET)
const hash = (value: string) => createHash('sha256').update(value).digest('base64url')

export async function startInstall(userId: string) {
  if (!agentEnabled()) throw new LinearError('The Linear agent is not configured on this server.', 400)
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  await db.delete(linearOAuthStates).where(lt(linearOAuthStates.expiresAt, Date.now()))
  await db
    .insert(linearOAuthStates)
    .values({ hash: hash(state), verifier, userId, expiresAt: Date.now() + 10 * 60_000 })
  const params = new URLSearchParams({
    client_id: process.env.LINEAR_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    actor: 'app',
    scope: 'read,write,app:assignable',
    state,
    code_challenge: hash(verifier),
    code_challenge_method: 'S256',
    prompt: 'consent',
  })
  return { url: `https://linear.app/oauth/authorize?${params}` }
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
})

async function exchange(form: Record<string, string>) {
  let response: Response
  try {
    response = await fetch(process.env.LINEAR_TOKEN_URL || 'https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.LINEAR_CLIENT_ID ?? '',
        client_secret: process.env.LINEAR_CLIENT_SECRET ?? '',
        ...form,
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new LinearError('Could not reach Linear. Try connecting again.')
  }
  const result = tokenSchema.safeParse(await response.json().catch(() => null))
  if (!response.ok || !result.success)
    throw new LinearError('Linear authorization expired or was rejected. Reinstall the agent.', 409)
  return {
    accessToken: result.data.access_token,
    refreshToken: result.data.refresh_token,
    expiresAt: Date.now() + result.data.expires_in * 1000,
  }
}

export async function finishInstall(userId: string, state: string, code: string) {
  if (!agentEnabled()) throw new LinearError('The Linear agent is not configured.', 400)
  const [roundTrip] = await db
    .delete(linearOAuthStates)
    .where(
      and(
        eq(linearOAuthStates.hash, hash(state)),
        eq(linearOAuthStates.userId, userId),
        gt(linearOAuthStates.expiresAt, Date.now()),
      ),
    )
    .returning()
  if (!roundTrip || !code) throw new LinearError('The Linear handoff expired. Start the installation again.', 400)
  const tokens = await exchange({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
    code_verifier: roundTrip.verifier,
  })
  const identity = await linearQuery(
    `Bearer ${tokens.accessToken}`,
    'query DoopAgentIdentity { viewer { id name } organization { id name } }',
    {},
    z.object({
      viewer: z.object({ id: z.string(), name: z.string() }),
      organization: z.object({ id: z.string(), name: z.string() }),
    }),
  )
  // Never let a second installer silently take over another person's model billing.
  const [existing] = await db.select().from(linearInstallations).where(eq(linearInstallations.userId, userId))
  if (existing && existing.organizationId !== identity.organization.id) {
    throw new LinearError('Disconnect your current Linear agent workspace before installing another.', 409)
  }
  const values = {
    userId,
    appUserId: identity.viewer.id,
    name: identity.organization.name,
    ...tokens,
    connectedAt: Date.now(),
  }
  const rows = await db
    .insert(linearInstallations)
    .values({ organizationId: identity.organization.id, ...values })
    .onConflictDoUpdate({
      target: linearInstallations.organizationId,
      set: values,
      setWhere: eq(linearInstallations.userId, userId),
    })
    .returning()
  if (!rows.length)
    throw new LinearError('This Linear workspace already has a Doop installer. Ask them to disconnect it first.', 409)
}

export async function getInstallation(userId: string) {
  const [row] = await db.select().from(linearInstallations).where(eq(linearInstallations.userId, userId))
  return row
}

/** Serialize refresh-token rotation across workers using a database row lock. */
export async function agentToken(organizationId: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(linearInstallations)
      .where(eq(linearInstallations.organizationId, organizationId))
      .for('update')
    if (!row) throw new LinearError('The Linear agent has been disconnected.', 409)
    if (row.expiresAt > Date.now() + 5 * 60_000) return `Bearer ${row.accessToken}`
    const tokens = await exchange({ grant_type: 'refresh_token', refresh_token: row.refreshToken })
    await tx.update(linearInstallations).set(tokens).where(eq(linearInstallations.organizationId, organizationId))
    return `Bearer ${tokens.accessToken}`
  })
}
