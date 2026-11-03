import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../server/db/index.ts'
import * as schema from '../server/db/schema.ts'
import { resealSecrets } from '../server/secretBackfill.ts'
import { isSealed, needsReseal, open, seal, sealedKeyId } from '../server/secretBox.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const KEY_A = `a:${Buffer.alloc(32, 1).toString('base64')}`
const KEY_B = `b:${Buffer.alloc(32, 2).toString('base64')}`

afterEach(unstubAllEnvs)

describe('seal / open', () => {
  it('round-trips under a fresh IV each time', () => {
    stubEnv('SECRETS_ENCRYPTION_KEYS', KEY_A)
    const one = seal('sk-live-123')
    const two = seal('sk-live-123')
    expect(one).not.toBe(two)
    expect(one).not.toContain('sk-live-123')
    expect(sealedKeyId(one)).toBe('a')
    expect(open(one)).toBe('sk-live-123')
    expect(open(two)).toBe('sk-live-123')
  })

  it('reads plaintext written before encryption as it is', () => {
    stubEnv('SECRETS_ENCRYPTION_KEYS', KEY_A)
    expect(open('xoxb-legacy')).toBe('xoxb-legacy')
    expect(needsReseal('xoxb-legacy')).toBe(true)
  })

  it('stores plaintext when no key is configured', () => {
    stubEnv('BETTER_AUTH_SECRET', 'x')
    stubEnv('BETTER_AUTH_URL', 'https://doop.example')
    stubEnv('SECRETS_ENCRYPTION_KEYS', undefined)
    stubEnv('NODE_ENV', 'production')
    expect(seal('sk-live-123')).toBe('sk-live-123')
    expect(needsReseal('sk-live-123')).toBe(false)
  })

  it('opens values sealed under a rotated-out key and marks them for resealing', () => {
    stubEnv('SECRETS_ENCRYPTION_KEYS', KEY_A)
    const old = seal('ghp_token')
    stubEnv('SECRETS_ENCRYPTION_KEYS', `${KEY_B},${KEY_A}`)
    expect(open(old)).toBe('ghp_token')
    expect(needsReseal(old)).toBe(true)
    expect(needsReseal(seal('ghp_token'))).toBe(false)
  })

  it('refuses a value whose key is gone, or that was tampered with', () => {
    stubEnv('SECRETS_ENCRYPTION_KEYS', KEY_A)
    const sealed = seal('sk-live-123')
    /* swap the second-to-last character for a different one (judging by the
       last character instead left it unchanged whenever it was already 'A') */
    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.slice(-1)
    expect(() => open(flipped)).toThrow()
    stubEnv('SECRETS_ENCRYPTION_KEYS', KEY_B)
    expect(() => open(sealed)).toThrow(/key "a"/)
  })

  it('rejects malformed keys at parse time', () => {
    expect(() => stubEnv('SECRETS_ENCRYPTION_KEYS', 'a:c2hvcnQ=')).toThrow(/32 bytes/)
    expect(() => stubEnv('SECRETS_ENCRYPTION_KEYS', `${KEY_A},${KEY_A}`)).toThrow(/unique/)
    expect(() => stubEnv('SECRETS_ENCRYPTION_KEYS', ', ,')).toThrow(/At least one/)
  })
})

describe('sealed columns', () => {
  const client = new PGlite()
  const db = drizzle(client, { schema }) as unknown as Db

  beforeAll(async () => {
    await migrate(drizzle(client, { schema }), {
      migrationsFolder: new URL('../server/db/migrations', import.meta.url).pathname,
    })
  }, 60_000)
  afterAll(() => client.close())

  const storedKey = async (userId: string) =>
    (await client.query<{ api_key: string }>('select api_key from model_accounts where user_id = $1', [userId]))
      .rows[0]!.api_key

  it('stores ciphertext and reads plaintext through drizzle', async () => {
    stubEnv('SECRETS_ENCRYPTION_KEYS', KEY_A)
    await db
      .insert(schema.modelAccounts)
      .values({ userId: 'u1', kind: 'openai-key', apiKey: 'sk-one', connectedAt: 1, updatedAt: 1 })
    expect(isSealed(await storedKey('u1'))).toBe(true)
    await db
      .insert(schema.modelAccounts)
      .values({ userId: 'u1', kind: 'openai-key', apiKey: 'sk-two', connectedAt: 1, updatedAt: 2 })
      .onConflictDoUpdate({ target: schema.modelAccounts.userId, set: { apiKey: 'sk-two', updatedAt: 2 } })
    expect(await storedKey('u1')).not.toContain('sk-two')
    const [row] = await db.select().from(schema.modelAccounts).where(eq(schema.modelAccounts.userId, 'u1'))
    expect(row!.apiKey).toBe('sk-two')
    expect(row!.accessToken).toBeNull()
  })

  it('seals legacy plaintext and re-seals rotated rows at boot', async () => {
    stubEnv('SECRETS_ENCRYPTION_KEYS', KEY_A)
    await client.query(
      `insert into model_accounts (user_id, kind, api_key, connected_at, updated_at) values ('legacy', 'openai-key', 'sk-legacy', 1, 1)`,
    )
    stubEnv('SECRETS_ENCRYPTION_KEYS', `${KEY_B},${KEY_A}`)
    const { resealed, failed } = await resealSecrets(db)
    expect(failed).toBe(0)
    expect(resealed).toBe(2) // the legacy row and u1, sealed under the retired key "a"
    expect(sealedKeyId(await storedKey('legacy'))).toBe('b')
    expect(sealedKeyId(await storedKey('u1'))).toBe('b')
    stubEnv('SECRETS_ENCRYPTION_KEYS', KEY_B)
    const rows = await db.select().from(schema.modelAccounts)
    expect(rows.map((r) => r.apiKey).sort()).toEqual(['sk-legacy', 'sk-two'])
    expect(await resealSecrets(db)).toEqual({ resealed: 0, failed: 0 })
  })
})
