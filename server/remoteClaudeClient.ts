import { createHash, createPrivateKey, sign } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { consumeClaudeEvents, type ClaudeEvent } from '../shared/remoteClaude.ts'

export function remoteClaudeConfigured() {
  return !!(
    process.env.CLAUDE_REMOTE_URL &&
    process.env.CLAUDE_REMOTE_SIGNING_KEY &&
    process.env.CLAUDE_REMOTE_ISSUER &&
    process.env.CLAUDE_REMOTE_AUDIENCE
  )
}

function settings() {
  if (!remoteClaudeConfigured()) throw new Error('Hosted execution is not configured on this Doop server.')
  const url = new URL(process.env.CLAUDE_REMOTE_URL!)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('CLAUDE_REMOTE_URL must be an HTTPS origin.')
  }
  return {
    origin: url.origin,
    issuer: process.env.CLAUDE_REMOTE_ISSUER!,
    audience: process.env.CLAUDE_REMOTE_AUDIENCE!,
  }
}

export function remoteIdentity(userId: string) {
  const { issuer } = settings()
  return createHash('sha256')
    .update(JSON.stringify([issuer, userId]))
    .digest('hex')
    .slice(0, 48)
}

export function remoteBearer(userId: string) {
  const { issuer, audience } = settings()
  const key = createPrivateKey(process.env.CLAUDE_REMOTE_SIGNING_KEY!.replace(/\\n/g, '\n'))
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Hosted execution requires an ES256 signing key.')
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({ sub: userId, iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 300 })}`
  return `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

export async function remoteFetch(userId: string, path: string, options: RequestInit = {}) {
  const { origin } = settings()
  return fetch(`${origin}${path}`, {
    ...options,
    redirect: 'error',
    headers: { ...options.headers, Authorization: `Bearer ${remoteBearer(userId)}` },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  })
}

export async function remotePost(
  userId: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ sessionId: string; messageId?: string; receiptId?: string; type?: string; authenticated?: boolean }> {
  const json = JSON.stringify(body)
  if (Buffer.byteLength(json) > 48 * 1024)
    throw new Error('Hosted Claude request exceeds 48 KiB. Reduce the task context.')
  // Request/reply checks can wait 30 seconds inside the API, before transport overhead.
  const timeout = AbortSignal.timeout(
    path === '/v1/auth' || path === '/v1/auth/complete' || path === '/v1/snapshot' ? 45_000 : 30_000,
  )
  const response = await remoteFetch(userId, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    if (response.status === 504)
      throw new Error('Hosted Claude did not respond in time. Try again; this does not mean you are signed out.')
    // Never expose upstream bodies: configuration can contain MCP credentials.
    throw new Error(`Hosted Claude request failed (${response.status}). Check the connection in Settings.`)
  }
  return response.json()
}

export class ClaudeStreamReset extends Error {}

/** Fresh application JWT on every reconnect; model credentials never enter Doop. */
export async function remoteEvents(
  userId: string,
  sessionId: string,
  signal: AbortSignal,
  onEvent: (event: ClaudeEvent) => Promise<void> | void,
  onOpen?: () => Promise<void>,
) {
  let cursor = ''
  let opened = false
  let failures = 0
  while (!signal.aborted) {
    const connection = new AbortController()
    const connectionSignal = AbortSignal.any([signal, connection.signal])
    const openingTimer = setTimeout(() => connection.abort(), 30_000)
    try {
      const response = await remoteFetch(userId, `/v1/events?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: cursor ? { 'Last-Event-ID': cursor } : {},
        signal: connectionSignal,
      })
      clearTimeout(openingTimer)
      if (!response.ok)
        throw new ClaudeStreamReset(`Hosted Claude stream failed (${response.status}). Reconnect in Settings.`)
      // Start reading before dispatch, including if dispatch waits on the runtime.
      let handlerError: unknown
      const reading = consumeClaudeEvents(
        response,
        async (event) => {
          if (
            ['auth.reset', 'event_stream_reset', 'event_cursor_expired'].includes(event.type) ||
            (event.type === 'error' && ['event_stream_reset', 'event_cursor_expired'].includes(event.code))
          ) {
            throw new ClaudeStreamReset(
              'Hosted Claude lost its event history. Retry the task; previous edits may already have completed.',
            )
          }
          try {
            await onEvent(event)
          } catch (error) {
            handlerError = error
            throw error
          }
        },
        (id) => {
          cursor = id
          failures = 0
        },
        connectionSignal,
      )
      void reading.catch(() => {})
      if (!opened) {
        opened = true
        try {
          await onOpen?.()
        } catch (error) {
          throw new ClaudeStreamReset(error instanceof Error ? error.message : 'Hosted dispatch failed.')
        }
      }
      try {
        await reading
      } catch (error) {
        if (handlerError) throw new ClaudeStreamReset(String(handlerError))
        throw error
      }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ClaudeStreamReset || ++failures > 5) throw error
    } finally {
      clearTimeout(openingTimer)
      connection.abort()
    }
    await delay(1000, undefined, { signal }).catch(() => {})
  }
}

export async function checkRemoteAuth(userId: string): Promise<boolean> {
  // SDK 0.11 auth checks are request/reply operations, not streamed events.
  const reply = await remotePost(userId, '/v1/auth', {})
  if (
    reply?.sessionId !== `${remoteIdentity(userId)}:auth` ||
    reply.type !== 'auth.status' ||
    typeof reply.authenticated !== 'boolean'
  )
    throw new Error('Hosted Claude returned an invalid authentication status. Try again.')
  return reply.authenticated
}

/** Verify a native login completion without trusting the browser's success claim. */
export async function checkRemoteLogin(userId: string, attemptId: string): Promise<boolean> {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
  let succeeded = false
  try {
    await remoteEvents(userId, `${remoteIdentity(userId)}:auth`, signal, (event) => {
      if (event.type === 'auth.finished' && event.attemptId === attemptId) {
        succeeded = event.authenticated && event.outcome === 'succeeded'
        controller.abort()
      }
    })
    return succeeded
  } finally {
    controller.abort()
  }
}
