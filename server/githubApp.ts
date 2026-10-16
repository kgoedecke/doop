import { env } from './env.ts'
import { createHmac, createSign, timingSafeEqual } from 'node:crypto'

/**
 * GitHub App plumbing for the repo import source: the click-to-install flow
 * that replaces pasting a PAT. The app (registered once, credentials in env)
 * authenticates as itself with a short-lived RS256 JWT and mints per-call
 * installation tokens — nothing durable is ever stored per connection, and
 * users revoke from GitHub's own installation settings.
 *
 * Enabled by five env vars; when any is absent every helper reports the
 * app as off and the UI falls back to the PAT form:
 *   GITHUB_APP_ID             numeric app id
 *   GITHUB_APP_SLUG           the app's URL slug (github.com/apps/<slug>)
 *   GITHUB_APP_PRIVATE_KEY    PKCS#1/PKCS#8 PEM, raw or base64-encoded
 *   GITHUB_APP_CLIENT_ID/_SECRET  OAuth creds — the app must have
 *     "request user authorization during installation" on, because the
 *     OAuth code is how the setup callback proves who installed (below)
 * plus BETTER_AUTH_SECRET: the handoff signatures must never fall back to
 * the public dev secret while real installations are bindable.
 *
 * Install handoff integrity: installation ids are small guessable integers,
 * so binding one to a canvas requires proof the install round-trip actually
 * happened for THAT canvas. `signInstallState` goes out with the install
 * link; the setup callback verifies it and issues `signInstallPass`
 * (canvas + installation), which the client must echo to list repos or
 * create a connection. HMAC over the auth secret, 15-minute expiry.
 */

const GH_API = 'https://api.github.com'

function privateKey(): string | undefined {
  const raw = env.GITHUB_APP_PRIVATE_KEY
  if (!raw) return undefined
  if (raw.includes('BEGIN')) return raw
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    return decoded.includes('BEGIN') ? decoded : undefined
  } catch {
    return undefined
  }
}

export function appEnabled(): boolean {
  return !!(
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_SLUG &&
    env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET &&
    privateKey()
  )
}

export function appSlug(): string {
  return env.GITHUB_APP_SLUG ?? ''
}

/* ------------------------------------------------------------------ */
/* App JWT + installation tokens                                       */

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** Compact RS256 JWT authenticating as the app itself — no jose dependency,
 *  node:crypto signs it. Backdated 30s against clock skew, 8 min lifetime
 *  (GitHub caps at 10). */
export function appJwt(now = Date.now()): string {
  const key = privateKey()
  if (!key) throw new Error('GitHub App is not configured')
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const iat = Math.floor(now / 1000) - 30
  const payload = b64url(JSON.stringify({ iat, exp: iat + 8 * 60, iss: env.GITHUB_APP_ID }))
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key)
  return `${header}.${payload}.${b64url(signature)}`
}

async function appFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(GH_API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${appJwt()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'doop-import',
      ...init.headers,
    },
  })
}

/** Installation tokens last an hour; cache until shortly before expiry so a
 *  40-screen import doesn't mint 40 of them. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

export async function installationToken(installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId)
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token
  const res = await appFetch(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
  })
  if (res.status === 404) throw new Error('the GitHub App installation no longer exists — reconnect the repository')
  if (!res.ok) throw new Error(`GitHub App token error ${res.status}`)
  const body = (await res.json()) as { token: string; expires_at: string }
  tokenCache.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) })
  return body.token
}

export interface InstallationRepo {
  fullName: string
  private: boolean
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'doop-import',
  }
}

const MAX_PAGES = 5 // 500 repos/installations — beyond that, narrow the install

/** Repos the installation grants — what the picker shows after install.
 *  Paginated: a 400-repo installation must not hide repos past page one
 *  (createConnection rejects anything absent from this list). */
