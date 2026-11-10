import { nanoid } from 'nanoid'
import type { Canvas } from '../shared/types.ts'
import type { ResourceCopyEntry, ResourceCopyRequest, ResourceCopyResult } from '../shared/resourceCopies.ts'
import type * as t from './db/schema.ts'
import { env } from './env.ts'
import { canAccessCanvas } from './access.ts'
import { companyPolicy } from './companyPolicy.ts'
import { store } from './store.ts'
import { assetMetadata, getAsset, insertAssetCopies, MAX_ASSET_BYTES, publishCopiedAssets } from './assets.ts'
import { MAX_FONT_BYTES } from '../shared/fonts.ts'
import { canvasFontRows, publishCopiedFonts } from './fonts.ts'
import {
  privateCanvas,
  jobResourceReader,
  PrivateResourceError,
  requireCanvasCreation,
  requirePrivateCanvas,
  requireResourceActor,
} from './privateResources.ts'
import { PrivateReferenceError, visitPrivateReferences } from '../shared/privateReferences.ts'
import * as storage from './storage.ts'

export const RESOURCE_COPY_LIMITS = { assets: 64, bytes: 64 * 1024 * 1024, concurrency: 4 } as const
type AssetRow = typeof t.assets.$inferSelect
type FontRow = typeof t.fonts.$inferSelect

export class ResourceCopyConflict extends Error {
  constructor() {
    super('The source frame changed. Copy it again before pasting.')
  }
}

export class ResourceCopyUncertainError extends Error {
  constructor(
    readonly canvasId: string,
    readonly candidateIds: string[],
  ) {
    super('File copy could not be confirmed. Do not repeat it automatically; reconcile the destination first.')
  }
}

function boundAsset(id: string, ext: string, canvasId: string): Readonly<AssetRow> {
  const row = assetMetadata(id)
  if (!row || row.canvasId !== canvasId || row.ext !== ext)
    throw new PrivateReferenceError('copied private file is missing or belongs to another canvas')
  if (
    !Number.isSafeInteger(row.size) ||
    row.size <= 0 ||
    row.size > (row.mime.startsWith('font/') ? MAX_FONT_BYTES : MAX_ASSET_BYTES)
  )
    throw new PrivateReferenceError('copied private file has invalid size metadata')
  return row
}
export interface CanvasResourceCopy {
  sourceCanvasId: string
  actorId: string
  assets: AssetRow[]
  fonts: FontRow[]
}

/** Public gallery HTML does not confer private-file rights. */
export function requireCopySource(sourceId: string, actorId: string, containsPrivate: boolean): Canvas {
  const source = store.getCanvas(sourceId)
  if (!source) throw new PrivateResourceError()
  if (containsPrivate) {
    if (!privateCanvas(sourceId, actorId)) throw new PrivateResourceError()
  } else if (!canAccessCanvas(actorId, source)) {
    if (source.publishedAt === undefined) throw new PrivateResourceError()
    companyPolicy.assertPublicFeature(source.workspaceId)
  }
  return source
}

/** A small bounded worker group settles every started I/O before it reports failure. */
async function eachBounded<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  let failed = false
  let failure: unknown
  const worker = async () => {
    while (!failed) {
      const index = cursor++
      if (index >= items.length) return
      try {
        await work(items[index]!)
      } catch (error) {
        failed = true
        failure = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(RESOURCE_COPY_LIMITS.concurrency, items.length) }, worker))
  if (failed) throw failure
}

/** Token values have already passed normalizeTokenValue (no block delimiters).
 *  The common CSS parser preserves the source except explicit URL replacements. */
function tokenValue(value: string, visit: Parameters<typeof visitPrivateReferences>[2]): string {
  if (/[;{}<>\n\r\\]/.test(value)) throw new PrivateReferenceError('unsupported copied token value')
  return visitPrivateReferences(value, env.BETTER_AUTH_URL, visit, 'value')
}

function canvasCarriers(canvas: Canvas, visit: Parameters<typeof visitPrivateReferences>[2]): void {
  for (const frame of canvas.frames) frame.html = visitPrivateReferences(frame.html, env.BETTER_AUTH_URL, visit)
  for (const reference of canvas.references ?? [])
    reference.html = visitPrivateReferences(reference.html, env.BETTER_AUTH_URL, visit)
  for (const token of canvas.tokens ?? []) {
    token.value = tokenValue(token.value, visit)
    if (token.themes)
      token.themes = Object.fromEntries(
        Object.entries(token.themes).map(([name, value]) => [name, tokenValue(value, visit)]),
      )
  }
  // Guideline markdown, descriptions and names are plain text, not URL carriers.
}

