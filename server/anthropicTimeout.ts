/**
 * Shared timeout for every `@anthropic-ai/sdk` client the server creates.
 *
 * The SDK rejects a non-streaming request up front once its max_tokens
 * implies a generation time past its default 10-minute timeout ("Streaming
 * is required for operations that may take longer than 10 minutes."). The
 * Doop Agent's GitHub-recon pass asks for up to 32k output tokens, which
 * trips that default. `ANTHROPIC_TIMEOUT_MS` raises the client's own timeout
 * so the SDK's estimate clears it instead.
 */
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 15 * 60 * 1000

/** Pure so it's testable without mocking process.env / module state. */
export function resolveAnthropicTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.ANTHROPIC_TIMEOUT_MS
  if (!raw) return DEFAULT_ANTHROPIC_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`[anthropic] ignoring invalid ANTHROPIC_TIMEOUT_MS=${raw}, using default`)
    return DEFAULT_ANTHROPIC_TIMEOUT_MS
  }
  return parsed
}

export const ANTHROPIC_TIMEOUT_MS = resolveAnthropicTimeoutMs(process.env)
