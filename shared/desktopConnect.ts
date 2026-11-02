/* Connecting an integration (Meta, Linear, Slack) from the
   desktop app. The shell hands every provider page to the system browser,
   so the provider's redirect lands there, carrying the browser's cookie,
   which may belong to another account or to nobody. The flow:

     1. The app starts the connection with `desktop: true`. The server marks
        the OAuth state in the authorize URL with DESKTOP_STATE_PREFIX, and
        the app opens that URL in the system browser.
     2. The provider redirects the browser to /api/integrations/<id>/callback.
        A marked state never reaches the browser session: the server relays
        the whole query to DESKTOP_CONNECT_PATH, a page that opens
        doop://integration/<id>?<query> without exchanging anything.
     3. The app receives the link and posts the query to
        /api/integrations/<id>/complete under its own session. The provider's
        usual check (the state belongs to this user) still decides, so a code
        from someone else's round trip connects nothing.

   Pure functions, shared by the server, the browser page and the app. */

export const DESKTOP_STATE_PREFIX = 'desktop~'
export const DESKTOP_CONNECT_PATH = '/desktop/connect'

/** The integrations that connect through an OAuth round trip. */
export const OAUTH_PROVIDERS = ['meta', 'linear', 'slack'] as const
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number]

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === 'string' && (OAUTH_PROVIDERS as readonly string[]).includes(value)
}

/** Mark the state of a provider's authorize URL as begun in the desktop app.
 *  Only the state parameter changes: re-serialising the whole query could
 *  re-encode a provider's scopes. */
export function markDesktopState(authorizeUrl: string): string {
  const marked = authorizeUrl.replace(/([?&]state=)/, `$1${DESKTOP_STATE_PREFIX}`)
  if (marked === authorizeUrl) throw new Error('the authorize URL carries no state')
  return marked
}

export function isDesktopState(state: unknown): state is string {
  return typeof state === 'string' && state.startsWith(DESKTOP_STATE_PREFIX)
}

/** The provider's own state, with the desktop mark removed if present. */
export function unmarkDesktopState(state: string): string {
  return isDesktopState(state) ? state.slice(DESKTOP_STATE_PREFIX.length) : state
}
