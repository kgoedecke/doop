/** Separate units: encoded media, intrinsic decoder output, transport, and pixels. */
export const PRIVATE_MEDIA_LIMITS = Object.freeze({
  encodedBytes: 15_000_000,
  decodedBytes: 64 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  replacementBytes: 32 * 1024 * 1024,
  responseBytes: 64 * 1024 * 1024,
  references: 64,
  parserWork: 16_384,
  side: 16_384,
  pixels: 16_777_216,
  animationFrames: 100,
  fontTables: 256,
  fontBytes: 48 * 1024 * 1024,
  responseMs: 30_000,
  storageConcurrency: 4,
})

/** Openbot's MCP base64 fields admit 16,384 characters (four per three bytes). */
export const MAX_INLINE_MCP_MEDIA_BYTES = 12_288

const messages = {
  limit: 'The document exceeds the private media budget.',
  unsupported: 'The document contains an unsupported private media resource.',
  invalid: 'A private media resource could not be decoded.',
  aborted: 'Private media preparation was cancelled or timed out.',
} as const

export class PrivateMaterializationError extends Error {
  constructor(readonly kind: keyof typeof messages) {
    super(messages[kind])
    this.name = 'PrivateMaterializationError'
  }
}

const budgetKeys = ['encodedBytes', 'decodedBytes', 'references', 'parserWork', 'expandedBytes'] as const
export type PrivateMediaRemaining = { readonly [K in (typeof budgetKeys)[number]]: number }
export type PrivateMediaAllowance = Partial<PrivateMediaRemaining>

/** Client input can only reduce fixed maxima; no resource cost is accepted here. */
export function privateMediaAllowance(value?: unknown): PrivateMediaRemaining {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new PrivateMaterializationError('invalid')
  const input = (value ?? {}) as Record<string, unknown>
  if (Object.keys(input).some((key) => !budgetKeys.includes(key as (typeof budgetKeys)[number])))
    throw new PrivateMaterializationError('invalid')
  const result = {} as Record<(typeof budgetKeys)[number], number>
  for (const key of budgetKeys) {
    const limit = key in input ? input[key] : PRIVATE_MEDIA_LIMITS[key]
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0 || limit > PRIVATE_MEDIA_LIMITS[key])
      throw new PrivateMaterializationError('invalid')
    result[key] = limit
  }
  return Object.freeze(result)
}

export interface PrivateResourceCost {
  readonly key: string
  readonly mime: string
  readonly encodedBytes: number
  readonly decodedBytes: number
}

export interface PrivateMaterializationCosts {
  readonly resources: readonly PrivateResourceCost[]
  readonly references: number
  readonly parserWork: number
  readonly expandedBytes: number
}

export function assertPrivateMediaCosts(costs: PrivateMaterializationCosts): void {
  if (!costs || !Array.isArray(costs.resources) || costs.resources.length > PRIVATE_MEDIA_LIMITS.references)
    throw new PrivateMaterializationError('invalid')
  for (const key of ['references', 'parserWork', 'expandedBytes'] as const)
    if (!Number.isSafeInteger(costs[key]) || costs[key] < 0 || costs[key] > PRIVATE_MEDIA_LIMITS[key])
      throw new PrivateMaterializationError('invalid')
  for (const row of costs.resources) {
    if (
      !row ||
      typeof row.key !== 'string' ||
      !row.key.length ||
      row.key.length > 512 ||
      typeof row.mime !== 'string' ||
      !row.mime.length ||
      row.mime.length > 128
    )
      throw new PrivateMaterializationError('invalid')
    for (const key of ['encodedBytes', 'decodedBytes'] as const)
      if (!Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > PRIVATE_MEDIA_LIMITS[key])
        throw new PrivateMaterializationError('invalid')
  }
}

/** One render shares this owner across private, inline and fulfilled media. */
export class PrivateMediaBudget {
  private readonly limits: PrivateMediaRemaining
  private readonly used = { encodedBytes: 0, decodedBytes: 0, references: 0, parserWork: 0, expandedBytes: 0 }
  private readonly encodedResources = new Map<string, number>()
  private readonly decodedResources = new Map<string, number>()

