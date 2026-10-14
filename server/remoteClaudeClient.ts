import { RemoteAppError, type SessionEventCursor } from '@cantelop/sdk'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ClaudeSessionEvent as ClaudeEvent } from '@cantelop/sdk/harnesses/claude/protocol'
import { doopClaude } from '../.cantelop/client/client.mjs'

export function remoteClaudeConfigured() {
  return !!(process.env.CANTELOP_APP_SLUG && process.env.CANTELOP_INTEGRATION_TOKEN && process.env.CLAUDE_REMOTE_ISSUER)
}
export function remoteIdentity(userId: string) {
  if (!remoteClaudeConfigured()) throw new Error('Hosted execution is not configured on this Doop server.')
  // Retain the pre-1.0 namespace, including the issuer, to preserve Workspaces.
  return createHash('sha256')
    .update(JSON.stringify([process.env.CLAUDE_REMOTE_ISSUER, userId]))
    .digest('hex')
    .slice(0, 48)
}
export function remoteWorkspace(userId: string) {
  const slug = `u-${remoteIdentity(userId)}`
  return doopClaude.workspace({ slug })
}
export type ClaudeSession = ReturnType<ReturnType<typeof remoteWorkspace>['session']>
export function isRemoteAuthError(error: unknown): error is RemoteAppError {
  return (
    error instanceof RemoteAppError &&
    ['code_rejected', 'login_not_active', 'login_failed', 'login_timeout', 'auth_logout_unconfirmed'].includes(
      error.code,
    )
  )
}
function upstreamError(error: unknown): never {
  if (error instanceof RemoteAppError && error.status === 504)
    throw new Error('Hosted Claude did not respond in time. Try again; this does not mean you are signed out.')
  if (isRemoteAuthError(error)) throw error
  // Never expose upstream bodies or configuration containing MCP credentials.
  throw new Error('Hosted Claude request failed. Check the connection in Settings.')
}

/** Bound and sanitize backend SDK calls without translating their typed operations. */
export async function remoteCall<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(150_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    return await operation(requestSignal)
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason
    upstreamError(error)
  }
}

export class ClaudeStreamReset extends Error {}
/** Reconnect only the subscription. Never redispatch work on stream failures. */
export async function remoteEvents(
  session: ClaudeSession,
  signal: AbortSignal,
  onEvent: (event: ClaudeEvent) => Promise<void> | void,
  onOpen?: () => Promise<void>,
) {
  let cursor: SessionEventCursor | undefined
  let opened = false,
    failures = 0
  while (!signal.aborted) {
    const connection = new AbortController()
    const connectionSignal = AbortSignal.any([signal, connection.signal])
    const timer = setTimeout(() => connection.abort(), 30_000)
    const stream = session
      .stream({ signal: connectionSignal, ...(cursor ? { after: cursor } : {}) })
      [Symbol.asyncIterator]()
    try {
      // Start establishing the subscription before dispatching. Request acceptance
      // is asynchronous; output is buffered even when the stream has no first event.
      const first = stream.next()
      void first.catch(() => {})
      if (!opened) {
        opened = true
        try {
          await onOpen?.()
        } catch (error) {
          throw new ClaudeStreamReset(String(error))
        }
      }
      let next = await first
      clearTimeout(timer)
      while (!next.done && !signal.aborted) {
        const event = next.value
        try {
          await onEvent(event.data)
        } catch (error) {
          throw new ClaudeStreamReset(String(error))
        }
        cursor = event.cursor
        failures = 0
        if (signal.aborted) break
        next = await stream.next()
      }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ClaudeStreamReset) throw error
      if (
        error instanceof RemoteAppError &&
        (['event_stream_reset', 'event_cursor_expired', 'invalid_event_stream'].includes(error.code) ||
          (error.status >= 400 && error.status < 500 && error.status !== 429))
      )
        throw new ClaudeStreamReset(
          'Hosted Claude lost its event history. Retry the task; previous edits may already have completed.',
        )
      if (++failures > 5) upstreamError(error)
    } finally {
      clearTimeout(timer)
      connection.abort()
      await stream.return?.().catch(() => {})
    }
    await delay(1000, undefined, { signal }).catch(() => {})
  }
}
export async function checkRemoteAuth(userId: string): Promise<boolean> {
  const auth = remoteWorkspace(userId).auth()
  return remoteCall((signal) => auth.status({ signal }))
}
