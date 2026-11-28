import { randomBytes } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from './db/index.ts'
import { sharedModelAccountPrefs, sharedModelAccounts } from './db/schema.ts'
import { open } from './secretBox.ts'
import { isReasoningEffort, type ReasoningEffort } from '../shared/modelMenu.ts'
import {
  CUSTOM_PROVIDER_PREFIX,
  MAX_CUSTOM_PROVIDERS,
  isCustomProviderKind,
  parseCustomHeaders,
  parseCustomProviderConfig,
  type CustomProviderConfig,
  type CustomProviderKind,
} from '../shared/customProvider.ts'
import type { CustomProviderSecrets, CustomProviderStatus } from './modelAccounts.ts'

/**
 * Shared providers: custom providers an instance admin sets up once, for
 * everyone (Admin → Shared models). A company running its own gateway
 * (LiteLLM, vLLM, Ollama…) then gives every person a working agent without
 * each of them pasting the same URL and key.
 *
 * The definition, key and headers are the admin's and live in
 * `shared_model_accounts`; what one person may change on it — the model they
 * picked, the effort, and switching it off for themselves — lives in
 * `shared_model_account_prefs`, so a pick never touches the definition or
 * anyone else. `modelAccounts.ts` merges the two into an ordinary model
 * account marked `shared`, which everything downstream runs like any other.
 */

/** What an admin can fix, said as is; `status` is the HTTP answer. */
export class SharedProviderError extends Error {
  readonly status: 400 | 404
  constructor(message: string, status: 400 | 404 = 400) {
    super(message)
    this.status = status
  }
}

