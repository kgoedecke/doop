import { createHash } from 'node:crypto'
import { FONT_FILE_TYPES, fontFormatOf, sniffMime } from '../shared/mediaTypes.ts'
import { PrivateMaterializationError, type PrivateMediaBudget } from '../shared/privateMedia.ts'
import { assertRenderRead, PrivateResourceError, type PrivateRenderScope } from './privateResources.ts'
import { env } from './env.ts'
import { visitPrivateReferences } from '../shared/privateReferences.ts'
import { materializePrivateResources } from './privateMaterialization.ts'
import { runMaterializationJob } from './materializationJob.ts'
import { validateMediaInputs } from './privateMediaValidation.ts'

/** No URL fetch or privileged HTTP fallback: the guard supplies anonymous bytes. */
export function privatePublicMedia(
  scope: PrivateRenderScope,
  budget: PrivateMediaBudget,
  preparedRequests = new Set<string>(),
) {
  const validated = new Set<string>()
  return {
    beginRequest: (url: string) => {
      if (!preparedRequests.delete(url)) budget.reference()
    },
    accountChunk: (bytes: number) => budget.chargeEncoded(bytes),
    async validateResponse(
      body: Buffer,
      declaredMime: string,
      type: string,
      url: string,
      signal: AbortSignal,
    ): Promise<void> {
      const imageMime = sniffMime(body)
      const format = fontFormatOf(body)
      if (format === 'collection') throw new PrivateMaterializationError('unsupported')
      const mime = imageMime ?? (format ? FONT_FILE_TYPES[format].mime : undefined)
      if (mime) {
        const key = `${url}:${mime}:${createHash('sha256').update(body).digest('hex')}`
        await runMaterializationJob(async (job) => {
          await job.read(() => assertRenderRead(scope))
          if (!validated.has(key))
            await validateMediaInputs(
              job,
              [{ bytes: body, mime }],
              (cost) => {
                budget.chargeDecoded(cost.decodedBytes)
                budget.chargeWork(cost.parserWork ?? 0)
              },
              budget.parserWork,
            )
          await job.read(() => assertRenderRead(scope))
          job.check()
          validated.add(key)
        }, signal)
        return
      }
      if (type === 'image' || type === 'font') throw new PrivateMaterializationError('unsupported')
      const syntax =
        type === 'stylesheet' || /text\/css/i.test(declaredMime)
          ? 'stylesheet'
          : type === 'document' && /html|xhtml/i.test(declaredMime)
            ? 'html'
            : undefined
      if (!syntax) return
      const source = new TextDecoder('utf-8', { fatal: true }).decode(body)
      // Remote CSS/HTML cannot ask a privileged owner to repair private URLs.
      visitPrivateReferences(
        source,
        env.BETTER_AUTH_URL,
        () => {
          throw new PrivateResourceError()
        },
        syntax,
        {
          work: (count) => budget.chargeWork(count),
        },
      )
      await materializePrivateResources(source, scope, {
        syntax,
        budget,
        signal,
        publicReference: (url) => preparedRequests.add(url),
      })
    },
  }
}
