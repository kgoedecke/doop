import express from 'express'
import * as meta from './meta.ts'
import { extensions, OAuthStartError, type OAuthCallbackQuery, type OAuthConnect } from './extensions.ts'
import { DESKTOP_CONNECT_PATH, isDesktopState, markDesktopState, unmarkDesktopState } from '../shared/desktopConnect.ts'

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

/* Meta's round trip. The state proves it began here for THIS user — a code
   pasted from someone else's browser binds nothing. */
const metaOAuth: OAuthConnect = {
  start: async (userId) => {
    if (!meta.metaEnabled()) throw new OAuthStartError('the Meta app is not configured on this server')
    return meta.authorizeUrl(meta.signState(userId))
  },
  finish: async (userId, query) => {
    const fail = (reason: string) => `/integrations?metaError=${encodeURIComponent(reason)}`
    const state = meta.verifyState(query.state ?? '')
    if (!state || state.userId !== userId) return fail('the Meta handoff expired — try connecting again')
    if (!query.code) return fail(query.error_description ?? query.error ?? 'Meta sent no code back')
    try {
      await meta.connect(userId, query.code)
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Meta rejected the connection')
    }
    return '/integrations?meta=connected'
  },
}

integrationsRouter.delete('/meta', async (req, res) => {
  await meta.disconnect(req.user!.id)
  res.json(await statusFor(req.user!.id))
})

/** Every OAuth integration by its URL segment: Meta, plus each extension
 *  that brings one. */
const oauthConnections = new Map<string, OAuthConnect>([
  ['meta', metaOAuth],
  ...extensions.flatMap((e): [string, OAuthConnect][] => (e.oauth ? [[e.id, e.oauth]] : [])),
])

/** String values only: a repeated or nested parameter is not something any
 *  provider sends, so it is dropped rather than guessed at. */
function callbackQuery(query: unknown): OAuthCallbackQuery {
  if (typeof query !== 'object' || query === null) return {}
  return Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function startErrorStatus(error: unknown): number | undefined {
  if (error instanceof OAuthStartError) return error.status
  const status = (error as { status?: unknown } | null)?.status
  return error instanceof Error && typeof status === 'number' ? status : undefined
}

/** A provider's finish never leaves the person on a bare error page: an
 *  unexpected failure lands on Integrations with a reason, like any other. */
async function finishOrExplain(id: string, oauth: OAuthConnect, userId: string, query: OAuthCallbackQuery) {
  try {
    return await oauth.finish(userId, query)
  } catch (error) {
    console.error(`[integrations] ${id} connect failed`, error)
    return `/integrations?${id}Error=${encodeURIComponent('Could not finish connecting. Try again.')}`
  }
}

for (const [id, oauth] of oauthConnections) {
  /* `desktop: true` marks the state so the provider's redirect is relayed
     back to the app instead of finishing in the browser */
  integrationsRouter.post(`/${id}/start`, async (req, res, next) => {
    try {
      const url = await oauth.start(req.user!.id)
      res.json({ url: req.body?.desktop === true ? markDesktopState(url) : url })
    } catch (error) {
      const status = startErrorStatus(error)
      if (status === undefined) return next(error)
      res.status(status).json({ error: (error as Error).message })
    }
  })

  integrationsRouter.get(`/${id}/callback`, async (req, res) => {
    res.redirect(await finishOrExplain(id, oauth, req.user!.id, callbackQuery(req.query)))
  })

  /* the desktop app finishing a round trip the system browser relayed to it */
  integrationsRouter.post(`/${id}/complete`, async (req, res) => {
    const query = callbackQuery(req.body?.query)
    if (query.state) query.state = unmarkDesktopState(query.state)
    res.set('Cache-Control', 'no-store')
    res.json({ to: await finishOrExplain(id, oauth, req.user!.id, query) })
  })
}

/**
 * Mounted ahead of the session gate: a provider redirect whose state was
 * begun in the desktop app goes back to the app untouched (step 2 in
 * shared/desktopConnect.ts). The browser's own session, if any, plays no
 * part — it may well be another account. Anything else falls through to
 * the gated callback above.
 */
export function relayDesktopCallback(req: express.Request, res: express.Response, next: express.NextFunction) {
  const provider = req.params.provider ?? ''
  if (!oauthConnections.has(provider) || !isDesktopState(req.query.state)) return next()
  const params = new URLSearchParams({ ...callbackQuery(req.query), provider })
  res.set('Cache-Control', 'no-store')
  res.redirect(`${DESKTOP_CONNECT_PATH}?${params}`)
}

/* Each extension's other connect routes mount under its id; success
   responses that should show the fresh status get it from statusFor. */
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