/** A shared provider as stored, read back and re-checked. */
export interface SharedProvider {
  kind: CustomProviderKind
  custom: CustomProviderConfig
  apiKey?: string
  headers?: Record<string, string>
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** One person's own settings on a shared provider. */
export interface SharedProviderPrefs {
  model?: string
  effort?: ReasoningEffort
  enabled: boolean
}

/** A shared provider as Admin shows it: the description, which headers are
 *  set and whether there is a key, never their values. */
export interface SharedProviderStatus {
  kind: CustomProviderKind
  enabled: boolean
  custom: CustomProviderStatus
  createdAt: number
  updatedAt: number
}

/* The secrets are read in their stored (sealed) form, around the column's
   decoder (a bare `sql` field, as secretBackfill.ts reads them), and opened
   per row in toProvider: a key that cannot be opened (its encryption key
   rotated out, the value damaged) then takes out its own provider, not every
   person's accounts with it. */
const COLUMNS = {
  kind: sharedModelAccounts.kind,
  custom: sharedModelAccounts.custom,
  apiKey: sql<string | null>`${sharedModelAccounts.apiKey}`,
  customHeaders: sql<string | null>`${sharedModelAccounts.customHeaders}`,
  enabled: sharedModelAccounts.enabled,
  createdAt: sharedModelAccounts.createdAt,
  updatedAt: sharedModelAccounts.updatedAt,
}

interface Row {
  kind: string
  custom: unknown
  /** sealed, as stored */
  apiKey: string | null
  customHeaders: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** A sealed value opened, or undefined when it cannot be. */
function opened(stored: string | null): string | null | undefined {
  if (!stored) return null
  try {
    return open(stored)
  } catch {
    return undefined
  }
}

/** The row re-checked on the way out, as a personal provider's is, so a row
 *  written by another build can never run half-valid. */
function toProvider(row: Row): SharedProvider | null {
  if (!isCustomProviderKind(row.kind)) {
    console.warn(`[doop-agent] ignoring shared provider with unknown kind "${row.kind}"`)
    return null
  }
  const config = parseCustomProviderConfig(row.custom)
  if (!config.ok) {
    console.warn(`[doop-agent] ignoring shared provider ${row.kind}: ${config.error}`)
    return null
  }
  const apiKey = opened(row.apiKey)
  const customHeaders = opened(row.customHeaders)
  if (apiKey === undefined || customHeaders === undefined) {
    /* the reason only: the error text could quote the stored value */
    console.warn(`[doop-agent] ignoring shared provider ${row.kind}: its key or headers cannot be unsealed`)
    return null
  }
  let stored: unknown = {}
  try {
    stored = customHeaders ? JSON.parse(customHeaders) : {}
  } catch {
    stored = undefined
  }
  const headers = stored === undefined ? null : parseCustomHeaders(stored)
  if (!headers?.ok) {
    console.warn(`[doop-agent] ignoring shared provider ${row.kind}: unreadable headers`)
    return null
  }
  return {
    kind: row.kind,
    custom: config.value,
    ...(apiKey ? { apiKey } : {}),
    ...(Object.keys(headers.value).length ? { headers: headers.value } : {}),
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Every readable shared provider, on or off (or only those on), oldest first. */
export async function listSharedProviders(options: { enabledOnly?: boolean } = {}): Promise<SharedProvider[]> {
  const rows = await db
    .select(COLUMNS)
    .from(sharedModelAccounts)
    .where(options.enabledOnly ? eq(sharedModelAccounts.enabled, true) : undefined)
    .orderBy(asc(sharedModelAccounts.createdAt))
  return rows.map(toProvider).filter((provider): provider is SharedProvider => provider !== null)
}

/** One shared provider, on or off, or null when there is none (or it is unreadable). */
export async function getSharedProvider(kind: string): Promise<SharedProvider | null> {
  const [row] = await db.select(COLUMNS).from(sharedModelAccounts).where(eq(sharedModelAccounts.kind, kind))
  return row ? toProvider(row) : null
}

/** Whether this kind names a shared provider at all, readable or not. */
export async function isSharedKind(kind: string): Promise<boolean> {
  if (!isCustomProviderKind(kind)) return false
  const [row] = await db
    .select({ kind: sharedModelAccounts.kind })
    .from(sharedModelAccounts)
    .where(eq(sharedModelAccounts.kind, kind))
  return !!row
}

export function sharedStatusOf(provider: SharedProvider): SharedProviderStatus {
  return {
    kind: provider.kind,
    enabled: provider.enabled,
    custom: {
      ...provider.custom,
      headerNames: Object.keys(provider.headers ?? {}),
      hasKey: Boolean(provider.apiKey),
    },
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  }
}

function headersColumn(headers: Record<string, string>): string | null {
  return Object.keys(headers).length ? JSON.stringify(headers) : null
}

/** Add a shared provider; its kind is minted here, never taken from the request. */
export async function createSharedProvider(
  adminId: string,
  config: CustomProviderConfig,
  secrets: CustomProviderSecrets,
): Promise<CustomProviderKind> {
  const kind: CustomProviderKind = `${CUSTOM_PROVIDER_PREFIX}${randomBytes(9).toString('hex')}`
  const now = Date.now()
  /* count and insert under one lock, so two admins adding at once cannot
     both see room for one more */
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('shared-model-accounts'))`)
    const existing = await tx.select({ kind: sharedModelAccounts.kind }).from(sharedModelAccounts)
    if (existing.length >= MAX_CUSTOM_PROVIDERS) {
      throw new SharedProviderError(`An instance can share at most ${MAX_CUSTOM_PROVIDERS} custom providers`)
    }
    await tx.insert(sharedModelAccounts).values({
      kind,
      custom: config,
      apiKey: secrets.apiKey || null,
      customHeaders: secrets.headers ? headersColumn(secrets.headers) : null,
      enabled: true,
      createdBy: adminId,
      updatedBy: adminId,
      createdAt: now,
      updatedAt: now,
    })
  })
  return kind
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Why the stored key or headers may not go along with a request for
 *  `baseUrl`, or null when they may. They only ever go back to the origin
 *  they were saved for: a request for another origin brings its own (or says
 *  "none"), so nobody, an admin included, can send them somewhere new. */
export function movedSecretsRefusal(
  stored: { baseUrl: string; hasKey: boolean; hasHeaders: boolean },
  baseUrl: string,
  given: CustomProviderSecrets,
): string | null {
  const origin = originOf(stored.baseUrl)
  if (origin !== null && origin === originOf(baseUrl)) return null
  if (stored.hasKey && given.apiKey === undefined) {
    return 'The saved key is only sent to the address it was saved for. Enter the key again, or remove it, to use another address.'
  }
  if (stored.hasHeaders && given.headers === undefined) {
    return 'The saved headers are only sent to the address they were saved for. Enter them again, or remove them, to use another address.'
  }
  return null
}

/** Change a shared provider's description, and its key or headers only where
 *  new ones are given: an edit that leaves the key out keeps it, whoever
 *  changed it in between — as long as the endpoint keeps its origin. People's
 *  picks stay (a model no longer listed runs on the first one listed). */
export async function updateSharedProvider(
  adminId: string,
  kind: CustomProviderKind,
  config: CustomProviderConfig,
  secrets: CustomProviderSecrets,
): Promise<void> {
  await db.transaction(async (tx) => {
    /* held for the write, so the origin checked is the origin replaced */
    const [row] = await tx
      .select({ custom: COLUMNS.custom, apiKey: COLUMNS.apiKey, customHeaders: COLUMNS.customHeaders })
      .from(sharedModelAccounts)
      .where(eq(sharedModelAccounts.kind, kind))
      .for('update')
    if (!row) throw new SharedProviderError('That shared provider no longer exists', 404)
    const stored = parseCustomProviderConfig(row.custom)
    const refusal = movedSecretsRefusal(
      { baseUrl: stored.ok ? stored.value.baseUrl : '', hasKey: !!row.apiKey, hasHeaders: !!row.customHeaders },
      config.baseUrl,
      secrets,
    )
    if (refusal) throw new SharedProviderError(refusal)
    await tx
      .update(sharedModelAccounts)
      .set({
        custom: config,
        ...(secrets.apiKey !== undefined ? { apiKey: secrets.apiKey || null } : {}),
        ...(secrets.headers !== undefined ? { customHeaders: headersColumn(secrets.headers) } : {}),
        updatedBy: adminId,
        updatedAt: Date.now(),
      })
      .where(eq(sharedModelAccounts.kind, kind))
  })
}

/** Switch a shared provider on or off for everyone, keeping its definition. */
export async function setSharedProviderEnabled(
  adminId: string,
  kind: CustomProviderKind,
  enabled: boolean,
): Promise<void> {
  const written = await db
    .update(sharedModelAccounts)
    .set({ enabled, updatedBy: adminId, updatedAt: Date.now() })
    .where(eq(sharedModelAccounts.kind, kind))
    .returning({ kind: sharedModelAccounts.kind })
  if (!written.length) throw new SharedProviderError('That shared provider no longer exists', 404)
}

/** Remove a shared provider, and every person's settings on it. */
export async function deleteSharedProvider(kind: CustomProviderKind): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(sharedModelAccounts)
      .where(eq(sharedModelAccounts.kind, kind))
      .returning({ kind: sharedModelAccounts.kind })
    await tx.delete(sharedModelAccountPrefs).where(eq(sharedModelAccountPrefs.kind, kind))
    return deleted.length > 0
  })
}

function prefsOf(row: typeof sharedModelAccountPrefs.$inferSelect): SharedProviderPrefs {
  return {
    ...(row.model ? { model: row.model } : {}),
    ...(isReasoningEffort(row.reasoningEffort) ? { effort: row.reasoningEffort } : {}),
    enabled: row.enabled,
  }
}

/** This person's settings on every shared provider they changed anything on. */
export async function getSharedPrefs(userId: string): Promise<Map<string, SharedProviderPrefs>> {
  const rows = await db.select().from(sharedModelAccountPrefs).where(eq(sharedModelAccountPrefs.userId, userId))
  return new Map(rows.map((row) => [row.kind, prefsOf(row)]))
}

export async function getSharedPref(userId: string, kind: string): Promise<SharedProviderPrefs | undefined> {
  const [row] = await db
    .select()
    .from(sharedModelAccountPrefs)
    .where(and(eq(sharedModelAccountPrefs.userId, userId), eq(sharedModelAccountPrefs.kind, kind)))
  return row ? prefsOf(row) : undefined
}

/** Write ONLY the picked setting, and only while the provider still exists:
 *  the provider row is held for the write, so a delete either lands first
 *  (and the pick is refused) or after (and takes the pick with it). */
export async function saveSharedPref(
  userId: string,
  kind: CustomProviderKind,
  pick: { model: string } | { reasoningEffort: string } | { enabled: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [live] = await tx
      .select({ kind: sharedModelAccounts.kind })
      .from(sharedModelAccounts)
      .where(eq(sharedModelAccounts.kind, kind))
      .for('share')
    if (!live) throw new Error('the connected account changed — pick again')
    const now = Date.now()
    await tx
      .insert(sharedModelAccountPrefs)
      .values({ userId, kind, ...pick, updatedAt: now })
      .onConflictDoUpdate({
        target: [sharedModelAccountPrefs.userId, sharedModelAccountPrefs.kind],
        set: { ...pick, updatedAt: now },
      })
  })
}
