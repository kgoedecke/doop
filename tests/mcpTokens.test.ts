import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as authSchema from '../server/db/auth-schema.ts'

const rig = vi.hoisted(() => ({ db: undefined as unknown as NodePgDatabase<typeof authSchema> }))
vi.mock('../server/db/index.ts', () => ({
  get db() {
    return rig.db
  },
}))
import { pruneExpiredMcpTokens } from '../server/mcpTokens.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-01T12:00:00Z')
const pg = new PGlite()

beforeAll(async () => {
  rig.db = drizzle(pg, { schema: authSchema }) as unknown as NodePgDatabase<typeof authSchema>
  await pg.exec(`create table oauth_access_token (
    id text primary key, access_token text not null unique, refresh_token text unique,
    access_token_expires_at timestamp, refresh_token_expires_at timestamp, client_id text not null,
    user_id text, scopes text not null, created_at timestamp not null default now(),
    updated_at timestamp not null default now())`)
})
afterAll(async () => {
  await pg.close()
})
beforeEach(async () => {
  await rig.db.delete(authSchema.oauthAccessToken)
})

async function token(id: string, userId: string, clientId: string, issuedDaysAgo: number, ttlDays: number) {
  const createdAt = new Date(NOW.getTime() - issuedDaysAgo * DAY)
  await rig.db.insert(authSchema.oauthAccessToken).values({
    id,
    accessToken: `at-${id}`,
    refreshToken: `rt-${id}`,
    refreshTokenExpiresAt: new Date(createdAt.getTime() + ttlDays * DAY),
    clientId,
    userId,
    scopes: 'openid offline_access',
    createdAt,
  })
}

async function remaining() {
  const rows = await rig.db.select({ id: authSchema.oauthAccessToken.id }).from(authSchema.oauthAccessToken)
  return rows.map((r) => r.id).sort()
}

it('deletes expired rows but keeps the newest per user and client', async () => {
  await token('old', 'alice', 'claude', 40, 7)
  await token('older', 'alice', 'claude', 50, 7)
  await token('newest', 'alice', 'claude', 20, 7)
  await token('codex', 'alice', 'codex', 60, 7)
  await token('bob', 'bob', 'claude', 45, 7)

  expect(await pruneExpiredMcpTokens(NOW)).toBe(2)
  expect(await remaining()).toEqual(['bob', 'codex', 'newest'])
})

it('leaves refresh tokens that are still valid alone', async () => {
  await token('live-old', 'alice', 'claude', 10, 30)
  await token('live-new', 'alice', 'claude', 1, 30)

  expect(await pruneExpiredMcpTokens(NOW)).toBe(0)
  expect(await remaining()).toEqual(['live-new', 'live-old'])
})