/** Copy bounded objects without publishing metadata or a destination parent. */
async function copyAssetObjects(
  wanted: ReadonlyMap<string, Readonly<AssetRow>>,
  destinationId: string,
  actorId: string,
  recheck: () => void,
): Promise<Map<string, AssetRow>> {
  if (wanted.size > RESOURCE_COPY_LIMITS.assets)
    throw new PrivateReferenceError('copy exceeds the private-file count budget')
  const size = [...wanted.values()].reduce((sum, row) => sum + row.size, 0)
  if (!Number.isSafeInteger(size) || size > RESOURCE_COPY_LIMITS.bytes)
    throw new PrivateReferenceError('copy exceeds the private-file byte budget')
  const now = Date.now()
  const mapping = new Map(
    [...wanted].map(([id, row]) => [
      id,
      {
        ...row,
        id: nanoid(10),
        canvasId: destinationId,
        ownerId: actorId,
        uploadedBy: actorId,
        createdAt: now,
      },
    ]),
  )
  const written: string[] = []
  try {
    await eachBounded([...wanted.values()], async (input) => {
      recheck()
      const file = await getAsset(input.id, { canvasId: input.canvasId, reader: jobResourceReader(actorId) })
      if (!file || file.meta.ext !== input.ext || file.meta.mime !== input.mime || file.buf.length !== input.size)
        throw new PrivateReferenceError('copied private file could not be read completely')
      recheck()
      const output = mapping.get(input.id)!
      const key = `${output.id}.${output.ext}`
      await storage.putObject(key, file.buf, output.mime)
      written.push(key)
    })
    recheck()
  } catch (error) {
    // No metadata transaction has started. Unacknowledged puts may leave
    // private orphans, which never become routable without metadata.
    await eachBounded(written, async (key) => {
      try {
        await storage.deleteObject(key)
      } catch {
        /* retain private orphan */
      }
    })
    throw error
  }
  return mapping
}

/** Prepare private objects, then let saveCanvasCopy commit all metadata in its
 *  existing parent transaction. The destination is never published here. */
export async function prepareCanvasResourceCopy(
  sourceId: string,
  destination: Canvas,
  actorId: string,
): Promise<CanvasResourceCopy> {
  await requireResourceActor(actorId)
  requireCanvasCreation(actorId, destination.workspaceId)
  requireCopySource(sourceId, actorId, false)
  const fontInputs = canvasFontRows(sourceId)
  const wanted = new Map<string, Readonly<AssetRow>>()
  const collect = (id: string, ext: string) => {
    wanted.set(id, boundAsset(id, ext, sourceId))
    if (wanted.size > RESOURCE_COPY_LIMITS.assets)
      throw new PrivateReferenceError('copy exceeds the private-file count budget')
  }
  canvasCarriers(destination, (reference) => {
    collect(reference.id, reference.ext)
  })
  for (const font of fontInputs) collect(font.assetId, font.ext)
  requireCopySource(sourceId, actorId, wanted.size > 0)
  const recheck = () => {
    requireCopySource(sourceId, actorId, wanted.size > 0)
    requireCanvasCreation(actorId, destination.workspaceId)
  }
  const mapping = await copyAssetObjects(wanted, destination.id, actorId, recheck)
  canvasCarriers(destination, (reference) => {
    const output = mapping.get(reference.id)
    if (!output) throw new PrivateReferenceError('private-file copy mapping is incomplete')
    return `${env.BETTER_AUTH_URL}/a/${output.id}.${output.ext}${reference.hash}`
  })
  const now = Date.now()

  return {
    sourceCanvasId: sourceId,
    actorId,
    assets: [...mapping.values()],
    fonts: fontInputs.map((font) => ({
      ...font,
      id: nanoid(10),
      canvasId: destination.id,
      assetId: mapping.get(font.assetId)!.id,
      uploadedBy: actorId,
      createdAt: now,
    })),
  }
}

/** After a confirmed DB commit and canvas publication, publish its projections.
 *  A failed/uncertain DB acknowledgement retains objects for reconciliation;
 *  deleting them could destroy bytes of a transaction that actually committed. */
export function publishCanvasResourceCopy(copy: CanvasResourceCopy): void {
  publishCopiedAssets(copy.assets)
  publishCopiedFonts(copy.fonts)
}

/** Reject old/ambiguous clipboard shapes instead of inferring provenance. */
export function parseResourceCopyRequest(body: unknown): ResourceCopyRequest {
  const fail = (): never => {
    throw new PrivateReferenceError('provide 1–64 source frame snapshots with sourceFrameId, sourceVersion and html')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'entries'))
    return fail()
  const entries = (body as { entries?: unknown }).entries
  if (!Array.isArray(entries) || !entries.length || entries.length > 64) return fail()
  return {
    entries: entries.map((value: unknown): ResourceCopyEntry => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
      const entry = value as Record<string, unknown>
      if (
        Object.keys(entry).some((key) => !['sourceFrameId', 'sourceVersion', 'html', 'css'].includes(key)) ||
        typeof entry.sourceFrameId !== 'string' ||
        !entry.sourceFrameId ||
        entry.sourceFrameId.length > 128 ||
        typeof entry.sourceVersion !== 'number' ||
        !Number.isSafeInteger(entry.sourceVersion) ||
        entry.sourceVersion < 0 ||
        typeof entry.html !== 'string' ||
        (entry.css !== undefined && typeof entry.css !== 'string')
      )
        return fail()
      return {
        sourceFrameId: entry.sourceFrameId,
        sourceVersion: entry.sourceVersion,
        html: entry.html,
        ...(entry.css !== undefined ? { css: entry.css as string } : {}),
      }
    }),
  }
}

