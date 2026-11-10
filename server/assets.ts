import { nanoid } from 'nanoid'
import { asc, eq, gt } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as storage from './storage.ts'
import {
  requirePrivateCanvas,
  requireResourceActor,
  assertCanvasRead,
  requireReadActor,
  resourceReadError,
  PrivateResourceError,
  type CanvasReadScope,
  type ResourceReader,
} from './privateResources.ts'
import { readFontFile } from './fontFile.ts'
import { MAX_FONT_BYTES } from '../shared/fonts.ts'
import { MAX_AVATAR_BYTES } from '../shared/avatar.ts'
import { env } from './env.ts'
import { PrivateReferenceError, visitPrivateReferences } from '../shared/privateReferences.ts'
import { IMAGE_MIME_EXT, sniffMime } from '../shared/mediaTypes.ts'

/**
 * Uploaded assets (images, and the files of font libraries): bytes in object storage (server/storage.ts), one
 * metadata row per asset in the assets table (including the canvas it was
 * uploaded for). Frame HTML is the ground truth for which assets are still
 * in use, tracked as a projection in asset_refs: every durable frame write
 * re-extracts that frame's /a/<id> references (db/persist.ts), and boot
 * rebuilds the whole table from hydrated frames — so a failed fire-and-
 * forget write self-heals. Nothing is ever deleted; if cleanup is wanted
 * some day, asset_refs is the ledger to build it on.
 */

export const MAX_ASSET_BYTES = 5 * 1024 * 1024

/* One-time upload tickets: a local file can't ride an MCP tool call (every
   byte of a tool argument streams through the model — slow, and corruptible
   past a few KB), so upload_asset hands out a capability URL instead and the
   agent curls the bytes to PUT /u/<token>. In-memory on purpose: single
   process, short TTL, single use. */
const TICKET_TTL_MS = 15 * 60 * 1000

interface UploadTicket {
  canvasId: string
  actorId: string
  uploadedBy: string
  expiresAt: number
  inFlight: boolean
}
const tickets = new Map<string, UploadTicket>()

export function createUploadTicket(meta: AssetParent): {
  token: string
  expiresAt: number
} {
  requirePrivateCanvas(meta.canvasId, meta.actorId)
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
  visitPrivateReferences(html, env.BETTER_AUTH_URL, (reference) => {
    ids.add(reference.id)
  })
  return ids
}

/** Existing authenticated frame owners supply the stored parent. This lookup
 *  checks binding only; metadata and URLs cannot grant another canvas's rights. */
export function validateAssetReferences(
  source: string,
  canvasId: string,
  context: 'html' | 'stylesheet' | 'value' = 'html',
): void {
  visitPrivateReferences(
    source,
    env.BETTER_AUTH_URL,
    (reference) => {
      const row = metadata.get(reference.id)
      if (!row || row.canvasId !== canvasId || row.ext !== reference.ext)
        throw new PrivateReferenceError(
          'private file is missing or belongs to a different canvas; use an authorized copy',
        )
    },
    context,
  )
}

export interface AssetMeta {
  id: string
  mime: string
  ext: string
  size: number
}

export interface AssetParent {
  canvasId: string
  actorId: string
  uploadedBy: string
}

type AssetRow = typeof t.assets.$inferSelect
const metadata = new Map<string, AssetRow>()

/** Only durable metadata is published; this is not an authorization cache. */
export async function hydrateAssetMetadata(): Promise<void> {
  const all = await db.select().from(t.assets)
  metadata.clear()
  for (const row of all) metadata.set(row.id, row)
}

export function assetMetadata(id: string): Readonly<AssetRow> | undefined {
  return metadata.get(id)
}

/** Called only after the existing copy transaction confirms its commit. */
export function publishCopiedAssets(committed: readonly AssetRow[]): void {
  for (const row of committed) metadata.set(row.id, row)
}

/** Existing asset persistence owner; caller validates frozen provenance and
 *  current source/destination rights at this transaction's entry. */
export async function insertAssetCopies(rows: readonly AssetRow[], actorId: string, check: () => void): Promise<void> {
  await db.transaction(async (tx) => {
    await requireResourceActor(actorId, tx)
    check()
    if (rows.length) await tx.insert(t.assets).values([...rows])
  })
}

export async function createAsset(buf: Buffer, meta: AssetParent): Promise<AssetMeta> {
  if (buf.length === 0) throw new Error('empty file')
  if (buf.length > MAX_ASSET_BYTES)
    throw new Error(`file is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB`)
  const mime = sniffMime(buf)
  if (!mime) throw new Error('unsupported file type — png, jpg, webp, gif and svg are accepted')
  return storeAsset(buf, { mime, ext: IMAGE_MIME_EXT[mime], kind: 'image' }, meta)
}

