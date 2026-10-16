import { env } from '../env.ts'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.ts'
import { slackInstallations, slackOAuthStates } from '../db/schema.ts'
import { SlackError } from './client.ts'

export type Installation = typeof slackInstallations.$inferSelect
export const publicOrigin = () => env.BETTER_AUTH_URL
export const redirectUri = () => `${publicOrigin()}/api/integrations/slack/callback`
export const agentEnabled = () => !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET)
/** Exactly the saved app manifest: hear mentions, answer in threads, take
 *  /doop, and (reserved for uploads and thread reads) files and history. */
export const BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'commands',
  'files:write',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
]
const hash = (value: string) => createHash('sha256').update(value).digest('base64url')

export async function startInstall(userId: string) {
  if (!agentEnabled()) throw new SlackError('The Slack agent is not configured on this server.', 400)
  const state = randomBytes(32).toString('base64url')
  await db.delete(slackOAuthStates).where(lt(slackOAuthStates.expiresAt, Date.now()))
  await db.insert(slackOAuthStates).values({ hash: hash(state), userId, expiresAt: Date.now() + 10 * 60_000 })
  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID!,
    scope: BOT_SCOPES.join(','),
    redirect_uri: redirectUri(),
    state,
  })
  return { url: `https://slack.com/oauth/v2/authorize?${params}` }
}

const tokenSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  token_type: z.literal('bot'),
  bot_user_id: z.string().min(1),
  team: z.object({ id: z.string().min(1), name: z.string() }),
})

async function exchange(code: string) {
  let response: Response
  try {
    response = await fetch(`${env.SLACK_API_URL}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID ?? '',
        client_secret: env.SLACK_CLIENT_SECRET ?? '',
        code,
        redirect_uri: redirectUri(),
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new SlackError('Could not reach Slack. Try installing again.')
  }
  const result = tokenSchema.safeParse(await response.json().catch(() => null))
  if (!response.ok || !result.success)
    throw new SlackError('Slack authorization expired or was rejected. Install Doop again.', 409)
  return result.data
}

export async function finishInstall(userId: string, state: string, code: string) {
  if (!agentEnabled()) throw new SlackError('The Slack agent is not configured.', 400)
  const [roundTrip] = await db
    .delete(slackOAuthStates)
    .where(
      and(
        eq(slackOAuthStates.hash, hash(state)),
        eq(slackOAuthStates.userId, userId),
        gt(slackOAuthStates.expiresAt, Date.now()),
      ),
    )
    .returning()
  if (!roundTrip || !code) throw new SlackError('The Slack handoff expired. Start the installation again.', 400)
  const grant = await exchange(code)
  // Never let a second installer silently take over another person's model billing.
  const [existing] = await db.select().from(slackInstallations).where(eq(slackInstallations.userId, userId))
  if (existing && existing.teamId !== grant.team.id) {
    throw new SlackError('Disconnect your current Slack workspace before installing another.', 409)
  }
  const values = {
    userId,
    botUserId: grant.bot_user_id,
    name: grant.team.name || 'Slack workspace',
    botToken: grant.access_token,
    connectedAt: Date.now(),
  }
  const rows = await db
    .insert(slackInstallations)
    .values({ teamId: grant.team.id, ...values })
    .onConflictDoUpdate({
      target: slackInstallations.teamId,
      set: values,
      setWhere: eq(slackInstallations.userId, userId),
    })
    .returning()
  if (!rows.length)
    throw new SlackError('This Slack workspace already has a Doop installer. Ask them to disconnect it first.', 409)
}

export async function getInstallation(userId: string) {
  const [row] = await db.select().from(slackInstallations).where(eq(slackInstallations.userId, userId))
  return row
}

export async function installationForTeam(teamId: string) {
  const [row] = await db.select().from(slackInstallations).where(eq(slackInstallations.teamId, teamId))
  return row
}
