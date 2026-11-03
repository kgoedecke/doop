import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import { MAX_AVATAR_BYTES } from '../shared/avatar.ts'
import { sniffMime, storeAsset } from './assets.ts'

/**
 * Profile photos: the bytes are an ordinary immutable `/a/` asset (so a face
 * cached anywhere keeps loading after a change) and the user row's `image`
 * points at the current one. Removing a photo only clears the pointer.
 */

export class AvatarInputError extends Error {}

const AVATAR_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const

/** Store the photo and make it the person's face. Returns its URL. */
export async function setAvatar(userId: string, buf: Buffer): Promise<string> {
  if (buf.length === 0) throw new AvatarInputError('choose an image file')
  if (buf.length > MAX_AVATAR_BYTES) throw new AvatarInputError('the photo is over 2 MB')
  const mime = sniffMime(buf)
  const ext = mime && mime in AVATAR_EXT ? AVATAR_EXT[mime as keyof typeof AVATAR_EXT] : undefined
  if (!mime || !ext) throw new AvatarInputError('png, jpg, webp and gif photos are accepted')
  const asset = await storeAsset(buf, { mime, ext }, { ownerId: userId, uploadedBy: userId })
  const image = `/a/${asset.id}.${asset.ext}`
  await db.update(authSchema.user).set({ image, updatedAt: new Date() }).where(eq(authSchema.user.id, userId))
  return image
}

/** Back to initials. */
export async function clearAvatar(userId: string): Promise<void> {
  await db.update(authSchema.user).set({ image: null, updatedAt: new Date() }).where(eq(authSchema.user.id, userId))
}
