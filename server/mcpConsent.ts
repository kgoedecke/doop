import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'

/* better-auth's MCP plugin (1.6.26) puts the consent page in front of an
   authorization only when the client asks for it with `prompt=consent`. A
   client that leaves it out is sent a code for whoever is signed in, and
   dynamic client registration is open to anyone, so a stranger could register
   a client that redirects to their own server and have a Doop user's browser
   hand them an agent token by opening one link. These hooks make the consent
   page the rule:

   - /mcp/authorize asks for consent unless this person already approved this
     client for every scope it now asks for (an `oauth_consent` row, written by
     the consent endpoint when they press Connect);
   - /mcp/token refuses a code still waiting for that approval: the plugin
     stores the pending request under the very code the consent page shows,
     and its token endpoint never looks at `requireConsent`;
   - /oauth2/consent only approves a request for the person who made it: the
     endpoint takes any signed-in session with the code.

   Signed out, nobody is known yet, so the request is marked for consent before
   the plugin stores it for after sign-in (its `oidc_login_prompt` cookie). */

type Query = Record<string, unknown>

interface PendingAuthorization {
  userId?: string
  requireConsent?: boolean
}

const MCP_DEFAULT_SCOPE = ['openid']

/** The scopes the plugin will grant for this request, read the way it reads them. */
export function requestedScopes(query: Query): string[] {
  const scope = query.scope
  if (typeof scope !== 'string') return MCP_DEFAULT_SCOPE
  return scope.split(' ').filter(Boolean)
}

/** Whether the request already asks for the consent page, in any spelling the
 *  OIDC `prompt` list allows ("consent", "login consent"). */
function asksForConsent(query: Query): boolean {
  return typeof query.prompt === 'string' && query.prompt.split(' ').includes('consent')
}

/** Whether approvals on record cover every scope requested. */
export function consentCovers(approvedScopes: string[], requested: string[]): boolean {
  if (approvedScopes.length === 0) return false
  const approved = new Set(approvedScopes.flatMap((scopes) => scopes.split(' ')))
  return requested.every((scope) => approved.has(scope))
}

function parsePending(value: string): PendingAuthorization | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? (parsed as PendingAuthorization) : null
  } catch {
    return null
  }
}

function bodyField(body: unknown, field: string): string | undefined {
  const value = body instanceof FormData ? body.get(field) : (body as Record<string, unknown> | undefined)?.[field]
  return typeof value === 'string' ? value : undefined
}

export function mcpConsentGuard() {
  return {
    id: 'doop-mcp-consent',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/mcp/authorize',
          handler: createAuthMiddleware(async (ctx) => {
            const query = (ctx.query ?? {}) as Query
            if (asksForConsent(query)) return { context: { query: { ...query, prompt: 'consent' } } }
            const session = await getSessionFromCtx(ctx)
            const clientId = query.client_id
            if (session && typeof clientId === 'string') {
              const approvals = await ctx.context.adapter.findMany<{ scopes: string }>({
                model: 'oauthConsent',
                where: [
                  { field: 'userId', value: session.user.id },
                  { field: 'clientId', value: clientId },
                  { field: 'consentGiven', value: true },
                ],
              })
              const approved = approvals.map((row) => row.scopes)
              if (consentCovers(approved, requestedScopes(query))) return
            }
            return { context: { query: { ...query, prompt: 'consent' } } }
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/mcp/token',
          handler: createAuthMiddleware(async (ctx) => {
            if (bodyField(ctx.body, 'grant_type') !== 'authorization_code') return
            const code = bodyField(ctx.body, 'code')
            if (!code) return
            const stored = await ctx.context.internalAdapter.findVerificationValue(code)
            if (stored && parsePending(stored.value)?.requireConsent !== false)
              throw new APIError('UNAUTHORIZED', {
                error: 'invalid_grant',
                error_description: 'this authorization has not been approved',
              })
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/oauth2/consent',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx)
            if (!session) return // the endpoint's own session check answers
            const code =
              bodyField(ctx.body, 'consent_code') ??
              ((await ctx.getSignedCookie('oidc_consent_prompt', ctx.context.secret)) || undefined)
            if (!code) return
            const stored = await ctx.context.internalAdapter.findVerificationValue(code)
            const pending = stored && parsePending(stored.value)
            if (pending && pending.userId !== session.user.id)
              throw new APIError('UNAUTHORIZED', { error: 'invalid_request', error_description: 'Invalid code' })
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