  constructor(initialWork = 0, allowance?: PrivateMediaAllowance) {
    this.limits = privateMediaAllowance(allowance)
    this.chargeWork(initialWork)
  }

  get parserWork(): number {
    return this.used.parserWork
  }
  get usage(): PrivateMediaRemaining {
    return { ...this.used }
  }
  get remaining(): PrivateMediaRemaining {
    return Object.fromEntries(
      budgetKeys.map((key) => [key, this.limits[key] - this.used[key]]),
    ) as unknown as PrivateMediaRemaining
  }

  chargeWork(count: number): void {
    this.charge('parserWork', count)
  }
  reference(count = 1): void {
    this.charge('references', count)
  }
  chargeEncoded(bytes: number): void {
    this.charge('encodedBytes', bytes)
  }
  chargeDecoded(bytes: number): void {
    this.charge('decodedBytes', bytes)
  }
  chargeExpanded(bytes: number): void {
    this.charge('expandedBytes', bytes)
  }

  assertExpansion(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remaining.expandedBytes)
      throw new PrivateMaterializationError('limit')
  }

  reserveEncoded(key: string, bytes: number): void {
    this.reserve(this.encodedResources, 'encodedBytes', key, bytes)
  }
  reserveDecoded(key: string, bytes: number): void {
    this.reserve(this.decodedResources, 'decodedBytes', key, bytes)
  }

  /** Only merge producer-derived rows. This metadata never grants private access. */
  merge(costs: PrivateMaterializationCosts): void {
    assertPrivateMediaCosts(costs)
    for (const row of costs.resources) {
      this.reserveEncoded(row.key, row.encodedBytes)
      this.reserveDecoded(row.key, row.decodedBytes)
    }
    this.reference(costs.references)
    this.chargeWork(costs.parserWork)
    this.chargeExpanded(costs.expandedBytes)
  }

  private reserve(rows: Map<string, number>, unit: 'encodedBytes' | 'decodedBytes', key: string, bytes: number): void {
    if (rows.has(key)) {
      if (rows.get(key) !== bytes) throw new PrivateMaterializationError('invalid')
      return
    }
    if (rows.size >= PRIVATE_MEDIA_LIMITS.references) throw new PrivateMaterializationError('limit')
    this.charge(unit, bytes)
    rows.set(key, bytes)
  }

  private charge(key: (typeof budgetKeys)[number], bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits[key] - this.used[key])
      throw new PrivateMaterializationError('limit')
    this.used[key] += bytes
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/** Charge all animation frames before allowing a decoder to allocate RGBA. */
export function rasterDecodedBytes(width: number, height: number, pages = 1): number {
  if (![width, height, pages].every(positiveInteger)) throw new PrivateMaterializationError('invalid')
  const pixels = width * height * pages
  if (
    width > PRIVATE_MEDIA_LIMITS.side ||
    height > PRIVATE_MEDIA_LIMITS.side ||
    pages > PRIVATE_MEDIA_LIMITS.animationFrames ||
    !Number.isSafeInteger(pixels) ||
    pixels > PRIVATE_MEDIA_LIMITS.pixels
  )
    throw new PrivateMaterializationError('limit')
  return pixels * 4
}

/** Output scale is independent of the intrinsic media budget. */
export function assertRenderPixels(width: number, height: number, scale = 1): void {
  if (![width, height, scale].every((value) => Number.isFinite(value) && value > 0))
    throw new PrivateMaterializationError('invalid')
  if (width > PRIVATE_MEDIA_LIMITS.side || height > PRIVATE_MEDIA_LIMITS.side)
    throw new PrivateMaterializationError('limit')
  rasterDecodedBytes(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
}

export interface PrivateReplacement {
  readonly inline: string
  readonly canonical: string
  readonly cssInline?: string
  readonly cssCanonical?: string
}

export interface PrivateMaterialization {
  readonly html: string
  readonly replacements: readonly PrivateReplacement[]
  readonly privateMedia: boolean
  readonly costs: PrivateMaterializationCosts
}

export interface PrivateDocumentContext {
  readonly canvasId: string
  readonly kind: 'frame' | 'reference'
  readonly id: string
}
