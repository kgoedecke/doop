import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from './env.ts'
import type { SecretKey } from './env.ts'

/**
 * Encryption at rest for the credentials doop keeps on behalf of its users:
 * model-account keys and tokens, integration tokens, GitHub PATs, Linear and
 * Slack installations, webhook signing secrets. A copy of the database alone
 * (a backup, a leaked connection string) then yields ciphertext; reading a
 * value back also takes a key from SECRETS_ENCRYPTION_KEYS, which lives only
 * in the server's environment.
 *
 * Stored form: `enc:v1:<key id>:<base64url(iv ‖ ciphertext ‖ tag)>`, AES-256-GCM
 * with a fresh 12-byte IV per write. The key id names which configured key
 * sealed the value, so keys rotate: put the new key first, keep the old one
 * listed, and the boot backfill (server/secretBackfill.ts) re-seals every row
 * under the new key, after which the old one can go.
 *
 * Values written before encryption existed, or while no key is configured,
 * are plain strings and read back as they are; the backfill seals them once a
 * key is set. A sealed value whose key is not configured is an error rather
 * than a pass-through: handing ciphertext to a provider as a token would fail
 * somewhere far less obvious.
 */

const PREFIX = 'enc:v1:'
const IV_BYTES = 12
const TAG_BYTES = 16

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX)
}

/** The id of the key a sealed value was written with; null for plaintext. */
export function sealedKeyId(value: string): string | null {
  if (!isSealed(value)) return null
  const end = value.indexOf(':', PREFIX.length)
  return end === -1 ? null : value.slice(PREFIX.length, end)
}

function activeKey(): SecretKey | undefined {
  return env.SECRETS_ENCRYPTION_KEYS[0]
}

/** Seals a value under the active key; with no key configured the value is
 *  stored as-is (the boot warning says so). Already-sealed input is kept. */
export function seal(plaintext: string): string {
  const key = activeKey()
  if (!key || isSealed(plaintext)) return plaintext
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key.key, iv)
  const body = Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `${PREFIX}${key.id}:${body.toString('base64url')}`
}

export function open(stored: string): string {
  if (!isSealed(stored)) return stored
  const id = sealedKeyId(stored)
  const key = env.SECRETS_ENCRYPTION_KEYS.find((k) => k.id === id)
  if (!key) throw new Error(`stored secret was sealed with key "${id}", which SECRETS_ENCRYPTION_KEYS does not list`)
  const body = Buffer.from(stored.slice(PREFIX.length + (id?.length ?? 0) + 1), 'base64url')
  if (body.length < IV_BYTES + TAG_BYTES) throw new Error('stored secret is truncated')
  const decipher = createDecipheriv('aes-256-gcm', key.key, body.subarray(0, IV_BYTES))
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
  return Buffer.concat([decipher.update(body.subarray(IV_BYTES, body.length - TAG_BYTES)), decipher.final()]).toString(
    'utf8',
  )
}

/** True when a stored value is not yet sealed under the active key: plaintext
 *  once a key exists, or sealed under a key that has since been rotated out. */
export function needsReseal(stored: string): boolean {
  const key = activeKey()
  return !!key && sealedKeyId(stored) !== key.id
}

export function encryptionConfigured(): boolean {
  return !!activeKey()
}
