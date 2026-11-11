import { and, eq, inArray } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as authSchema from './db/auth-schema.ts'

/**
 * Per-user feature flags, one `feature_flags` row per user a flag is on for.
 * The server keeps the table in memory and reads it again every
 * REFRESH_MS, so `bun run flags` (another process) takes effect without a
 * restart. Lookups are synchronous: callers decide on the hot path.
 */
export class FeatureFlags {
  private enabled = new Map<string, Set<string>>()
  private read = false
  private timer: ReturnType<typeof setInterval> | undefined

  /** Load the table, then keep it fresh until `stop`. A failed read leaves
   *  every flag off rather than holding up boot. */
  async start(): Promise<void> {
    await this.refresh().catch(logRefreshFailure)
    this.timer ??= setInterval(() => void this.refresh().catch(logRefreshFailure), REFRESH_MS)
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  async refresh(): Promise<void> {
    const rows = await db.select({ flag: t.featureFlags.flag, userId: t.featureFlags.userId }).from(t.featureFlags)
    const enabled = new Map<string, Set<string>>()
    for (const { flag, userId } of rows) enabled.set(flag, (enabled.get(flag) ?? new Set()).add(userId))
    this.enabled = enabled
    this.read = true
  }

  /** The table has been read at least once: until then "off" only means "not known". */
  get known(): boolean {
    return this.read
  }

  has(userId: string | undefined, flag: FeatureFlag): boolean {
    return !!userId && !!this.enabled.get(flag)?.has(userId)
  }

  /** Turn `flag` on for the accounts with these emails; returns the emails it found. */
  async enable(flag: FeatureFlag, emails: readonly string[]): Promise<string[]> {
    const users = await usersByEmail(emails)
    if (users.length)
      await db
        .insert(t.featureFlags)
        .values(users.map((user) => ({ flag, userId: user.id, createdAt: Date.now() })))
        .onConflictDoNothing()
    await this.refresh()
    return users.map((user) => user.email)
  }

  /** Turn `flag` off for the accounts with these emails; returns the emails it found. */
  async disable(flag: FeatureFlag, emails: readonly string[]): Promise<string[]> {
    const users = await usersByEmail(emails)
    if (users.length)
      await db.delete(t.featureFlags).where(
        and(
          eq(t.featureFlags.flag, flag),
          inArray(
            t.featureFlags.userId,
            users.map((user) => user.id),
          ),
        ),
      )
    await this.refresh()
    return users.map((user) => user.email)
  }

  /** Who has `flag` on, by email. */
  async list(flag: FeatureFlag): Promise<string[]> {
    const rows = await db
      .select({ email: authSchema.user.email })
      .from(t.featureFlags)
      .innerJoin(authSchema.user, eq(authSchema.user.id, t.featureFlags.userId))
      .where(eq(t.featureFlags.flag, flag))
      .orderBy(authSchema.user.email)
    return rows.map((row) => row.email)
  }
}

export const featureFlags = new FeatureFlags()

/** Canvases made by someone with this flag keep their frames in a Terse
 *  canvas actor (server/actorFrames.ts); everyone else's work as on main. */
export const CANVAS_ACTORS = 'canvas-actors'

export const FEATURE_FLAGS = [CANVAS_ACTORS] as const
export type FeatureFlag = (typeof FEATURE_FLAGS)[number]

export function isFeatureFlag(value: string): value is FeatureFlag {
  return (FEATURE_FLAGS as readonly string[]).includes(value)
}

/** The accounts with these emails (case-insensitive); unknown emails are left out. */
export async function usersByEmail(emails: readonly string[]): Promise<{ id: string; email: string }[]> {
  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))]
  if (!wanted.length) return []
  return db
    .select({ id: authSchema.user.id, email: authSchema.user.email })
    .from(authSchema.user)
    .where(inArray(authSchema.user.email, wanted))
}

const REFRESH_MS = 30_000

function logRefreshFailure(error: unknown) {
  console.error('[feature flags] refresh failed', error)
}
