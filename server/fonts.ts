import { nanoid } from 'nanoid'
import { eq, inArray } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import { env } from './env.ts'
import { storeAsset } from './assets.ts'
import { readFontFile } from './fontFile.ts'
import { isWorkspaceMember } from './workspaces.ts'
import { unlimitedFonts } from './entitlements.ts'
import { FREE_FONT_FAMILIES } from '../shared/billing.ts'
import { MAX_FONT_BYTES, type CustomFont, type FontFormat, type FontScope, type FontStyle } from '../shared/fonts.ts'

/**
 * Font libraries (shared/fonts.ts). Small and read on every frame write, so
 * the whole table is mirrored in memory at boot and kept current by the
 * writes below; the database is written through before the mirror changes.
 */

type FontRow = typeof t.fonts.$inferSelect

const rows = new Map<string, FontRow>()

export class FontInputError extends Error {}

/** A Free library already holds its families; the route answers 402 so the
 *  page can offer Pro. */
export class FontLimitError extends FontInputError {}

/** Refuse a family a Free library has no room for. A face of a family the
 *  library already has is always welcome, so a family stays complete. */
function checkFamilyRoom(scope: FontScope, userId: string, family: string): void {
  if (unlimitedFonts(scope, userId)) return
  const families = new Set(
    [...rows.values()].filter((r) => inScope(r, scope, userId)).map((r) => r.family.toLowerCase()),
  )
  if (families.has(family.toLowerCase()) || families.size < FREE_FONT_FAMILIES) return
  throw new FontLimitError(
    `the Free plan holds ${FREE_FONT_FAMILIES} font families and this library has ${families.size}: upgrade to Pro for unlimited fonts, or remove a family first`,
  )
}

export async function hydrateFonts(): Promise<void> {
  const all = await db.select().from(t.fonts)
  rows.clear()
  for (const row of all) rows.set(row.id, row)
}

function toFont(row: FontRow): CustomFont {
  return {
    id: row.id,
    family: row.family,
    weight: row.weight,
    style: row.style as FontStyle,
    format: row.format as FontFormat,
    url: `${env.BETTER_AUTH_URL}/a/${row.assetId}.${row.ext}`,
    fileName: row.fileName,
    size: row.size,
    createdAt: row.createdAt,
  }
}

function inScope(row: FontRow, scope: FontScope, userId: string): boolean {
  return 'workspaceId' in scope ? row.workspaceId === scope.workspaceId : !row.workspaceId && row.ownerId === userId
}

/** Whether a person may read and change a library. */
export function canUseScope(scope: FontScope, userId: string): boolean {
  return 'personal' in scope || isWorkspaceMember(scope.workspaceId, userId)
}

export function listFonts(scope: FontScope, userId: string): CustomFont[] {
  return [...rows.values()]
    .filter((row) => inScope(row, scope, userId))
    .sort((a, b) => a.family.localeCompare(b.family) || a.weight.localeCompare(b.weight) || a.createdAt - b.createdAt)
    .map(toFont)
}

/** The library a canvas designs with: its workspace's, or its owner's own. */
export function fontsForCanvas(canvas: { workspaceId?: string | null; ownerId?: string | null }): CustomFont[] {
  if (canvas.workspaceId) return listFonts({ workspaceId: canvas.workspaceId }, '')
  return canvas.ownerId ? listFonts({ personal: true }, canvas.ownerId) : []
}

/** Add a font file to a library. A file for a face the library already has
 *  (same family, weight and style) replaces it, so re-uploading a fixed
 *  version needs no delete first. */
