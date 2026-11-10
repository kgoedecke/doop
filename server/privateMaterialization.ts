import { createHash } from 'node:crypto'
import * as css from 'css-tree'
import { assetMetadata, getAsset } from './assets.ts'
import { env } from './env.ts'
import {
  assertRenderRead,
  PrivateResourceError,
  resourceReadError,
  type PrivateRenderScope,
} from './privateResources.ts'
import {
  PRIVATE_REFERENCE_LIMITS,
  PrivateReferenceError,
  privateAssetUrl,
  visitPrivateReferences,
  type PrivateReference,
  type PrivateUrlKind,
} from '../shared/privateReferences.ts'
import { inlineMedia } from '../shared/inlineMedia.ts'
import {
  PRIVATE_MEDIA_LIMITS,
  PrivateMediaBudget,
  PrivateMaterializationError,
  type PrivateMaterialization,
  type PrivateReplacement,
  type PrivateMediaAllowance,
  type PrivateResourceCost,
} from '../shared/privateMedia.ts'
import type { MediaInput } from './privateMediaFiles.ts'
import { validateMediaInputs } from './privateMediaValidation.ts'
import { runMaterializationJob } from './materializationJob.ts'

type Syntax = 'html' | 'stylesheet' | 'value'
type StoredInput = { reference: PrivateReference; expectedBytes: number; media?: MediaInput }

/** Only this owner turns canonical private references into bytes for a render.
 * No asset HTTP fetch, credential serialization, public listener or ID-derived scope. */
