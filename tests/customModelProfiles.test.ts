import { sql } from 'drizzle-orm'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../server/db/index.ts'
import { customModelProfiles, modelAccounts } from '../server/db/schema.ts'
import { resealSecrets } from '../server/secretBackfill.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import {
  activeCustomProfileId,
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  listProfileViews,
  profileView,
  updateProfile,
} from '../server/customModelProfiles.ts'
import {
  activateCustomProfile,
  connectApiKey,
  disconnectCustomProfile,
  getAccount,
  getStatus,
  setAccountEffort,
  setAccountModel,
  takesReasoningEffort,
} from '../server/modelAccounts.ts'
import { CustomInferenceError } from '../server/customInference.ts'

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
}, 30_000)

beforeEach(async () => {
  stubEnv('CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS', '1')
  await db.delete(modelAccounts)
  await db.delete(customModelProfiles)
})

afterEach(unstubAllEnvs)

const input = (overrides: Partial<Parameters<typeof createProfile>[1]> = {}) => ({
  name: 'Local Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1/',
  model: 'qwen3.8-coder',
  supportsVision: false,
  ...overrides,
})

async function storedKey(id: string): Promise<string | null> {
  const [row] = await db
    .select({ stored: sql<string>`${customModelProfiles.apiKey}` })
    .from(customModelProfiles)
    .where(sql`${customModelProfiles.id} = ${id}`)
  return row?.stored ?? null
}