export async function addFont(
  scope: FontScope,
  user: { id: string; name: string },
  buf: Buffer,
  fileName: string,
): Promise<CustomFont> {
  if (buf.length === 0) throw new FontInputError('empty file')
  if (buf.length > MAX_FONT_BYTES)
    throw new FontInputError(`file is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB`)
  let info
  try {
    info = readFontFile(buf)
  } catch (e) {
    throw new FontInputError(e instanceof Error ? e.message : 'the font file could not be read')
  }
  /* a quick refusal before anything waits in the queue */
  checkFamilyRoom(scope, user.id, info.family)
  const cleanName = fileName.replace(/[^\w.\- ]+/g, '').slice(0, 120)
  /* find-and-replace runs one at a time per library: two uploads of the same
     face racing would otherwise each miss the other's row and both stay. The
     file is stored inside the queue, after the checks, so a refused upload
     leaves nothing behind. */
  return inLibraryOrder(scope, user.id, async () => {
    /* checked again in the queue: the workspace may have been deleted, or the
       uploader removed from it, while earlier uploads ran */
    if (!canUseScope(scope, user.id)) throw new FontInputError('this workspace no longer exists or you left it')
    /* again in the queue: two new families uploaded at once both passed the first look */
    checkFamilyRoom(scope, user.id, info.family)
    const asset = await storeAsset(buf, info, { ownerId: user.id, uploadedBy: user.name })
    const row: FontRow = {
      id: nanoid(10),
      workspaceId: 'workspaceId' in scope ? scope.workspaceId : null,
      ownerId: user.id,
      family: info.family,
      weight: info.weight,
      style: info.style,
      format: info.format,
      assetId: asset.id,
      ext: asset.ext,
      fileName: cleanName || `font.${asset.ext}`,
      size: buf.length,
      uploadedBy: user.id,
      createdAt: Date.now(),
    }
    const replaced = [...rows.values()].filter(
      (r) =>
        inScope(r, scope, user.id) &&
        r.family.toLowerCase() === row.family.toLowerCase() &&
        r.weight === row.weight &&
        r.style === row.style,
    )
    await db.transaction(async (tx) => {
      await tx.insert(t.fonts).values(row)
      if (replaced.length)
        await tx.delete(t.fonts).where(
          inArray(
            t.fonts.id,
            replaced.map((r) => r.id),
          ),
        )
    })
    rows.set(row.id, row)
    for (const old of replaced) rows.delete(old.id)
    return toFont(row)
  })
}

const libraryChains = new Map<string, Promise<unknown>>()

/** Run library writes one after another, per library, in arrival order. */
function inLibraryOrder<T>(scope: FontScope, userId: string, work: () => Promise<T>): Promise<T> {
  const key = 'workspaceId' in scope ? `ws:${scope.workspaceId}` : `user:${userId}`
  const next = (libraryChains.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => {})
  libraryChains.set(key, settled)
  void settled.then(() => {
    if (libraryChains.get(key) === settled) libraryChains.delete(key)
  })
  return next
}

async function removeRow(id: string): Promise<void> {
  await db.delete(t.fonts).where(eq(t.fonts.id, id))
  rows.delete(id)
}

/** Remove a font from a library. Frames that already load it keep the face
 *  (the asset is immutable); the font just stops being offered. */
export async function deleteFont(id: string, userId: string): Promise<boolean> {
  const row = rows.get(id)
  if (!row) return false
  const scope: FontScope = row.workspaceId ? { workspaceId: row.workspaceId } : { personal: true }
  if (!inScope(row, scope, userId) || !canUseScope(scope, userId)) return false
  await inLibraryOrder(scope, userId, () => removeRow(id))
  return true
}

/** Drop a deleted workspace's library rows (its assets stay, like any asset). */
export async function dropWorkspaceFonts(workspaceId: string): Promise<void> {
  /* in the library's queue, after any upload already past its check; the
     workspace's members are gone by now, so later uploads are refused */
  await inLibraryOrder({ workspaceId }, '', async () => {
    await db.delete(t.fonts).where(eq(t.fonts.workspaceId, workspaceId))
    for (const [id, row] of rows) if (row.workspaceId === workspaceId) rows.delete(id)
  })
}
