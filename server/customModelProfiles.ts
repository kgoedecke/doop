import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { customModelProfiles, modelAccounts } from './db/schema.ts'
import { env } from './env.ts'
import { CustomInferenceError, customEndpointUrl, fetchCustomJson, validateCustomBaseUrl } from './customInference.ts'
import { isCustomModelId } from '../shared/customModel.ts'

/**
 * Saved OpenAI-compatible inference profiles. The profile row is the single
 * source of truth for an endpoint, its optional API key and its model; the
 * active account only points at one with `profileId`. Every read and write is
 * scoped by user, and views are produced by one redaction function so a key
 * cannot leak through a new route by accident.
 */

export interface CustomModelProfile {
  id: string
  userId: string
  name: string
  baseUrl: string
  /** internal only: never returned to a browser */
  apiKey?: string
  model: string
  supportsVision: boolean
  connectedAt: number
  updatedAt: number
}

export interface CustomModelProfileInput {
  name: string
  baseUrl: string
  apiKey?: string | null
  model: string
  supportsVision: boolean
}

export type CustomModelProfilePatch = Partial<CustomModelProfileInput>

/** The browser-facing shape. Deliberately has no apiKey field. */
export interface CustomModelProfileView {
  id: string
  name: string
  baseUrl: string
  model: string
  supportsVision: boolean
  active: boolean
  connectedAt: number
  updatedAt: number
}

export class CustomModelProfileNotFoundError extends Error {
  readonly code = 'not_found'
  constructor() {
    super('The custom endpoint profile was not found.')
    this.name = 'CustomModelProfileNotFoundError'
  }
}

export class CustomModelProfileInvalidError extends Error {
  readonly code = 'invalid_input'
  constructor(message: string) {
    super(message)
    this.name = 'CustomModelProfileInvalidError'
  }
}

const NAME_MAX = 80
const KEY_MAX = 4096

export { isCustomModelId }

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new CustomModelProfileInvalidError('Give the custom endpoint a name.')
  const name = value.trim()
  if (!name) throw new CustomModelProfileInvalidError('Give the custom endpoint a name.')
  if (name.length > NAME_MAX)
    throw new CustomModelProfileInvalidError(`Keep the custom endpoint name under ${NAME_MAX} characters.`)
  if ([...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new CustomModelProfileInvalidError('That custom endpoint name contains invalid characters.')
  }
  return name
}

function normalizeModel(value: unknown): string {
  if (!isCustomModelId(value)) {
    throw new CustomModelProfileInvalidError(
      'Enter a model id using letters, numbers, dots, dashes, underscores, slashes, colons, @ or +.',
    )
  }
  return value
}

function normalizeKey(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new CustomModelProfileInvalidError('That API key is not valid.')
  const key = value.trim()
  if (!key) return null
  if (key.length > KEY_MAX) throw new CustomModelProfileInvalidError('That API key is too long.')
  if ([...key].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new CustomModelProfileInvalidError('That API key contains invalid characters.')
  }
  return key
}

function toProfile(row: typeof customModelProfiles.$inferSelect): CustomModelProfile {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    baseUrl: row.baseUrl,
    ...(row.apiKey ? { apiKey: row.apiKey } : {}),
    model: row.model,
    supportsVision: row.supportsVision,
    connectedAt: row.connectedAt,
    updatedAt: row.updatedAt,
  }
}

export function profileView(profile: CustomModelProfile, activeProfileId?: string): CustomModelProfileView {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    supportsVision: profile.supportsVision,
    active: profile.id === activeProfileId,
    connectedAt: profile.connectedAt,
    updatedAt: profile.updatedAt,
  }
}

/** Which saved profile is currently active, if any. */
export async function activeCustomProfileId(userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ profileId: modelAccounts.profileId })
    .from(modelAccounts)
    .where(and(eq(modelAccounts.userId, userId), eq(modelAccounts.kind, 'custom-key')))
  return row?.profileId ?? undefined
}

export async function listProfiles(userId: string): Promise<CustomModelProfile[]> {
  const rows = await db
    .select()
    .from(customModelProfiles)
    .where(eq(customModelProfiles.userId, userId))
    .orderBy(asc(customModelProfiles.connectedAt), asc(customModelProfiles.id))
  return rows.map(toProfile)
}

export async function listProfileViews(userId: string): Promise<CustomModelProfileView[]> {
  const [profiles, active] = await Promise.all([listProfiles(userId), activeCustomProfileId(userId)])
  return profiles.map((profile) => profileView(profile, active))
}

export async function getProfile(userId: string, id: string): Promise<CustomModelProfile | null> {
  const [row] = await db
    .select()
    .from(customModelProfiles)
    .where(and(eq(customModelProfiles.userId, userId), eq(customModelProfiles.id, id)))
  return row ? toProfile(row) : null
}

async function normalizedBaseUrl(value: unknown): Promise<string> {
  if (typeof value !== 'string') throw new CustomModelProfileInvalidError('Enter the endpoint base URL.')
  return (await validateCustomBaseUrl(value, env.CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS)).href
}

