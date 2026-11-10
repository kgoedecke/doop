import type { Frame } from '../../shared/types'
import * as css from 'css-tree'
import { inlineMedia } from '../../shared/inlineMedia'
import {
  PrivateMediaBudget,
  PrivateMaterializationError,
  PRIVATE_MEDIA_LIMITS,
  assertPrivateMediaCosts,
  type PrivateMediaAllowance,
  type PrivateDocumentContext,
  type PrivateMaterialization,
} from '../../shared/privateMedia'
import { preparePrivateDocument, privateMediaOperation, type PrivateMaterializer } from './privateMaterialization'

/** One trusted-parent export. No completed bytes or authority survive its close. */
export class PrivateExportOperation {
  readonly budget = new PrivateMediaBudget()
  readonly context: PrivateDocumentContext
  private readonly lifetime
  readonly signal: AbortSignal
  private preparation = Promise.resolve()
  private readonly inlineResources = new Set<string>()
  private readonly publicBytes = new Map<string, number>()

  constructor(
    frame: Pick<Frame, 'id' | 'canvasId'>,
    signal?: AbortSignal,
    private readonly materialize: PrivateMaterializer = preparePrivateDocument,
  ) {
    this.context = Object.freeze({ canvasId: frame.canvasId, kind: 'frame', id: frame.id })
    this.lifetime = privateMediaOperation(signal)
    this.signal = this.lifetime.signal
  }

  async document(source: string, syntax: 'html' | 'stylesheet' | 'value' = 'html'): Promise<PrivateMaterialization> {
    return this.serial(async () => {
      const prepared = await this.materialize(source, this.context, this.signal, syntax, this.budget.remaining)
      this.signal.throwIfAborted()
      this.budget.merge(prepared.costs)
      for (const row of prepared.costs.resources) if (row.key.startsWith('inline:')) this.inlineResources.add(row.key)
      return prepared
    })
  }

  /** Call after asynchronous raster/crop work and immediately before delivery. */
  async revalidate(): Promise<void> {
    await this.serial(async () => {
      await this.materialize('', this.context, this.signal, 'html', this.budget.remaining)
      this.signal.throwIfAborted()
    })
  }

  /** Reserve anonymous chunks before buffering, without trusting an HTTP length. */
  publicChunk(key: string, bytes: number): void {
    this.signal.throwIfAborted()
    if (!this.publicBytes.has(key) && this.publicBytes.size >= PRIVATE_MEDIA_LIMITS.references)
      throw new PrivateMaterializationError('limit')
    this.budget.chargeEncoded(bytes)
    this.publicBytes.set(key, (this.publicBytes.get(key) ?? 0) + bytes)
  }

  privateResource(url: string): Promise<string> {
    return this.serial(async () => {
      const { prepared, row } = await this.resource(url, { ...this.budget.remaining, references: 1 })
      if (!row.key.startsWith(`private:${this.context.canvasId}:`) || prepared.replacements.length !== 1)
        throw new PrivateMaterializationError('invalid')
      this.budget.reserveEncoded(row.key, row.encodedBytes)
      this.budget.reserveDecoded(row.key, row.decodedBytes)
      return prepared.replacements[0]!.inline
    })
  }

  publicResource(uri: string, key: string, bytes: number): Promise<string> {
    return this.serial(async () => {
      if (this.publicBytes.get(key) !== bytes) throw new PrivateMaterializationError('invalid')
      // The wrapper uses the bytes/reference already reserved for this resource.
      // Every supplied limit remains <= the fixed server maximum; costs come back
      // from the real server parser/decoder, never from the browser request.
      const { row } = await this.resource(uri, {
        ...this.budget.remaining,
        references: 1,
        encodedBytes: this.budget.remaining.encodedBytes + bytes,
      })
      if (!row.key.startsWith('inline:') || row.encodedBytes !== bytes) throw new PrivateMaterializationError('invalid')
      this.budget.reserveDecoded(`public:${key}:${row.key}`, row.decodedBytes)
      return `data:${row.mime};base64,${uri.slice(uri.indexOf(',') + 1)}`
    })
  }

  inlineResource(uri: string): Promise<string> {
    return this.serial(async () => {
      const media = inlineMedia(uri, 'media')
      if (!media || media.syntax) throw new PrivateMaterializationError('unsupported')
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(media.bytes))
      this.signal.throwIfAborted()
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const key = `inline:${media.mime}:${hash}`
      // Reuse only an identical payload already admitted by this operation's
      // producer. Alternate data-URL encodings cannot spend its budget twice.
      if (this.inlineResources.has(key)) return uri
      const { row } = await this.resource(uri, { ...this.budget.remaining, references: 1 })
      if (row.key !== key) throw new PrivateMaterializationError('invalid')
      this.budget.reserveEncoded(row.key, row.encodedBytes)
      this.budget.reserveDecoded(row.key, row.decodedBytes)
      this.inlineResources.add(key)
      return uri
    })
  }

  private async resource(source: string, allowance: PrivateMediaAllowance) {
    const prepared = await this.materialize(
      `url(${css.string.encode(source)})`,
      this.context,
      this.signal,
      'value',
      allowance,
    )
    this.signal.throwIfAborted()
    assertPrivateMediaCosts(prepared.costs)
    const row = prepared.costs.resources[0]
    if (
      prepared.costs.references !== 1 ||
      prepared.costs.resources.length !== 1 ||
      !row ||
      !/^(?:image|font)\//.test(row.mime)
    )
      throw new PrivateMaterializationError('unsupported')
    this.budget.chargeWork(prepared.costs.parserWork)
    return { prepared, row }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.preparation.then(() => {
      this.signal.throwIfAborted()
      return work()
    })
    this.preparation = pending.then(
      () => {},
      () => {
        this.close()
      },
    )
    return pending
  }

  close(): void {
    this.lifetime.close()
    this.publicBytes.clear()
    this.inlineResources.clear()
  }
}
