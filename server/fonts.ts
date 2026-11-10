import { nanoid } from 'nanoid'
import { eq, inArray } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import { env } from './env.ts'
import { storeAsset } from './assets.ts'
import { readFontFile } from './fontFile.ts'
import { privateCanvas, requireResourceActor } from './privateResources.ts'
import { store } from './store.ts'
import { MAX_FONT_BYTES, type CustomFont, type FontFormat, type FontScope, type FontStyle } from '../shared/fonts.ts'

/**
 * Font libraries (shared/fonts.ts). Small and read on every frame write, so
 * the whole table is mirrored in memory at boot and kept current by the
 * writes below; the database is written through before the mirror changes.
 */

type FontRow = typeof t.fonts.$inferSelect

const rows = new Map<string, FontRow>()

export class FontInputError extends Error {}

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

function inScope(row: FontRow, scope: FontScope): boolean {
  return row.canvasId === scope.canvasId
}

/** Libraries have the same current durable parent policy as their bytes. */
export function canUseScope(scope: FontScope, userId: string): boolean {
  return !!privateCanvas(scope.canvasId, userId, 'edit')
}

function fontsInCanvas(canvasId: string): CustomFont[] {
  return [...rows.values()]
    .filter((row) => row.canvasId === canvasId)
    .sort((a, b) => a.family.localeCompare(b.family) || a.weight.localeCompare(b.weight) || a.createdAt - b.createdAt)
    .map(toFont)
}

export function listFonts(scope: FontScope, userId: string): CustomFont[] {
  return privateCanvas(scope.canvasId, userId) ? fontsInCanvas(scope.canvasId) : []
}

/** Used by authorized frame writers; another canvas's faces never propagate. */
export function fontsForCanvas(canvas: { id: string }): CustomFont[] {
  return store.getCanvas(canvas.id) ? fontsInCanvas(canvas.id) : []
}

/** Internal copy input; the copy owner separately checks current source rights. */
export function canvasFontRows(canvasId: string): Readonly<FontRow>[] {
  return [...rows.values()].filter((row) => row.canvasId === canvasId)
}

/** Publish only a confirmed committed copy, alongside its new canvas/assets. */
export function publishCopiedFonts(committed: readonly FontRow[]): void {
  for (const row of committed) rows.set(row.id, row)
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
  if (!canUseScope(scope, user.id)) throw new FontInputError('canvas is not available for font uploads')
  if (buf.length === 0) throw new FontInputError('empty file')
  if (buf.length > MAX_FONT_BYTES)
    throw new FontInputError(`file is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB`)
  let info
  try {
    info = readFontFile(buf)
  } catch (e) {
    throw new FontInputError(e instanceof Error ? e.message : 'the font file could not be read')
  }
  const asset = await storeAsset(
    buf,
    { ...info, kind: 'font' },
    { canvasId: scope.canvasId, actorId: user.id, uploadedBy: user.name },
  )
  const row: FontRow = {
    id: nanoid(10),
    canvasId: scope.canvasId,
    family: info.family,
    weight: info.weight,
    style: info.style,
    format: info.format,
    assetId: asset.id,
    ext: asset.ext,
    fileName: fileName.replace(/[^\w.\- ]+/g, '').slice(0, 120) || `font.${asset.ext}`,
    size: buf.length,
    uploadedBy: user.id,
    createdAt: Date.now(),
  }
  /* find-and-replace runs one at a time per library: two uploads of the same
     face racing would otherwise each miss the other's row and both stay */
  return inLibraryOrder(scope, async () => {
    /* checked again in the queue: the workspace may have been deleted, or the
       uploader lost access, while the file was being stored */
    if (!canUseScope(scope, user.id)) throw new FontInputError('canvas is no longer available for font uploads')
    const replaced = [...rows.values()].filter(
      (r) =>
        inScope(r, scope) &&
        r.family.toLowerCase() === row.family.toLowerCase() &&
        r.weight === row.weight &&
        r.style === row.style,
    )
    await db.transaction(async (tx) => {
      await requireResourceActor(user.id, tx)
      if (!canUseScope(scope, user.id)) throw new FontInputError('canvas is no longer available for font uploads')
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
function inLibraryOrder<T>(scope: FontScope, work: () => Promise<T>): Promise<T> {
  const key = scope.canvasId
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
  const scope: FontScope = { canvasId: row.canvasId }
  if (!canUseScope(scope, userId)) return false
  await inLibraryOrder(scope, async () => {
    if (!canUseScope(scope, userId)) throw new FontInputError('canvas is no longer available')
    await removeRow(id)
  })
  return true
}