export async function materializePrivateResources(
  source: string,
  scope: PrivateRenderScope,
  {
    syntax = 'html',
    signal,
    limits,
    publicReference,
    budget = new PrivateMediaBudget(0, limits),
  }: {
    syntax?: Syntax
    signal?: AbortSignal
    budget?: PrivateMediaBudget
    limits?: PrivateMediaAllowance
    publicReference?: (url: string) => void
  } = {},
): Promise<PrivateMaterialization> {
  try {
    return await runMaterializationJob(async (job) => {
      await job.read(() => assertRenderRead(scope))
      if (source === '') {
        // The normal empty-source request revalidates this same live scope.
        // No source/parser/media allocation is needed, even with no budget left.
        await job.read(() => assertRenderRead(scope))
        return {
          html: '',
          replacements: [],
          privateMedia: false,
          costs: { resources: [], references: 0, parserWork: 0, expandedBytes: 0 },
        }
      }
      const stored = new Map<string, StoredInput>()
      const inline = new Map<string, MediaInput>()
      const references: PrivateReference[] = []
      let declaredBytes = 0
      let sourceReferences = 0
      let parserWork = 0
      const countReference = () => {
        sourceReferences++
        budget.reference()
      }
      const work = (count: number) => {
        parserWork += count
        budget.chargeWork(count)
      }
      const privateKey = (ref: PrivateReference) => `private:${scope.canvasId}:${ref.id}.${ref.ext}`
      const sourceUrl = (raw: string, base: string, kind: PrivateUrlKind = 'other', depth = 0) => {
        if (!raw.trim() || raw.trim().startsWith('#')) return
        const url = new URL(raw, base)
        if (url.protocol === 'data:') {
          dataReference(url.href, depth, kind)
          return
        }
        if (privateAssetUrl(raw, env.BETTER_AUTH_URL, base)) return
        if (!['http:', 'https:', 'blob:'].includes(url.protocol)) return
        countReference()
        if (url.protocol !== 'blob:') {
          url.hash = ''
          publicReference?.(url.href)
        }
      }
      const dataReference = (raw: string, depth: number, kind: PrivateUrlKind) => {
        job.check()
        countReference()
        const media = inlineMedia(raw, kind === 'other' ? 'source' : kind)
        if (!media) return
        if (depth >= PRIVATE_REFERENCE_LIMITS.depth) throw new PrivateMaterializationError('limit')
        const key = `${media.mime}:${createHash('sha256').update(media.bytes).digest('hex')}`
        if (inline.has(key)) return
        declaredBytes += media.bytes.byteLength
        if (declaredBytes > PRIVATE_MEDIA_LIMITS.encodedBytes) throw new PrivateMaterializationError('limit')
        budget.reserveEncoded(`inline:${key}`, media.bytes.byteLength)
        inline.set(key, media)
        if (media.syntax) {
          const nested = new TextDecoder('utf-8', { fatal: true }).decode(media.bytes)
          visitPrivateReferences(
            nested,
            env.BETTER_AUTH_URL,
            () => {
              // Encoded HTML/CSS is intentionally kept canonical. A hidden private
              // reference cannot be repaired by returning an unscoped hotlink.
              throw new PrivateMaterializationError('unsupported')
            },
            media.syntax,
            {
              work,
              url: (value, base, kind) => sourceUrl(value, base, kind, depth + 1),
            },
          )
        }
      }
      visitPrivateReferences(
        source,
        env.BETTER_AUTH_URL,
        (reference) => {
          job.check()
          countReference()
          // Preflight every row before the first storage read, even if the actor
          // owns both canvases. The expected parent comes only from the scope.
          const row = assetMetadata(reference.id)
          if (!row || row.canvasId !== scope.canvasId || row.ext !== reference.ext) throw new PrivateResourceError()
          references.push(reference)
          const key = `${reference.id}.${reference.ext}`
          if (!stored.has(key)) {
            declaredBytes += row.size
            if (!Number.isSafeInteger(declaredBytes) || declaredBytes > PRIVATE_MEDIA_LIMITS.encodedBytes)
              throw new PrivateMaterializationError('limit')
            budget.reserveEncoded(privateKey(reference), row.size)
            stored.set(key, { reference, expectedBytes: row.size })
          }
        },
        syntax,
        {
          work,
          url: sourceUrl,
        },
      )

      const wanted = [...stored.values()]
      let next = 0
      let failed = false
      const loaders = Array.from(
        { length: Math.min(PRIVATE_MEDIA_LIMITS.storageConcurrency, wanted.length) },
        async () => {
          try {
            while (next < wanted.length && !failed) {
              job.check()
              const entry = wanted[next++]!
              const asset = await job.read(() => getAsset(entry.reference.id, scope, entry.reference.ext))
              if (failed) return
              if (!asset) throw new PrivateResourceError()
              if (asset.buf.length !== entry.expectedBytes || asset.meta.size !== entry.expectedBytes)
                throw new PrivateMaterializationError('invalid')
              entry.media = { bytes: asset.buf, mime: asset.meta.mime }
            }
          } catch (error) {
            failed = true
            throw error
          }
        },
      )
      const loaded = await Promise.allSettled(loaders)
      const failure = loaded.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      job.check()
      const inputs = [
        ...wanted.map((entry) => {
          if (!entry.media) throw new PrivateResourceError()
          return { key: privateKey(entry.reference), media: entry.media }
        }),
        ...[...inline.entries()]
          .filter(([, value]) => !('syntax' in value))
          .map(([key, media]) => ({ key: `inline:${key}`, media })),
      ]
      // Reserve expanded strings before base64 generation, including repeated and
      // deeply escaped srcdoc insertions. Intrinsic decode remains a separate unit.
      const lengths = new Map(
        wanted.map((entry) => {
          const file = entry.media!
          return [
            `${entry.reference.id}.${entry.reference.ext}`,
            Buffer.byteLength(`data:${file.mime};doop-resource=${entry.reference.id};base64,`) +
              4 * Math.ceil(file.bytes.byteLength / 3),
          ] as const
        }),
      )
      let estimated = Buffer.byteLength(source)
      for (const ref of references) {
        estimated +=
          lengths.get(`${ref.id}.${ref.ext}`)! +
          Buffer.byteLength(ref.hash) * (4 * PRIVATE_REFERENCE_LIMITS.depth + 6) +
          512 * PRIVATE_REFERENCE_LIMITS.depth
        budget.assertExpansion(estimated)
      }
      budget.assertExpansion(estimated)
      let nextCost = 0
      const results = inputs.length
        ? await validateMediaInputs(
            job,
            inputs.map((entry) => entry.media),
            (cost) => {
              const entry = inputs[nextCost++]!
              budget.reserveDecoded(entry.key, cost.decodedBytes)
              work(cost.parserWork ?? 0)
            },
            PRIVATE_MEDIA_LIMITS.parserWork - budget.remaining.parserWork,
          )
        : []
      const resources: PrivateResourceCost[] = inputs.map((entry, index) => ({
        key: entry.key,
        mime: entry.media.mime,
        encodedBytes: entry.media.bytes.byteLength,
        decodedBytes: results[index]!.decodedBytes,
      }))
      for (const [key, media] of inline)
        if ('syntax' in media)
          resources.push({
            key: `inline:${key}`,
            mime: media.mime,
            encodedBytes: media.bytes.byteLength,
            decodedBytes: 0,
          })
      const dataUrls = new Map<string, string>()
      for (const entry of wanted) {
        job.check()
        const { id, ext } = entry.reference
        const file = entry.media!
        dataUrls.set(
          `${id}.${ext}`,
          `data:${file.mime};doop-resource=${id};base64,${Buffer.from(file.bytes).toString('base64')}`,
        )
      }
      const replacements = new Map<string, PrivateReplacement>()
      const html = visitPrivateReferences(
        source,
        env.BETTER_AUTH_URL,
        (ref) => {
          const data = dataUrls.get(`${ref.id}.${ref.ext}`)
          if (!data) throw new PrivateResourceError()
          const value = data + ref.hash
          const cssInline = css.string.encode(value).slice(1, -1)
          const cssCanonical = css.string.encode(ref.url).slice(1, -1)
          replacements.set(value, {
            inline: value,
            canonical: ref.url,
            ...(cssInline !== value ? { cssInline, cssCanonical } : {}),
          })
          return value
        },
        syntax,
        { work },
      )
      const values = [...replacements.values()]
      const table = JSON.stringify(values)
      if (
        Buffer.byteLength(html) > PRIVATE_MEDIA_LIMITS.expandedBytes ||
        Buffer.byteLength(table) > PRIVATE_MEDIA_LIMITS.replacementBytes
      )
        throw new PrivateMaterializationError('limit')
      if (
        estimated + Buffer.byteLength(table) + Buffer.byteLength(source) * 5 + 65_536 >
        PRIVATE_MEDIA_LIMITS.responseBytes
      )
        throw new PrivateMaterializationError('limit')
      const expandedBytes = Buffer.byteLength(html)
      budget.chargeExpanded(expandedBytes)
      const result: PrivateMaterialization = {
        html,
        replacements: values,
        privateMedia: stored.size > 0 || inline.size > 0,
        costs: { resources, references: sourceReferences, parserWork, expandedBytes },
      }
      if (Buffer.byteLength(JSON.stringify(result)) > PRIVATE_MEDIA_LIMITS.responseBytes)
        throw new PrivateMaterializationError('limit')
      await job.read(() => assertRenderRead(scope))
      job.check()
      return result
    }, signal)
  } catch (error) {
    if (error instanceof PrivateReferenceError) throw new PrivateMaterializationError('invalid')
    throw resourceReadError(error)
  }
}
