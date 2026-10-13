import { RemoteAppError, type SessionEventCursor } from '@cantelop/sdk'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ClaudeEvent } from '../shared/remoteClaude.ts'
import { uuid } from '../cantelop/src/validation.ts'
import { loadClaudeApp } from './remoteClaudeApp.ts'
import { claudeRuntimeOrigin } from './remoteClaudeOrigins.ts'

export function remoteClaudeConfigured() {
  return !!(process.env.CLAUDE_REMOTE_URL && process.env.CANTELOP_INTEGRATION_TOKEN && process.env.CLAUDE_REMOTE_ISSUER)
}
export function remoteIdentity(userId: string) {
  if (!remoteClaudeConfigured()) throw new Error('Hosted execution is not configured on this Doop server.')
  claudeRuntimeOrigin(process.env.CLAUDE_REMOTE_URL!)
  // Retain the pre-1.0 namespace, including the issuer, to preserve Workspaces.
  return createHash('sha256')
    .update(JSON.stringify([process.env.CLAUDE_REMOTE_ISSUER, userId]))
    .digest('hex')
    .slice(0, 48)
}
export async function remoteWorkspace(userId: string) {
  const slug = `u-${remoteIdentity(userId)}`
  return (await loadClaudeApp()).workspace({ slug })
}
export async function remoteSession(userId: string, sessionId = `${remoteIdentity(userId)}:${randomUUID()}`) {
  const prefix = `${remoteIdentity(userId)}:`
  if (!sessionId.startsWith(prefix)) throw new Error('Hosted Claude session not found.')
  uuid(sessionId.slice(prefix.length))
  return (await remoteWorkspace(userId)).session({ id: sessionId, keepAliveSeconds: 300 })
}
function upstreamError(error: unknown): never {
  if (error instanceof RemoteAppError && error.status === 504)
    throw new Error('Hosted Claude did not respond in time. Try again; this does not mean you are signed out.')
  if (
    error instanceof RemoteAppError &&
    ['code_rejected', 'login_not_active', 'login_failed', 'login_timeout', 'auth_logout_unconfirmed'].includes(
      error.code,
    )
  )
    throw error
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
  userId: string,
  sessionId: string,
  signal: AbortSignal,
  onEvent: (event: ClaudeEvent) => Promise<void> | void,
  onOpen?: () => Promise<void>,
  initialCursor?: SessionEventCursor,
) {
  const session = await remoteSession(userId, sessionId)
  let cursor = initialCursor,
    opened = false,
    failures = 0
  while (!signal.aborted) {
    const connection = new AbortController()
    const connectionSignal = AbortSignal.any([signal, connection.signal])
    const timer = setTimeout(() => connection.abort(), 30_000)
    let handlerError: unknown
    try {
      const stream = session
        .stream({ signal: connectionSignal, ...(cursor ? { after: cursor } : {}) })
        [Symbol.asyncIterator]()
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
      try {
        while (!next.done && !signal.aborted) {
          const event = next.value
          try {
            await onEvent({ ...event.data, message_id: event.messageId } as ClaudeEvent)
          } catch (error) {
            handlerError = error
            throw error
          }
          cursor = event.cursor
          failures = 0
          if (signal.aborted) break
          next = await stream.next()
        }
      } finally {
        await stream.return?.()
      }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ClaudeStreamReset || handlerError)
        throw new ClaudeStreamReset(error instanceof ClaudeStreamReset ? error.message : String(handlerError))
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
    }
    await delay(1000, undefined, { signal }).catch(() => {})
  }
}
export async function checkRemoteAuth(userId: string): Promise<boolean> {
  const auth = (await remoteWorkspace(userId)).auth()
  return remoteCall((signal) => auth.status({ signal }))
}