export interface CustomEndpointTestResult {
  reachable: boolean
  models?: string[]
  errorCode?: string
  error?: string
}

/** Ask an endpoint for its model list without saving anything. The result
 *  carries only codes and ids; a pasted key is used for this one request and
 *  can never come back through a message or response body. `storedProfileId`
 *  lets the edit form test a saved endpoint with its existing key without
 *  ever sending that key back to the browser. */
export async function testCustomEndpoint(
  userId: string,
  input: {
    baseUrl: unknown
    apiKey?: unknown
    model?: unknown
    profileId?: unknown
  },
): Promise<CustomEndpointTestResult> {
  try {
    const baseUrl = await normalizedBaseUrl(input.baseUrl)
    let apiKey = normalizeKey(input.apiKey)
    if (input.profileId !== undefined) {
      if (typeof input.profileId !== 'string') throw new CustomModelProfileInvalidError('That profile is not valid.')
      const profile = await getProfile(userId, input.profileId)
      if (!profile) throw new CustomModelProfileNotFoundError()
      /* a blank key field on an edit keeps the stored key, so the test does
         the same instead of silently testing an unauthenticated request */
      if (input.apiKey === undefined) apiKey = profile.apiKey ?? null
    }
    if (input.model !== undefined) normalizeModel(input.model)
    const body = await fetchCustomJson(
      customEndpointUrl(new URL(baseUrl), 'models'),
      {
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      },
      { timeoutMs: 8_000 },
    )
    const data =
      body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : null
    if (!data) throw new CustomInferenceError('not_compatible', 'The custom endpoint did not return a model list.')
    const models: string[] = []
    const seen = new Set<string>()
    for (const entry of data) {
      if (!entry || typeof entry !== 'object') continue
      const id = (entry as { id?: unknown }).id
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      seen.add(id)
      models.push(id)
    }
    return { reachable: true, models }
  } catch (error) {
    if (error instanceof CustomInferenceError) return { reachable: false, errorCode: error.code, error: error.message }
    if (error instanceof CustomModelProfileInvalidError)
      return { reachable: false, errorCode: error.code, error: error.message }
    return {
      reachable: false,
      errorCode: 'unreachable',
      error: 'The custom endpoint could not be reached.',
    }
  }
}

export async function createProfile(userId: string, input: CustomModelProfileInput): Promise<CustomModelProfile> {
  const name = normalizeName(input.name)
  const model = normalizeModel(input.model)
  const baseUrl = await normalizedBaseUrl(input.baseUrl)
  const apiKey = normalizeKey(input.apiKey)
  const now = Date.now()
  const row = {
    id: randomUUID(),
    userId,
    name,
    baseUrl,
    apiKey,
    model,
    supportsVision: input.supportsVision !== false,
    connectedAt: now,
    updatedAt: now,
  }
  await db.insert(customModelProfiles).values(row)
  return toProfile(row)
}

export async function updateProfile(
  userId: string,
  id: string,
  patch: CustomModelProfilePatch,
): Promise<CustomModelProfile> {
  const existing = await getProfile(userId, id)
  if (!existing) throw new CustomModelProfileNotFoundError()
  const next = {
    name: patch.name === undefined ? existing.name : normalizeName(patch.name),
    baseUrl: patch.baseUrl === undefined ? existing.baseUrl : await normalizedBaseUrl(patch.baseUrl),
    model: patch.model === undefined ? existing.model : normalizeModel(patch.model),
    supportsVision: patch.supportsVision === undefined ? existing.supportsVision : patch.supportsVision !== false,
    apiKey: Object.hasOwn(patch, 'apiKey') ? normalizeKey(patch.apiKey) : (existing.apiKey ?? null),
  }
  await db
    .update(customModelProfiles)
    .set({ ...next, updatedAt: Date.now() })
    .where(and(eq(customModelProfiles.userId, userId), eq(customModelProfiles.id, id)))
  const updated = await getProfile(userId, id)
  if (!updated) throw new CustomModelProfileNotFoundError()
  /* when the edited profile is the active one, its model is what the account
     status and picker must show */
  await db
    .update(modelAccounts)
    .set({ model: updated.model, updatedAt: Date.now() })
    .where(and(eq(modelAccounts.userId, userId), eq(modelAccounts.kind, 'custom-key'), eq(modelAccounts.profileId, id)))
  return updated
}

export async function deleteProfile(userId: string, id: string): Promise<void> {
  const existing = await getProfile(userId, id)
  if (!existing) throw new CustomModelProfileNotFoundError()
  await db
    .delete(customModelProfiles)
    .where(and(eq(customModelProfiles.userId, userId), eq(customModelProfiles.id, id)))
  /* The account points at the profile, so deleting the active one must drop
     that pointer too. Guarded by profileId so a stale delete can never remove
     an account that has since switched to another profile. */
  await db
    .delete(modelAccounts)
    .where(and(eq(modelAccounts.userId, userId), eq(modelAccounts.kind, 'custom-key'), eq(modelAccounts.profileId, id)))
}
