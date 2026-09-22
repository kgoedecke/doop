import { Router } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { CLAUDE_MODEL_IDS } from '../shared/localAgent.ts'
import { isBanned, PUBLIC_ORIGIN } from './auth.ts'
import { localAgentRuns } from './localAgentRuns.ts'
import {
  beginRemoteReauth,
  disableRemoteExecution,
  clearRemoteAuth,
  getLocalAgentPreference,
  saveLocalAgentPreference,
} from './localAgentPreferences.ts'
import {
  checkRemoteAuth,
  checkRemoteLogin,
  remoteClaudeConfigured,
  remoteFetch,
  remoteIdentity,
  remotePost,
} from './remoteClaudeClient.ts'
import { store } from './store.ts'
import { canAccessCanvas } from './access.ts'
import { onFeedback } from './resident.ts'

export const remoteClaudeRouter = Router()
remoteClaudeRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.headers['x-doop-user'] !== req.user!.id) {
    res.status(409).json({ error: 'Your Doop account changed. Refresh before reconnecting.' })
    return
  }
  if (req.impersonatedBy) {
    res.status(403).json({ error: 'Hosted account access is unavailable while viewing as another user.' })
    return
  }
  if (req.headers.origin && req.headers.origin !== PUBLIC_ORIGIN) {
    res.status(403).json({ error: 'Cross-origin account access denied.' })
    return
  }
  void isBanned(req.user!.id).then((banned) => {
    if (banned) res.status(403).json({ error: 'Account unavailable.' })
    else next()
  }, next)
})
remoteClaudeRouter.get('/', (req, res, next) => {
  getLocalAgentPreference(req.user!.id)
    .then((preference) =>
      res.json({
        configured: remoteClaudeConfigured(),
        running: localAgentRuns.runningRemote(req.user!.id),
        authRequired: preference.remoteAuthRequired ?? false,
      }),
    )
    .catch(next)
})
remoteClaudeRouter.post('/check', (req, res, next) => {
  checkRemoteAuth(req.user!.id)
    .then((authenticated) => res.json({ authenticated }))
    .catch(next)
})
remoteClaudeRouter.post('/select', (req, res, next) => {
  const parsed = z
    .object({ model: z.enum(CLAUDE_MODEL_IDS), loginAttemptId: z.string().uuid().optional() })
    .strict()
    .safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid Claude model.' })
    return
  }
  void (async () => {
    const userId = req.user!.id
    const previous = await getLocalAgentPreference(userId)
    if (
      previous.remoteAuthRequired &&
      (!parsed.data.loginAttemptId ||
        previous.remoteAuthAttempt !== parsed.data.loginAttemptId ||
        !(await checkRemoteLogin(userId, parsed.data.loginAttemptId)))
    ) {
      res.status(409).json({ error: 'Reconnect Claude to resume hosted tasks.' })
      return
    }
    if (!(await checkRemoteAuth(userId))) {
      res.status(409).json({ error: 'Complete native Claude sign-in first.' })
      return
    }
    if (previous.transport !== 'remote') await localAgentRuns.cancel(userId)
    await saveLocalAgentPreference(userId, { enabled: true, model: parsed.data.model, transport: 'remote' })
    await clearRemoteAuth(
      userId,
      previous.remoteAuthGeneration ?? 0,
      previous.remoteAuthRequired ? parsed.data.loginAttemptId : undefined,
    )
    res.json(await getLocalAgentPreference(userId))
    for (const canvas of store.canvases.values()) if (canAccessCanvas(userId, canvas)) onFeedback(canvas.id)
  })().catch(next)
})

remoteClaudeRouter.post('/disable', (req, res, next) => {
  void (async () => {
    await disableRemoteExecution(req.user!.id)
    await localAgentRuns.cancel(req.user!.id, 'remote')
    try {
      const result = await remotePost(req.user!.id, '/v1/auth/logout', {})
      if (
        result.sessionId !== `${remoteIdentity(req.user!.id)}:auth` ||
        result.type !== 'auth.status' ||
        result.authenticated !== false
      )
        throw new Error('Sign-out not confirmed')
    } catch {
      throw new Error(
        'Claude Plan is disconnected, but Claude sign-out could not be confirmed. Retry disconnecting to finish signing out.',
      )
    }
    res.json(await getLocalAgentPreference(req.user!.id))
  })().catch(next)
})
remoteClaudeRouter.post('/stop', (req, res, next) => {
  localAgentRuns
    .cancel(req.user!.id, 'remote')
    .then(() => res.json({ ok: true }))
    .catch(next)
})

const attempt = z.string().uuid()
const publicKey = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    ext: z.boolean().optional(),
    key_ops: z.array(z.string()).optional(),
  })
  .strict()
const schemas = {
  start: z.union([
    z.object({}).strict(),
    z.object({ attemptId: attempt, publicKey, force: z.boolean().optional() }).strict(),
  ]),
  input: z
    .object({
      attemptId: attempt,
      sequence: z.number().int().positive(),
      iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
      data: z
        .string()
        .min(24)
        .max(8192)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
  cancel: z.object({ attemptId: attempt }).strict(),
}
for (const action of ['start', 'input', 'cancel'] as const) {
  remoteClaudeRouter.post(`/auth/${action}`, (req, res, next) => {
    const parsed = schemas[action].safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid encrypted login request.' })
      return
    }
    void (async () => {
      if (action === 'start' && 'attemptId' in parsed.data && 'publicKey' in parsed.data) {
        const preference = await getLocalAgentPreference(req.user!.id)
        if (preference.remoteAuthRequired) {
          await beginRemoteReauth(req.user!.id, parsed.data.attemptId)
          Object.assign(parsed.data, { force: true })
        }
      }
      const result = await remotePost(req.user!.id, action === 'start' ? '/v1/auth' : `/v1/auth/${action}`, parsed.data)
      res.status(202).json({ sessionId: result.sessionId })
    })().catch(next)
  })
}
// Only the caller's deterministic auth session is exposed to the browser.
// No agent events, application JWTs, plaintext terminal input, or arbitrary URLs.
remoteClaudeRouter.get('/events', (req, res, next) => {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(11 * 60_000)])
  res.on('close', () => controller.abort())
  void (async () => {
    const cursor = req.headers['last-event-id']
    if (typeof cursor === 'string' && cursor.length > 256) {
      res.status(400).end()
      return
    }
    const sessionId = `${remoteIdentity(req.user!.id)}:auth`
    const upstream = await remoteFetch(req.user!.id, `/v1/events?sessionId=${encodeURIComponent(sessionId)}`, {
      signal,
      headers: typeof cursor === 'string' ? { 'Last-Event-ID': cursor } : {},
    })
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: 'Claude login stream unavailable.' })
      return
    }
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res, { signal })
  })()
    .catch((error: unknown) => {
      if (controller.signal.aborted) return
      if (res.headersSent) res.end()
      else next(error)
    })
    .finally(() => controller.abort())
})

remoteClaudeRouter.use(
  (
    error: unknown,
    _req: import('express').Request,
    res: import('express').Response,
    _next: import('express').NextFunction,
  ) => {
    if (res.headersSent) {
      res.end()
      return
    }
    res.status(502).json({ error: error instanceof Error ? error.message : 'Hosted Claude is unavailable. Try again.' })
  },
)
