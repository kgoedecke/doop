import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { imagePrefs } from './db/schema.ts'
import { IMAGE_MODELS } from '../shared/modelMenu.ts'

/** The image model this user picked in Settings, if it is still on the
 *  registry — a retired id reads as "no preference" rather than an error. */
export async function getImagePref(userId: string): Promise<string | undefined> {
  const [row] = await db.select().from(imagePrefs).where(eq(imagePrefs.userId, userId))
  if (!row) return undefined
  return IMAGE_MODELS.some((option) => option.id === row.model) ? row.model : undefined
}

export async function setImagePref(userId: string, model: string): Promise<void> {
  if (!IMAGE_MODELS.some((option) => option.id === model)) throw new Error('unknown image model')
  const row = { userId, model, updatedAt: Date.now() }
  await db.insert(imagePrefs).values(row).onConflictDoUpdate({ target: imagePrefs.userId, set: row })
}
