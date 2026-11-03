/** Profile photos. A person's `image` (better-auth's user column) is shown
 *  only when it is one of our own uploads: an `/a/<id>.<ext>` asset written
 *  by `POST /api/me/avatar`. Anything else — a social provider's picture URL,
 *  a URL set through the raw update-user call — stays initials, so no
 *  account can make every viewer of a canvas fetch an address it chose. */

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** The file types the photo picker offers and the upload accepts. */
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

const OWN_AVATAR = /^\/a\/[A-Za-z0-9_-]+\.(?:png|jpg|webp|gif)$/

/** The URL a face may load, or undefined for initials. */
export function avatarUrl(image: string | null | undefined): string | undefined {
  return image && OWN_AVATAR.test(image) ? image : undefined
}