export async function listInstallationRepos(installationId: string): Promise<InstallationRepo[]> {
  const token = await installationToken(installationId)
  const repos: InstallationRepo[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${GH_API}/installation/repositories?per_page=100&page=${page}`, {
      headers: ghHeaders(token),
    })
    if (!res.ok) throw new Error(`GitHub App repo listing error ${res.status}`)
    const body = (await res.json()) as { repositories: { full_name: string; private: boolean }[] }
    repos.push(...body.repositories.map((r) => ({ fullName: r.full_name, private: r.private })))
    if (body.repositories.length < 100) break
  }
  return repos
}

/** The setup callback's ownership proof: the app requests user authorization
 *  during install, so GitHub appends an OAuth code identifying WHO completed
 *  it. Exchange it and require that user to actually have this installation —
 *  without this, any valid state could bind a guessed installation id from a
 *  different account and read its private repo list. The user token is used
 *  once and discarded. */
export async function verifyInstallationOwner(code: string, installationId: string): Promise<boolean> {
  if (!code) return false
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'doop-import' },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
    }),
  })
  if (!res.ok) return false
  const { access_token } = (await res.json()) as { access_token?: string }
  if (!access_token) return false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(`${GH_API}/user/installations?per_page=100&page=${page}`, {
      headers: ghHeaders(access_token),
    })
    if (!r.ok) return false
    const body = (await r.json()) as { installations: { id: number }[] }
    if (body.installations.some((i) => String(i.id) === installationId)) return true
    if (body.installations.length < 100) break
  }
  return false
}

/* ------------------------------------------------------------------ */
/* Signed install handoff                                              */

const STATE_TTL_MS = 15 * 60_000

function secret(): string {
  return env.BETTER_AUTH_SECRET
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

function pack(kind: string, fields: string[], exp: number): string {
  const payload = [kind, ...fields, String(exp)].join('.')
  return `${payload}.${sign(payload)}`
}

function unpack(kind: string, value: string, fieldCount: number): string[] | undefined {
  const parts = value.split('.')
  if (parts.length !== fieldCount + 3 || parts[0] !== kind) return undefined
  const mac = parts.pop()!
  const payload = parts.join('.')
  const expected = sign(payload)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  if (Number(parts[parts.length - 1]) < Date.now()) return undefined
  return parts.slice(1, -1)
}

/** Goes out with the install link as `state`; proves the round-trip began
 *  on this canvas. Dots would collide with the separator, but canvas ids
 *  and user ids are nanoid/uuid-shaped — reject anything else. */
export function signInstallState(canvasId: string, userId: string, now = Date.now()): string {
  if (/[.]/.test(canvasId + userId)) throw new Error('invalid id')
  return pack('gh-state', [canvasId, userId], now + STATE_TTL_MS)
}

export function verifyInstallState(state: string): { canvasId: string; userId: string } | undefined {
  const fields = unpack('gh-state', state, 2)
  return fields ? { canvasId: fields[0]!, userId: fields[1]! } : undefined
}

/** Issued by the setup callback after GitHub redirects back; the client
 *  echoes it to list the installation's repos and bind one to the canvas. */
export function signInstallPass(canvasId: string, installationId: string, now = Date.now()): string {
  if (/[.]/.test(canvasId + installationId)) throw new Error('invalid id')
  return pack('gh-pass', [canvasId, installationId], now + STATE_TTL_MS)
}

export function verifyInstallPass(pass: string, canvasId: string): { installationId: string } | undefined {
  const fields = unpack('gh-pass', pass, 2)
  if (!fields || fields[0] !== canvasId) return undefined
  return { installationId: fields[1]! }
}

export function installUrl(state: string): string {
  return `https://github.com/apps/${appSlug()}/installations/new?state=${encodeURIComponent(state)}`
}

/* ------------------------------------------------------------------ */
/* Already-installed bounce                                            */

/** When the app is ALREADY installed on the chosen GitHub account, the
 *  install screen becomes a configure screen and GitHub redirects back
 *  WITHOUT an OAuth code — leaving the ownership check nothing to verify.
 *  This second signed token carries the canvas + installation through an
 *  explicit OAuth authorize round-trip that exists purely to produce that
 *  code; the callback then verifies ownership exactly like a fresh install. */
export function signOauthState(canvasId: string, installationId: string, now = Date.now()): string {
  if (/[.]/.test(canvasId + installationId)) throw new Error('invalid id')
  return pack('gh-oauth', [canvasId, installationId], now + STATE_TTL_MS)
}

export function verifyOauthState(state: string): { canvasId: string; installationId: string } | undefined {
  const fields = unpack('gh-oauth', state, 2)
  return fields ? { canvasId: fields[0]!, installationId: fields[1]! } : undefined
}

export function oauthBounceUrl(oauthState: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_APP_CLIENT_ID ?? '',
    redirect_uri: `${env.BETTER_AUTH_URL}/api/github/app/setup`,
    state: oauthState,
  })
  return `https://github.com/login/oauth/authorize?${params}`
}
