import { z } from 'zod'

export const GEMINI_CLOUD_TIMEOUT_MS = 30 * 60_000

export const geminiCloudJobSchema = z.object({
  id: z.string().uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  prompt: z.string().min(1).max(500_000),
  system: z.string().min(1).max(500_000),
  maxTurns: z.number().int().min(1).max(200),
})
export type GeminiCloudJob = z.infer<typeof geminiCloudJobSchema>

export const geminiCloudResultSchema = z.object({
  success: z.boolean(),
  text: z.string().max(100_000),
})

export function httpOrigin(value: string): string {
  const url = new URL(value)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Expected an HTTP(S) origin without credentials or a path')
  }
  return url.origin
}
