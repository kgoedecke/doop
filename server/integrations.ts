import express from 'express'
import * as meta from './meta.ts'
import { extensions } from './extensions.ts'

/**
 * The Integrations page's surface, mounted at /api/integrations (behind the
 * session gate). Connections are per user — an integration is a thing you
 * hold, and automations you own draw on it. Each provider gets its own
 * sub-path and its own key in the status object.
 */
export const integrationsRouter = express.Router()

export interface IntegrationsStatus {
  meta: meta.MetaConnectionInfo & { enabled: boolean }
  /** one key per extension (see server/extensions.ts) — the client side of
   *  each integration knows its own shape */
  [extension: string]: unknown
}

async function statusFor(userId: string): Promise<IntegrationsStatus> {
  const metaRow = await meta.getConnection(userId)
  const status: IntegrationsStatus = { meta: { enabled: meta.metaEnabled(), ...meta.connectionInfo(metaRow) } }
  for (const extension of extensions) {
    if (extension.connectionStatus) status[extension.id] = await extension.connectionStatus(userId)
  }
  return status
}

integrationsRouter.get('/', async (req, res) => {
  res.json(await statusFor(req.user!.id))
})

integrationsRouter.post('/meta/start', (req, res) => {
  if (!meta.metaEnabled()) return res.status(400).json({ error: 'the Meta app is not configured on this server' })
  res.json({ url: meta.authorizeUrl(meta.signState(req.user!.id)) })
})

/* Meta's redirect back. The state proves the round-trip began here for THIS
   signed-in user — a code pasted from someone else's browser binds nothing.
   Outcomes land on the Integrations page with a visible reason. */
integrationsRouter.get('/meta/callback', async (req, res) => {
  const fail = (reason: string) => res.redirect(`/integrations?metaError=${encodeURIComponent(reason)}`)
  const state = meta.verifyState(String(req.query.state ?? ''))
  if (!state || state.userId !== req.user!.id) return fail('the Meta handoff expired — try connecting again')
  const code = String(req.query.code ?? '')
  if (!code) {
    const why = String(req.query.error_description ?? req.query.error ?? 'Meta sent no code back')
    return fail(why)
  }
  try {
    await meta.connect(req.user!.id, code)
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Meta rejected the connection')
  }
  res.redirect('/integrations?meta=connected')
})

integrationsRouter.delete('/meta', async (req, res) => {
  await meta.disconnect(req.user!.id)
  res.json(await statusFor(req.user!.id))
})

/* Each extension's connect routes mount under its id; success responses
   that should show the fresh status get it from the same statusFor. */
for (const extension of extensions) {
  if (extension.connectRouter) {
    integrationsRouter.use(
      `/${extension.id}`,
      extension.connectRouter({
        respondWithStatus: async (req, res) => {
          res.json(await statusFor(req.user!.id))
        },
      }),
    )
  }
}
