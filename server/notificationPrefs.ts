import { and, eq, inArray } from 'drizzle-orm'
import { db } from './db/index.ts'
import { notificationPrefs } from './db/schema.ts'
import * as authSchema from './db/auth-schema.ts'
import type { NotificationPrefs } from '../shared/notifications.ts'

/**
 * Per-user notification switches. Stored sparsely: no row means the defaults,
 * which are all ON — comment email is opt-out, so the person who shared a
 * review link hears about the feedback without first finding a setting.
 */

const DEFAULTS: NotificationPrefs = { commentEmails: true }

export async function getNotificationPrefs(userId: string): Promise<NotificationPrefs> {
  const [row] = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId))
  return { commentEmails: row?.commentEmails ?? DEFAULTS.commentEmails }
}

export async function saveNotificationPrefs(userId: string, prefs: NotificationPrefs): Promise<void> {
  const row = { userId, commentEmails: prefs.commentEmails, updatedAt: Date.now() }
  await db
    .insert(notificationPrefs)
    .values(row)
    .onConflictDoUpdate({
      target: notificationPrefs.userId,
      set: { commentEmails: row.commentEmails, updatedAt: row.updatedAt },
    })
}

export interface Mailable {
  id: string
  name: string
  email: string
}

/** The accounts among these ids that comment email may go to: banned users
 *  and anyone who switched comment emails off are left out. */
export async function mailableForComments(ids: string[]): Promise<Mailable[]> {
  if (!ids.length) return []
  const rows = await db
    .select({
      id: authSchema.user.id,
      name: authSchema.user.name,
      email: authSchema.user.email,
      banned: authSchema.user.banned,
    })
    .from(authSchema.user)
    .where(inArray(authSchema.user.id, ids))
  const off = await db
    .select({ userId: notificationPrefs.userId })
    .from(notificationPrefs)
    .where(and(inArray(notificationPrefs.userId, ids), eq(notificationPrefs.commentEmails, false)))
  const muted = new Set(off.map((r) => r.userId))
  return rows.filter((r) => !r.banned && !muted.has(r.id)).map(({ id, name, email }) => ({ id, name, email }))
}
