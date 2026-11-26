import { eq, like } from 'drizzle-orm'
import { db } from './db/index.ts'
import { imagePrefs } from './db/schema.ts'
import { IMAGE_MODELS } from '../shared/modelMenu.ts'
import { customImageModelRef, parseCustomImageModelRef, type CustomProviderKind } from '../shared/customProvider.ts'

/* a registry id, or a custom provider's image model (`custom:<id>/<model>`),
   whose provider imageGen checks against the person's accounts on every run */
function isImageModelId(model: string): boolean {
  return IMAGE_MODELS.some((option) => option.id === model) || parseCustomImageModelRef(model) !== null
}

/** The image model this user picked in Settings, if it is still on the
 *  registry or names a custom provider's image model — a retired registry id
 *  reads as "no preference" rather than an error. */
export async function getImagePref(userId: string): Promise<string | undefined> {
  const [row] = await db.select().from(imagePrefs).where(eq(imagePrefs.userId, userId))
  if (!row) return undefined
  return isImageModelId(row.model) ? row.model : undefined
}

export async function setImagePref(userId: string, model: string): Promise<void> {
  if (!isImageModelId(model)) throw new Error('unknown image model')
  const row = { userId, model, updatedAt: Date.now() }
  await db.insert(imagePrefs).values(row).onConflictDoUpdate({ target: imagePrefs.userId, set: row })
}

/** Every pick on one custom provider's image models, for deleting them with
 *  the provider (a kind is `custom:` and [a-z0-9], so it holds no LIKE
 *  wildcard). */
export function picksOnProvider(kind: CustomProviderKind) {
  return like(imagePrefs.model, `${customImageModelRef(kind, '')}%`)
}