/** Existing normal canvas read applies to plain clipboard text. Private file
 *  transfer additionally requires durable access to the stored source parent. */
function sourceFrame(id: string, version: number, actorId: string) {
  const frame = store.getFrame(id)
  const parent = frame && store.getCanvas(frame.canvasId)
  if (!frame || !parent || !canAccessCanvas(actorId, parent)) throw new PrivateResourceError()
  if (frame.updatedAt !== version) throw new ResourceCopyConflict()
  return frame
}

/** Explicit browser copy intent, with one authoritative parser on the server.
 *  The client replaces its clipboard carriers with these rewritten carriers
 *  before its ordinary frame write. This grants no new MCP tool or invitation. */
export async function copyClipboardResources(
  canvasId: string,
  actorId: string,
  request: ResourceCopyRequest,
): Promise<ResourceCopyResult> {
  await requireResourceActor(actorId)
  requirePrivateCanvas(canvasId, actorId)
  const claims = new Map<string, { version: number; canvasId: string; ids: Set<string>; private: boolean }>()
  const wanted = new Map<string, Readonly<AssetRow>>()
  for (const entry of request.entries) {
    const frame = sourceFrame(entry.sourceFrameId, entry.sourceVersion, actorId)
    let claim = claims.get(frame.id)
    if (!claim) {
      const ids = new Set<string>()
      visitPrivateReferences(frame.html, env.BETTER_AUTH_URL, (reference) => {
        ids.add(reference.id)
      })
      claim = { version: entry.sourceVersion, canvasId: frame.canvasId, ids, private: false }
      claims.set(frame.id, claim)
    }
    const collect = (reference: Parameters<Parameters<typeof visitPrivateReferences>[2]>[0]) => {
      if (!claim.ids.has(reference.id))
        throw new PrivateReferenceError('the private file is not referenced by the current source frame')
      const row = boundAsset(reference.id, reference.ext, frame.canvasId)
      if (frame.canvasId === canvasId) return // same parent can reuse its own files
      claim.private = true
      wanted.set(reference.id, row)
      if (wanted.size > RESOURCE_COPY_LIMITS.assets)
        throw new PrivateReferenceError('copy exceeds the private-file count budget')
    }
    visitPrivateReferences(entry.html, env.BETTER_AUTH_URL, collect)
    if (entry.css !== undefined) visitPrivateReferences(entry.css, env.BETTER_AUTH_URL, collect, 'stylesheet')
  }
  const recheck = () => {
    requirePrivateCanvas(canvasId, actorId)
    for (const [id, claim] of claims) {
      const frame = sourceFrame(id, claim.version, actorId)
      if (frame.canvasId !== claim.canvasId) throw new ResourceCopyConflict()
      if (claim.private && !privateCanvas(claim.canvasId, actorId)) throw new PrivateResourceError()
    }
  }
  recheck()
  const mapping = await copyAssetObjects(wanted, canvasId, actorId, recheck)
  const replace = (reference: Parameters<Parameters<typeof visitPrivateReferences>[2]>[0]) => {
    const output = mapping.get(reference.id)
    if (output) return `${env.BETTER_AUTH_URL}/a/${output.id}.${output.ext}${reference.hash}`
    if (assetMetadata(reference.id)?.canvasId !== canvasId)
      throw new PrivateReferenceError('private-file copy mapping is incomplete')
  }
  const entries = request.entries.map((entry) => ({
    html: visitPrivateReferences(entry.html, env.BETTER_AUTH_URL, replace),
    ...(entry.css !== undefined
      ? { css: visitPrivateReferences(entry.css, env.BETTER_AUTH_URL, replace, 'stylesheet') }
      : {}),
  }))
  if (mapping.size) {
    try {
      await insertAssetCopies([...mapping.values()], actorId, recheck)
    } catch (error) {
      if (error instanceof PrivateResourceError || error instanceof ResourceCopyConflict) throw error
      throw new ResourceCopyUncertainError(
        canvasId,
        [...mapping.values()].map((row) => row.id),
      )
    }
    publishCopiedAssets([...mapping.values()])
  } else {
    await requireResourceActor(actorId)
    recheck()
  }
  return {
    canvasId,
    entries,
    assets: [...mapping].map(([from, row]) => ({
      from,
      to: row.id,
      url: `${env.BETTER_AUTH_URL}/a/${row.id}.${row.ext}`,
    })),
  }
}
