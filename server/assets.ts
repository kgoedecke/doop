import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as storage from './storage.ts'

/**
 * Uploaded image assets: bytes in object storage (server/storage.ts), one
 * metadata row per asset in the assets table (including the canvas it was
 * uploaded for). Frame HTML is the ground truth for which assets are still
 * in use, tracked as a projection in asset_refs: every durable frame write
 * re-extracts that frame's /a/<id> references (db/persist.ts), and boot
 * rebuilds the whole table from hydrated frames — so a failed fire-and-
 * forget write self-heals. Nothing is ever deleted; if cleanup is wanted
 * some day, asset_refs is the ledger to build it on.
 */

export const MAX_ASSET_BYTES = 5 * 1024 * 1024

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
} as const

type AssetMime = keyof typeof MIME_EXT

/* trust the bytes, not the sender: content sniffing decides the type */
function sniffMime(buf: Buffer): AssetMime | undefined {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp'
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1500)).trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return undefined
}

/* One-time upload tickets: a local file can't ride an MCP tool call (every
   byte of a tool argument streams through the model — slow, and corruptible
   past a few KB), so upload_asset hands out a capability URL instead and the
   agent curls the bytes to PUT /u/<token>. In-memory on purpose: single
   process, short TTL, single use. */
const TICKET_TTL_MS = 15 * 60 * 1000

interface UploadTicket {
  canvasId: string
  ownerId?: string
  uploadedBy: string
  expiresAt: number
  inFlight: boolean
}
const tickets = new Map<string, UploadTicket>()

export function createUploadTicket(meta: { canvasId: string; ownerId?: string; uploadedBy: string }): {
  token: string
  expiresAt: number
} {
  for (const [k, v] of tickets) if (v.expiresAt < Date.now()) tickets.delete(k)
  const token = nanoid(24)
  const expiresAt = Date.now() + TICKET_TTL_MS
  tickets.set(token, { ...meta, expiresAt, inFlight: false })
  return { token, expiresAt }
}

/** Claim a ticket for an upload attempt. Returns null when the token is
 *  unknown, expired, already consumed, or mid-upload elsewhere. */
export function beginTicketUpload(token: string): Omit<UploadTicket, 'inFlight'> | null {
  const t = tickets.get(token)
  if (!t || t.expiresAt < Date.now() || t.inFlight) return null
  t.inFlight = true
  return t
}

/** Success consumes the ticket; failure releases it for a retry until TTL. */
export function endTicketUpload(token: string, success: boolean): void {
  if (success) tickets.delete(token)
  else {
    const t = tickets.get(token)
    if (t) t.inFlight = false
  }
}

/** Asset ids referenced by a piece of frame HTML (/a/<id>.<ext> URLs). */
export function extractAssetIds(html: string): Set<string> {
  const ids = new Set<string>()
  for (const [, id] of html.matchAll(/\/a\/([A-Za-z0-9_-]+)\.[a-z0-9]+/g)) if (id) ids.add(id)
  return ids
}

export interface AssetMeta {
  id: string
  mime: string
  ext: string
  size: number
}

export async function createAsset(
  buf: Buffer,
  meta: { canvasId?: string; ownerId?: string; uploadedBy: string },
): Promise<AssetMeta> {
  if (buf.length === 0) throw new Error('empty file')
  if (buf.length > MAX_ASSET_BYTES)
    throw new Error(`file is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB`)
  const mime = sniffMime(buf)
  if (!mime) throw new Error('unsupported file type — png, jpg, webp, gif and svg are accepted')
  const ext = MIME_EXT[mime]
  const id = nanoid(10)
  /* object first, row second: an orphaned object is swept later, but a row
     without bytes would serve 404s forever */
  await storage.putObject(`${id}.${ext}`, buf, mime)
  await db.insert(t.assets).values({
    id,
    canvasId: meta.canvasId ?? null,
    ownerId: meta.ownerId ?? null,
    mime,
    ext,
    size: buf.length,
    uploadedBy: meta.uploadedBy,
    createdAt: Date.now(),
  })
  return { id, mime, ext, size: buf.length }
}

export async function getAsset(id: string): Promise<{ meta: AssetMeta; buf: Buffer } | null> {
  const [row] = await db.select().from(t.assets).where(eq(t.assets.id, id))
  if (!row) return null
  const buf = await storage.getObject(`${row.id}.${row.ext}`)
  if (!buf) return null
  return { meta: { id: row.id, mime: row.mime, ext: row.ext, size: row.size }, buf }
}

/** Fetch a remote image through the SSRF guard, validating every redirect
 *  hop, with a hard size cap enforced while streaming. */
export async function fetchRemote(rawUrl: string): Promise<Buffer> {
  const { fetchPinnedPublicUrl, parsePublicHttpUrl } = await import('./publicUrl.ts')
  let url = parsePublicHttpUrl(rawUrl)
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetchPinnedPublicUrl(url, {
      redirect: 'manual',
      headers: { accept: 'image/*,*/*;q=0.8', 'user-agent': 'DoopAssets/1.0' },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error('redirect without a location')
      url = parsePublicHttpUrl(new URL(loc, url).href)
      continue
    }
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`)
    if (Number(res.headers.get('content-length') || 0) > MAX_ASSET_BYTES) throw new Error('file exceeds the 5 MB limit')
    if (!res.body) throw new Error('empty response')
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel()
        throw new Error('file exceeds the 5 MB limit')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  throw new Error('too many redirects')
}

/** Rebuild the asset_refs projection from a full set of frames — called at
 *  boot with the frames hydrate just loaded (no extra I/O), which both
 *  backfills pre-existing content and heals any drift from failed
 *  write-through. Incremental upkeep afterwards lives in db/persist.ts. */
export async function reconcileAssetRefs(frames: { id: string; html: string }[]): Promise<number> {
  const rows: { assetId: string; frameId: string }[] = []
  for (const f of frames) for (const assetId of extractAssetIds(f.html)) rows.push({ assetId, frameId: f.id })
  await db.delete(t.assetRefs)
  for (let i = 0; i < rows.length; i += 1000) {
    await db
      .insert(t.assetRefs)
      .values(rows.slice(i, i + 1000))
      .onConflictDoNothing()
  }
  return rows.length
}
