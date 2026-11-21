import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { imageDescriptionPrefs } from './db/schema.ts'
import { isImageDescriptionMode, type ImageDescriptionMode } from '../shared/imageDescriptions.ts'

/** No row, or a row an older build wrote with a value we no longer know, reads as `account`. */
export async function getImageDescriptionMode(userId: string): Promise<ImageDescriptionMode> {
  const [row] = await db.select().from(imageDescriptionPrefs).where(eq(imageDescriptionPrefs.userId, userId))
  return isImageDescriptionMode(row?.mode) ? row.mode : 'account'
}

export async function saveImageDescriptionMode(userId: string, mode: ImageDescriptionMode): Promise<void> {
  const row = { mode, updatedAt: Date.now() }
  await db
    .insert(imageDescriptionPrefs)
    .values({ userId, ...row })
    .onConflictDoUpdate({ target: imageDescriptionPrefs.userId, set: row })
}
