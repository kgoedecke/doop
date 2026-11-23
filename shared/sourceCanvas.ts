import { z } from 'zod'

const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])

export function localSourceOrigin(input: string): string | null {
  try {
    const url = new URL(input)
    if (
      url.protocol !== 'http:' ||
      !loopback.has(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null
    return url.origin
  } catch {
    return null
  }
}

export const SOURCE_CANVAS_PATH = '/__doop_source'
export const sourceId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/)
export const sourceColor = z.string().regex(/^#[\da-fA-F]{6}$/)
export const sourceText = z.string().max(1000)

export const sourceCard = z.object({
  id: sourceId,
  name: z.string().min(1).max(100),
  width: z.number().int().min(200).max(1920),
  height: z.number().int().min(180).max(1600),
})
export type SourceCard = z.infer<typeof sourceCard>

export const sourceProject = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(100),
  cards: z.array(sourceCard).min(1).max(12),
})

export const sourceSelection = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  revision: z.string().length(64),
  text: sourceText.optional(),
  color: sourceColor.optional(),
})

export const sourceChange = z.object({
  card: sourceId,
  marker: sourceId,
  revision: z.string().length(64),
  fields: z
    .object({ text: sourceText.optional(), color: sourceColor.optional() })
    .refine((fields) => fields.text !== undefined || fields.color !== undefined),
})

export const sourcePreviewEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('doop-source:ready') }),
  z.object({ type: z.literal('doop-source:select'), marker: sourceId.nullable() }),
  z.object({
    type: z.literal('doop-source:wheel'),
    x: z.number().finite(),
    y: z.number().finite(),
    dx: z.number().finite(),
    dy: z.number().finite(),
    zoom: z.boolean(),
  }),
  z.object({ type: z.literal('doop-source:escape') }),
])
