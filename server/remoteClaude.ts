import { RemoteAppError } from '@cantelop/sdk'
import { Router } from 'express'
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
import { checkRemoteAuth, remoteClaudeConfigured, remoteWorkspace, remoteCall } from './remoteClaudeClient.ts'
import { store } from './store.ts'
import { canAccessCanvas } from './access.ts'
import { onFeedback } from './resident.ts'
import type { LocalAgentPreference } from '../shared/localAgent.ts'

async function activateRemote(userId: string, model: (typeof CLAUDE_MODEL_IDS)[number], attemptId?: string) {
  const previous = await getLocalAgentPreference(userId)
  if (previous.remoteAuthRequired) {
    if (!attemptId || previous.remoteAuthAttempt !== attemptId)
      throw new Error('Claude connection changed. Refresh and reconnect.')
    await clearRemoteAuth(userId, previous.remoteAuthGeneration ?? 0, attemptId)
  }
  if (previous.transport !== 'remote') await localAgentRuns.cancel(userId)
  await saveLocalAgentPreference(userId, { enabled: true, model, transport: 'remote' })
  const preference: LocalAgentPreference = await getLocalAgentPreference(userId)
  for (const canvas of store.canvases.values()) if (canAccessCanvas(userId, canvas)) onFeedback(canvas.id)
  return preference
}

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
    .object({
      model: z.enum(CLAUDE_MODEL_IDS),
    })
    .strict()
    .safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid Claude model.' })
    return
  }
  void (async () => {
    const userId = req.user!.id
    const previous = await getLocalAgentPreference(userId)
    if (previous.remoteAuthRequired) {
      res.status(409).json({ error: 'Reconnect Claude to resume hosted tasks.' })
      return
    }
    // A model change on an already active plan does not require another CLI startup.
    if (!(previous.enabled && previous.transport === 'remote') && !(await checkRemoteAuth(userId))) {
      res.status(409).json({ error: 'Complete native Claude sign-in first.' })
      return
    }
    res.json(await activateRemote(userId, parsed.data.model))
  })().catch(next)
})

remoteClaudeRouter.post('/disable', (req, res, next) => {
  void (async () => {
    await disableRemoteExecution(req.user!.id)
    await localAgentRuns.cancel(req.user!.id, 'remote')
    try {
      const auth = (await remoteWorkspace(req.user!.id)).auth()
      if (await remoteCall((signal) => auth.logout({ signal }))) throw new Error('Sign-out not confirmed')
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

const attemptId = z.string().regex(/^lgn_[0-9a-f]{32}$/)
const schemas = {
  start: z.object({ model: z.enum(CLAUDE_MODEL_IDS) }).strict(),
  code: z
    .object({
      attemptId,
      code: z
        .string()
        .min(1)
        .max(2048)
        // eslint-disable-next-line no-control-regex -- Codes must not inject CLI control input.
        .regex(/^[^\x00-\x1f\x7f]+$/),
      model: z.enum(CLAUDE_MODEL_IDS),
    })
    .strict(),
  cancel: z.object({ attemptId }).strict(),
}
for (const action of ['start', 'code', 'cancel'] as const) {
  remoteClaudeRouter.post(`/auth/${action}`, (req, res, next) => {
    const parsed = schemas[action].safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid Claude sign-in request.' })
      return
    }
    void (async () => {
      const userId = req.user!.id
      if (action === 'start') {
        const { model } = schemas.start.parse(req.body)
        const preference = await getLocalAgentPreference(userId)
        if (preference.remoteAuthRequired) await localAgentRuns.cancel(userId, 'remote')
        const auth = (await remoteWorkspace(userId)).auth()
        const result = await remoteCall((signal) => auth.login({ signal, force: !!preference.remoteAuthRequired }))
        if (!result.authenticated) {
          if (preference.remoteAuthRequired) await beginRemoteReauth(userId, result.attemptId)
          res.json({ attemptId: result.attemptId, url: result.url, expiresAt: result.expiresAt })
        } else if (!preference.remoteAuthRequired) {
          res.json({ authenticated: true, preference: await activateRemote(userId, model) })
        } else throw new Error('Hosted Claude returned an invalid sign-in response.')
        return
      }
      if (action === 'cancel') {
        const { attemptId } = schemas.cancel.parse(req.body)
        const auth = (await remoteWorkspace(userId)).auth()
        await remoteCall((signal) => auth.cancelLogin({ attemptId, signal }))
        res.json({ cancelled: true })
        return
      }
      const { attemptId, model, code } = schemas.code.parse(req.body)
      const auth = (await remoteWorkspace(userId)).auth()
      if (!(await remoteCall((signal) => auth.submitCode({ attemptId, code, signal })))) {
        res.status(409).json({
          error: 'Claude sign-in could not be confirmed. Start a new connection and try the sign-in code again.',
        })
        return
      }
      res.json({ authenticated: true, preference: await activateRemote(userId, model, attemptId) })
    })().catch(next)
  })
}
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
    if (
      error instanceof RemoteAppError &&
      ['code_rejected', 'login_not_active', 'login_failed', 'login_timeout', 'auth_logout_unconfirmed'].includes(
        error.code,
      )
    ) {
      res.status(error.code === 'code_rejected' ? 400 : 409).json({
        code: error.code,
        error:
          error.code === 'code_rejected'
            ? 'Claude did not accept that code. Paste it again.'
            : 'Claude sign-in could not be confirmed. Start a new connection.',
      })
      return
    }
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Hosted Claude is unavailable. Try again.',
    })
  },
)
