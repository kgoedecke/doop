/* The app's half of connecting an integration from the desktop shell (the
   flow is described in shared/desktopConnect.ts): the doop:// link the
   browser hands back, and the pending connections the app waits for.

   The pending record is what makes an unsolicited doop://integration link
   harmless and the replayed launch link spent: without a matching pending
   connection for that provider the link is ignored. The server's own check
   (the OAuth state belongs to the signed-in user) is the real guard; this
   only keeps the app from acting on links it never asked for.

   Pure functions and one localStorage record, so tests and both pages can
   use it freely. */

import { DESKTOP_SCHEME } from './desktopAuth'

/** Provider ids are URL segments the server owns; anything else is refused
 *  before it is put in a link or a request path. */
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export interface DesktopConnectLink {
  provider: string
  /** the provider's redirect query, state still marked */
  query: Record<string, string>
}

export function desktopConnectLink(provider: string, query: Record<string, string>): string {
  return `${DESKTOP_SCHEME}://integration/${provider}?${new URLSearchParams(query)}`
}

/** The relay page's view of its own query: the provider, and everything the
 *  provider sent back. Null without a provider. */
export function parseDesktopConnectQuery(search: string): DesktopConnectLink | null {
  const params = new URLSearchParams(search)
  const provider = params.get('provider')
  if (!provider || !PROVIDER_PATTERN.test(provider)) return null
  params.delete('provider')
  return { provider, query: Object.fromEntries(params) }
}

/** Null for anything that is not a well-formed doop://integration link. */
export function parseDesktopConnectLink(url: string): DesktopConnectLink | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${DESKTOP_SCHEME}:` || parsed.host !== 'integration') return null
  const provider = parsed.pathname.replace(/^\//, '')
  if (!PROVIDER_PATTERN.test(provider)) return null
  return { provider, query: Object.fromEntries(parsed.searchParams) }
}

/* ---------- the app's pending connection ---------- */

const PENDING_KEY = 'doop-desktop-connect'

/** How long the app listens for the browser to come back. Provider states
 *  expire after ten minutes too, so a later link could not finish anyway. */
export const PENDING_CONNECT_TTL_MS = 10 * 60 * 1000

/** When each provider's connection was started, by provider id: one entry
 *  per provider, so starting Meta while Slack is still in the browser
 *  leaves Slack's way back open. */
type PendingConnects = Record<string, number>

function readPending(): PendingConnects {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    )
  } catch {
    return {}
  }
}

/** False when storage is blocked: the returning link could never be
 *  recognised, so the caller must not send the browser off. Entries past
 *  their window are dropped on the way. */
export function rememberPendingConnect(provider: string, now = Date.now()): boolean {
  const live = Object.entries(readPending()).filter(([, startedAt]) => now - startedAt <= PENDING_CONNECT_TTL_MS)
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ ...Object.fromEntries(live), [provider]: now }))
    return true
  } catch {
    return false
  }
}

export function forgetPendingConnect(provider: string) {
  const { [provider]: _forgotten, ...rest } = readPending()
  try {
    if (Object.keys(rest).length) localStorage.setItem(PENDING_KEY, JSON.stringify(rest))
    else localStorage.removeItem(PENDING_KEY)
  } catch {
    /* nothing to forget */
  }
}

/** Whether the app is currently waiting for `provider` to come back. */
export function isPendingConnect(provider: string, now = Date.now()): boolean {
  const startedAt = readPending()[provider]
  return startedAt !== undefined && now - startedAt <= PENDING_CONNECT_TTL_MS
}