describe('custom model profiles', () => {
  it('isolates profiles by user and normalizes the base URL', async () => {
    const alice = await createProfile('alice', input({ apiKey: 'sk-alice-key' }))
    await createProfile('bob', input({ name: 'Bob endpoint', model: 'bob-model' }))

    expect(alice.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect((await listProfiles('alice')).map((p) => p.name)).toEqual(['Local Ollama'])
    expect(await getProfile('alice', (await listProfiles('bob'))[0]!.id)).toBeNull()
    expect((await listProfiles('alice')).some((p) => p.userId === 'bob')).toBe(false)
  })

  it('seals the API key and never puts it in a view', async () => {
    const profile = await createProfile('alice', input({ apiKey: 'sk-super-secret' }))
    expect(await getProfile('alice', profile.id)).toMatchObject({ apiKey: 'sk-super-secret' })
    const stored = await storedKey(profile.id)
    expect(stored).not.toContain('sk-super-secret')
    expect(stored).toMatch(/^enc:v1:/)

    const views = await listProfileViews('alice')
    expect(JSON.stringify(views)).not.toContain('sk-super-secret')
    expect(views[0]).not.toHaveProperty('apiKey')
    expect(profileView(profile, profile.id)).toMatchObject({ active: true, supportsVision: false })
  })

  it('preserves an omitted key, replaces a supplied one, and clears on null', async () => {
    const profile = await createProfile('alice', input({ apiKey: 'sk-first' }))
    await updateProfile('alice', profile.id, { name: 'Renamed' })
    expect((await getProfile('alice', profile.id))?.apiKey).toBe('sk-first')

    await updateProfile('alice', profile.id, { apiKey: 'sk-second' })
    expect((await getProfile('alice', profile.id))?.apiKey).toBe('sk-second')
    expect(await storedKey(profile.id)).not.toContain('sk-second')

    await updateProfile('alice', profile.id, { apiKey: null })
    const cleared = await getProfile('alice', profile.id)
    expect(cleared?.apiKey).toBeUndefined()
    expect(await storedKey(profile.id)).toBeNull()
  })

  it('rejects empty/overlong names and unsafe model ids', async () => {
    await expect(createProfile('alice', input({ name: '   ' }))).rejects.toThrow(/name/i)
    await expect(createProfile('alice', input({ name: 'x'.repeat(81) }))).rejects.toThrow(/80/)
    await expect(createProfile('alice', input({ model: '' }))).rejects.toThrow(/model id/i)
    await expect(createProfile('alice', input({ model: 'has spaces' }))).rejects.toThrow(/model id/i)
    await expect(createProfile('alice', input({ model: 'new\nline' }))).rejects.toThrow(/model id/i)
    expect((await listProfiles('alice')).length).toBe(0)
  })

  it('surfaces endpoint policy errors with stable codes', async () => {
    stubEnv('CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS', 'false')
    const error = await createProfile('alice', input()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CustomInferenceError)
    expect((error as CustomInferenceError).code).toBe('private_url_blocked')
  })

  it('deletes only the requested profile, and disconnects the account pointing at an active one', async () => {
    const one = await createProfile('alice', input({ name: 'One' }))
    const two = await createProfile('alice', input({ name: 'Two', model: 'model-two' }))
    await db.insert(modelAccounts).values({
      userId: 'alice',
      kind: 'custom-key',
      profileId: two.id,
      model: two.model,
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    })
    expect(await activeCustomProfileId('alice')).toBe(two.id)

    await deleteProfile('alice', one.id)
    expect((await listProfiles('alice')).map((p) => p.id)).toEqual([two.id])
    expect(await activeCustomProfileId('alice')).toBe(two.id)

    await deleteProfile('alice', two.id)
    expect(await listProfiles('alice')).toEqual([])
    expect(await activeCustomProfileId('alice')).toBeUndefined()
  })

  it('does not delete another user’s profile even with a guessed id', async () => {
    const bob = await createProfile('bob', input())
    await expect(deleteProfile('alice', bob.id)).rejects.toThrow(/not found/i)
    await expect(updateProfile('alice', bob.id, { name: 'Stolen' })).rejects.toThrow(/not found/i)
    expect((await getProfile('bob', bob.id))?.name).toBe('Local Ollama')
  })

  it('activates a profile as the one account, stores only its pointer, and reports its model', async () => {
    const profile = await createProfile('alice', input({ model: 'alice-model', supportsVision: false }))
    await connectApiKey('alice', 'sk-alice-openai-key')
    expect((await getAccount('alice'))?.kind).toBe('openai-key')

    const status = await activateCustomProfile('alice', profile.id)
    expect(status).toMatchObject({ connected: true, kind: 'custom-key', model: 'alice-model', profileId: profile.id })
    expect(status).not.toHaveProperty('apiKey')
    expect(JSON.stringify(status)).not.toContain('sk-alice-openai-key')

    const account = await getAccount('alice')
    expect(account).toMatchObject({ kind: 'custom-key', profileId: profile.id, model: 'alice-model' })
    /* the endpoint and key live in the profile, never copied onto the account */
    expect(account?.apiKey).toBeUndefined()
    expect(account).not.toHaveProperty('baseUrl')
    expect(takesReasoningEffort('custom-key')).toBe(false)
  })

  it('refuses to activate another user’s profile', async () => {
    const bob = await createProfile('bob', input())
    await expect(activateCustomProfile('alice', bob.id)).rejects.toThrow(/not found/i)
    expect(await getAccount('alice')).toBeNull()
  })

  it('writes a model pick through to the active profile and rejects unsafe ids', async () => {
    const profile = await createProfile('alice', input({ model: 'first-model' }))
    await activateCustomProfile('alice', profile.id)

    const status = await setAccountModel('alice', 'second-model')
    expect(status).toMatchObject({ kind: 'custom-key', model: 'second-model' })
    expect((await getProfile('alice', profile.id))?.model).toBe('second-model')
    expect((await getAccount('alice'))?.model).toBe('second-model')

    await expect(setAccountModel('alice', 'not a model')).rejects.toThrow(/unknown model/)
    await expect(setAccountEffort('alice', 'high')).rejects.toThrow(/only OpenAI/i)
  })

  it('keeps the active account in step when its profile model is edited', async () => {
    const profile = await createProfile('alice', input({ model: 'first-model' }))
    await activateCustomProfile('alice', profile.id)
    await updateProfile('alice', profile.id, { model: 'edited-model' })
    expect(await getStatus('alice')).toMatchObject({ kind: 'custom-key', model: 'edited-model' })
  })

  it('disconnects a custom account only when it still points at the deleted profile', async () => {
    const one = await createProfile('alice', input({ name: 'One' }))
    const two = await createProfile('alice', input({ name: 'Two', model: 'two-model' }))
    await activateCustomProfile('alice', one.id)

    await disconnectCustomProfile('alice', two.id)
    expect((await getStatus('alice')).kind).toBe('custom-key')

    await disconnectCustomProfile('alice', one.id)
    expect(await getAccount('alice')).toBeNull()
  })

  it('reseals legacy plaintext keys in the custom profile table on boot', async () => {
    const now = Date.now()
    await db.execute(sql`
      INSERT INTO custom_model_profiles
        (id, user_id, name, base_url, api_key, model, supports_vision, connected_at, updated_at)
      VALUES
        ('legacy-profile', 'alice', 'Legacy', 'https://provider.example/v1', 'legacy-plaintext-key',
         'legacy-model', true, ${now}, ${now})
    `)
    const before = await storedKey('legacy-profile')
    expect(before).toBe('legacy-plaintext-key')
    await resealSecrets(db)
    const after = await storedKey('legacy-profile')
    expect(after).toMatch(/^enc:v1:/)
    expect(after).not.toContain('legacy-plaintext-key')
  })
})
