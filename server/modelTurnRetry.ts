/** A model response was cut off before its terminal event. */
export class ModelStreamInterruptedError extends Error {}

const TRANSIENT_CODES = new Set([
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

const MAX_RETRIES = 2

export function isInterruptedModelTurn(error: unknown): boolean {
  const seen = new Set<unknown>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    if (error instanceof ModelStreamInterruptedError) return true
    const detail = error as { code?: string; cause?: unknown }
    if (detail.code && TRANSIENT_CODES.has(detail.code)) return true
    error = detail.cause
  }
  return false
}

/** Retry only response generation. Callers execute tools after this resolves,
 * so incomplete responses cannot replay mutations or discard rewrite drafts.
 * A run canceled during the backoff gives up with the interrupting error
 * itself; the caller already knows the run is canceled and reports that. */
export async function retryModelTurn<T>(
  run: () => Promise<T>,
  options: { isCanceled: () => boolean; onRetry: (attempt: number) => void },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (options.isCanceled() || attempt >= MAX_RETRIES || !isInterruptedModelTurn(error)) throw error
      options.onRetry(attempt + 1)
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      if (options.isCanceled()) throw error
    }
  }
}