/** Store bytes whose type the caller has already established (images via
 *  createAsset, fonts via server/fonts.ts) under a fresh /a/ id. */
export async function storeAsset(
  buf: Buffer,
  type: { mime: string; ext: string; kind: 'image' | 'font' | 'avatar' },
  meta: AssetParent,
): Promise<AssetMeta> {
  const { mime, ext } = type
  await requireResourceActor(meta.actorId)
  requirePrivateCanvas(meta.canvasId, meta.actorId)
  const maximum = type.kind === 'font' ? MAX_FONT_BYTES : type.kind === 'avatar' ? MAX_AVATAR_BYTES : MAX_ASSET_BYTES
  if (!buf.length || buf.length > maximum) throw new Error('file exceeds its supported size bounds')
  if (type.kind === 'font') {
    const actual = readFontFile(buf)
    if (actual.mime !== mime || actual.ext !== ext) throw new Error('font type does not match its bytes')
  } else {
    const actual = sniffMime(buf)
    if (!actual || actual !== mime || IMAGE_MIME_EXT[actual] !== ext || (type.kind === 'avatar' && ext === 'svg'))
      throw new Error('image type does not match its bytes')
  }
  const id = nanoid(10)
  /* object first, row second: an orphaned object is swept later, but a row
     without bytes would serve 404s forever */
  await storage.putObject(`${id}.${ext}`, buf, mime)
  const row: AssetRow = {
    id,
    canvasId: meta.canvasId,
    ownerId: meta.actorId,
    mime,
    ext,
    size: buf.length,
    uploadedBy: meta.uploadedBy,
    createdAt: Date.now(),
  }
  await db.transaction(async (tx) => {
    await requireResourceActor(meta.actorId, tx)
    requirePrivateCanvas(meta.canvasId, meta.actorId)
    await tx.insert(t.assets).values(row)
  })
  metadata.set(id, row)
  return { id, mime, ext, size: buf.length }
}

export async function getAsset(
  id: string,
  scope: CanvasReadScope,
  extension?: string,
): Promise<{ meta: AssetMeta; buf: Buffer } | null> {
  try {
    await assertCanvasRead(scope)
    const [row] = await db.select().from(t.assets).where(eq(t.assets.id, id))
    if (!row || row.canvasId !== scope.canvasId || (extension !== undefined && row.ext !== extension)) return null
    const maximum = row.mime.startsWith('font/') ? MAX_FONT_BYTES : MAX_ASSET_BYTES
    if (row.size <= 0 || row.size > maximum) throw new Error('invalid private file size')
    const buf = await storage.getObject(`${row.id}.${row.ext}`, maximum)
    await assertCanvasRead(scope)
    const [current] = await db.select().from(t.assets).where(eq(t.assets.id, id))
    if (
      !current ||
      current.canvasId !== scope.canvasId ||
      current.ext !== row.ext ||
      current.size !== row.size ||
      current.mime !== row.mime
    )
      throw new PrivateResourceError()
    await assertCanvasRead(scope)
    if (!buf) return null
    if (buf.length !== row.size) throw new Error('private file size does not match metadata')
    return { meta: { id: row.id, mime: row.mime, ext: row.ext, size: row.size }, buf }
  } catch (error) {
    throw resourceReadError(error)
  }
}

/** Only the direct file route derives a parent; every embedded/copy read supplies its expected one. */
export async function getAssetById(id: string, extension: string, reader: ResourceReader) {
  await requireReadActor(reader)
  const [row] = await db.select().from(t.assets).where(eq(t.assets.id, id))
  if (!row || row.ext !== extension) return null
  return getAsset(id, { canvasId: row.canvasId, reader }, extension)
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

const RECONCILE_PAGE = 500

/** Rebuild private frame references without hydrating every canvas's HTML. */
export async function reconcileAssetRefs(): Promise<number> {
  const rows: { assetId: string; frameId: string; canvasId: string }[] = []
  let after = ''
  for (;;) {
    const page = await db
      .select({ id: t.frames.id, canvasId: t.frames.canvasId, html: t.frames.html })
      .from(t.frames)
      .where(gt(t.frames.id, after))
      .orderBy(asc(t.frames.id))
      .limit(RECONCILE_PAGE)
    for (const frame of page) {
      validateAssetReferences(frame.html, frame.canvasId)
      for (const assetId of extractAssetIds(frame.html))
        rows.push({ assetId, frameId: frame.id, canvasId: frame.canvasId })
    }
    const last = page.at(-1)
    if (!last || page.length < RECONCILE_PAGE) break
    after = last.id
  }
  await db.delete(t.assetRefs)
  for (let i = 0; i < rows.length; i += 1000) {
    await db
      .insert(t.assetRefs)
      .values(rows.slice(i, i + 1000))
      .onConflictDoNothing()
  }
  return rows.length
}
