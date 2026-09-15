/* The desktop shell cannot finish a Google / Microsoft / SSO sign-in itself:
   identity providers refuse embedded webviews, so the provider round trip
   runs in the system browser and the resulting session is handed back to
   the app over a doop:// deep link. This module holds the URL shapes both
   ends agree on; the flow is:

     1. AuthPage (in the shell) mints a random challenge, remembers it as
        the pending sign-in, and opens desktopSignInURL(...) in the system
        browser. That page (DesktopSignIn.tsx) starts the provider sign-in
        from inside the browser, with desktopHandoffURL(...) as its
        callbackURL. It has to start there: better-auth pins the OAuth
        state to a cookie on the browser that began the flow, so beginning
        it in the webview and finishing in the browser fails the state
        check. A browser that is already signed in skips the provider and
        goes straight to step 2.
     2. The browser comes back to /desktop/handoff signed in; that page
        (DesktopHandoff.tsx) mints a one-time token from its session and
        opens desktopAuthDeepLink(token, challenge, target).
     3. The shell's deep-link plugin delivers the URL to the page, which
        parses it (parseDesktopAuthDeepLink) and redeems the token only if
        the challenge matches its pending sign-in — the server sets the
        session cookie in the webview — then lands on `target`.

   The challenge is what stops an unsolicited doop://auth link (minted from
   someone else's browser session) from signing this app into a foreign
   account: without a matching pending sign-in the link is ignored. It also
   makes the link that launched the app safe to consume once — after the
   redeem clears the pending sign-in, the plugin's remembered launch URL no
   longer matches anything and is ignored on every later page load.

   Pure functions and one localStorage record, so tests and all three pages
   can use it freely. */

import { safeRelativeTarget } from './safeTarget'

export const DESKTOP_SIGNIN_PATH = '/desktop/signin'
export const DESKTOP_HANDOFF_PATH = '/desktop/handoff'

/** better-auth's social providers, plus 'oidc' for the genericOAuth SSO plugin. */
export type DesktopSignInProvider = 'google' | 'microsoft' | 'oidc'
const PROVIDERS: readonly DesktopSignInProvider[] = ['google', 'microsoft', 'oidc']

/** What the app asked the browser to do, carried through every hop. */
export interface DesktopSignInRequest {
  provider: DesktopSignInProvider
  /** random per-attempt value the app compares against its pending sign-in */
  challenge: string
  /** same-origin path to land on in the app once signed in */
  to: string
}

/** 128 random bits, URL-safe. */
export function newChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const CHALLENGE_PATTERN = /^[0-9a-f]{32}$/

/** The browser-side page that begins a provider sign-in for the desktop app. */
export function desktopSignInURL(origin: string, request: DesktopSignInRequest): string {
  const params = new URLSearchParams({ provider: request.provider, challenge: request.challenge, to: request.to })
  return `${origin}${DESKTOP_SIGNIN_PATH}?${params}`
}

/** Null unless the query names a known provider and carries a challenge. */
export function parseDesktopSignInQuery(search: string): DesktopSignInRequest | null {
  const params = new URLSearchParams(search)
  const provider = PROVIDERS.find((p) => p === params.get('provider'))
  const challenge = params.get('challenge')
  if (!provider || !challenge || !CHALLENGE_PATTERN.test(challenge)) return null
  return { provider, challenge, to: safeRelativeTarget(params.get('to')) ?? '/' }
}

/** Registered by the shell (desktop/src-tauri/tauri.conf.json, plugins.deep-link). */
export const DESKTOP_SCHEME = 'doop'

export interface DesktopAuthLink {
  token: string
  challenge: string
  /** same-origin path to land on once signed in */
  to: string
}

/** Where the browser-side sign-in should return to: the handoff page,
 *  carrying the challenge and the in-app path the person was headed for. */
export function desktopHandoffURL(challenge: string, to: string): string {
  const params = new URLSearchParams({ challenge, to })
  return `${DESKTOP_HANDOFF_PATH}?${params}`
}

/** The handoff page's view of its own query; null without a challenge. */
export function parseDesktopHandoffQuery(search: string): { challenge: string; to: string } | null {
  const params = new URLSearchParams(search)
  const challenge = params.get('challenge')
  if (!challenge || !CHALLENGE_PATTERN.test(challenge)) return null
  return { challenge, to: safeRelativeTarget(params.get('to')) ?? '/' }
}

export function desktopAuthDeepLink(token: string, challenge: string, to: string): string {
  const params = new URLSearchParams({ token, challenge, to })
  return `${DESKTOP_SCHEME}://auth?${params}`
}

/** Null for anything that is not a well-formed sign-in deep link. The
 *  `to` path is re-checked here — the link came from outside the app. */
export function parseDesktopAuthDeepLink(url: string): DesktopAuthLink | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${DESKTOP_SCHEME}:` || parsed.host !== 'auth') return null
  const token = parsed.searchParams.get('token')
  const challenge = parsed.searchParams.get('challenge')
  if (!token || !challenge) return null
  return { token, challenge, to: safeRelativeTarget(parsed.searchParams.get('to')) ?? '/' }
}

/* ---------- the app's pending sign-in ---------- */

/** localStorage rather than sessionStorage or memory: it has to outlive the
 *  reload that follows a redeem (so the replayed launch URL is recognised
 *  as spent) and a relaunch of the app (so a link that arrives cold — the
 *  app was quit while the browser was busy — still redeems). */
const PENDING_KEY = 'doop-desktop-signin'

/** The browser side has this long to come back; the one-time token itself
 *  lives 2 minutes (server/auth.ts), this only bounds how long we listen. */
export const PENDING_TTL_MS = 10 * 60 * 1000

interface PendingSignIn {
  challenge: string
  startedAt: number
}

/** False when storage is blocked: the returning link could never be
 *  recognised, so the caller must not send the browser off at all. */
export function rememberPendingSignIn(challenge: string, now = Date.now()): boolean {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ challenge, startedAt: now } satisfies PendingSignIn))
    return true
  } catch {
    return false
  }
}

export function forgetPendingSignIn() {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    /* nothing to forget */
  }
}

/** Whether `challenge` is the sign-in this app is currently waiting for. */
export function isPendingSignIn(challenge: string, now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return false
    const pending: unknown = JSON.parse(raw)
    if (typeof pending !== 'object' || pending === null) return false
    const { challenge: expected, startedAt } = pending as Partial<PendingSignIn>
    return expected === challenge && typeof startedAt === 'number' && now - startedAt <= PENDING_TTL_MS
  } catch {
    return false
  }
}
