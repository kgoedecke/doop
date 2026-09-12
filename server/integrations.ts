import express from 'express'
import * as meta from './meta.ts'

/**
 * The Integrations page's surface, mounted at /api/integrations (behind the
 * session gate). Connections are per user — an integration is a thing you
 * hold, and automations you own draw on it. Meta is the only provider today;
 * the shape leaves room for more without a second routing scheme.
 */
export const integrationsRouter = express.Router()

export interface IntegrationsStatus {
  meta: meta.MetaConnectionInfo & { enabled: boolean }
}

integrationsRouter.get('/', async (req, res) => {
  const row = await meta.getConnection(req.user!.id)
  const status: IntegrationsStatus = { meta: { enabled: meta.metaEnabled(), ...meta.connectionInfo(row) } }
  res.json(status)
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
  res.json({ meta: { enabled: meta.metaEnabled(), connected: false } })
})
