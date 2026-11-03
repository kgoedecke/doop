import { env } from './env.ts'
import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto'

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
 * Connect starts on GitHub's authorize screen, not the install screen
 * (`signFindState`): connections belong to one canvas, and for someone who
 * already installed the app the install screen is a settings page that never
 * returns. The code that comes back lists the user's installations; none
 * sends them on to install (`signInstallState`).
 *
 * Install handoff integrity: installation ids are small guessable integers,
 * so binding one to a canvas requires proof the round-trip actually happened
 * for THAT canvas and that GitHub's user can access the installation. The
 * setup callback verifies both and issues `issueInstallPass`, which the
 * client must echo to list repos or create a connection. HMAC over the auth
 * secret, 15-minute expiry.
 *
 * What a pass grants is what GITHUB'S USER may reach, not what the app may:
 * an organization installation's token lists every repo the org granted the
 * app, while a member of that org may be allowed into only some of them. So
 * the callback asks GitHub, with the user's own one-shot token, for the repos
 * the user can access through each installation (`userAccess`), keeps that
 * snapshot server-side under a nonce the pass carries, and both the repo
 * picker and the connect step read from the snapshot alone — the
 * installation token is never used to decide what a user may see or bind.
 */

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
  return fetch(env.GITHUB_API_URL + path, {
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
/** A pass names at most this many installations — the picker's fan-out stays bounded. */
const MAX_PASS_INSTALLATIONS = 10

/** Repos the installation grants — what the picker shows after install.
 *  Paginated: a 400-repo installation must not hide repos past page one
 *  (createConnection rejects anything absent from this list). */
export async function listInstallationRepos(installationId: string): Promise<InstallationRepo[]> {
  const token = await installationToken(installationId)
  const repos: InstallationRepo[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${env.GITHUB_API_URL}/installation/repositories?per_page=100&page=${page}`, {
      headers: ghHeaders(token),
    })
    if (!res.ok) throw new Error(`GitHub App repo listing error ${res.status}`)
    const body = (await res.json()) as { repositories: { full_name: string; private: boolean }[] }
    repos.push(...body.repositories.map((r) => ({ fullName: r.full_name, private: r.private })))
    if (body.repositories.length < 100) break
  }
  return repos
}

/** One installation and the repos GitHub's user may reach through it. */
export interface InstallationGrant {
  installationId: string
  repos: InstallationRepo[]
}

/** Every repo across a pass's grants (a personal account and an org can
 *  each hold one), first installation first, each repo listed once. */
export function listReposAcross(grants: InstallationGrant[]): InstallationRepo[] {
  const seen = new Set<string>()
  return grants
    .flatMap((g) => g.repos)
    .filter((r) => {
      const key = r.fullName.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** The installation among `grants` through which the user may reach `repo`,
 *  or undefined — app mode binds exactly what GitHub lets this user see. */
export function installationForRepo(grants: InstallationGrant[], repo: string): string | undefined {
  const wanted = repo.toLowerCase()
  return grants.find((g) => g.repos.some((r) => r.fullName.toLowerCase() === wanted))?.installationId
}

/** The OAuth code's user token, or undefined when GitHub would not identify
 *  the user. Used once and discarded. */
async function userToken(code: string): Promise<string | undefined> {
  if (!code) return undefined
  const res = await fetch(env.GITHUB_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'doop-import' },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
    }),
  })
  if (!res.ok) return undefined
  const { access_token } = (await res.json()) as { access_token?: string }
  return access_token || undefined
}

/** Pages of a GitHub list the user token may read, undefined on any refusal. */
async function userPages<T>(token: string, path: string, pick: (body: unknown) => T[]): Promise<T[] | undefined> {
  const items: T[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const r = await fetch(`${env.GITHUB_API_URL}${path}${sep}per_page=100&page=${page}`, { headers: ghHeaders(token) })
    if (!r.ok) return undefined
    const batch = pick(await r.json())
    items.push(...batch)
    if (batch.length < 100) break
  }
  return items
}

/** Installations of this app the user token can access. Installation ids
 *  are guessable integers, so this list is the only thing that may put an
 *  installation into a pass. */
async function installationIdsOf(token: string): Promise<string[] | undefined> {
  return userPages(token, '/user/installations', (body) =>
    (body as { installations: { id: number }[] }).installations.map((i) => String(i.id)),
  )
}

/** The repos the user token may reach through one installation — GitHub's
 *  user-scoped listing, which an org member sees narrowed to their own
 *  access, unlike the installation token's listing of everything the org
 *  granted the app. */
async function userReposIn(token: string, installationId: string): Promise<InstallationRepo[] | undefined> {
  return userPages(token, `/user/installations/${encodeURIComponent(installationId)}/repositories`, (body) =>
    (body as { repositories: { full_name: string; private: boolean }[] }).repositories.map((r) => ({
      fullName: r.full_name,
      private: r.private,
    })),
  )
}

/** Installations of this app the OAuth code's user can access, or undefined
 *  when GitHub would not identify the user. */
export async function userInstallationIds(code: string): Promise<string[] | undefined> {
  const token = await userToken(code)
  return token ? installationIdsOf(token) : undefined
}

/** What the OAuth code's user may reach: every installation of theirs (or
 *  only those in `only`, for a fresh install naming one), each with the
 *  repos GitHub lets THIS user see through it. An installation whose listing
 *  fails (removed since the installations were listed, a passing GitHub
 *  error) drops out so the others still open the picker; undefined when
 *  GitHub would not identify the user or no listing succeeded; empty when
 *  the user has no installation (or none of `only`). The callback's
 *  ownership proof — an installation the user cannot see never becomes a
 *  grant — and the only source of what a pass may list or bind. */
export async function userAccess(code: string, only?: string[]): Promise<InstallationGrant[] | undefined> {
  const token = await userToken(code)
  if (!token) return undefined
  const ids = await installationIdsOf(token)
  if (!ids) return undefined
  const chosen = (only ? ids.filter((id) => only.includes(id)) : ids).slice(0, MAX_PASS_INSTALLATIONS)
  const listed = await Promise.allSettled(chosen.map((id) => userReposIn(token, id)))
  const grants = chosen.flatMap((installationId, i) => {
    const r = listed[i]
    return r?.status === 'fulfilled' && r.value ? [{ installationId, repos: r.value }] : []
  })
  return chosen.length && !grants.length ? undefined : grants
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

/** The grants behind outstanding passes, by the nonce each pass carries.
 *  In memory, like the installation token cache: a restart turns an open
 *  picker into "handoff expired — connect again", which is the safe way
 *  round. Pruned whenever a pass is issued. */
const passGrants = new Map<string, { canvasId: string; grants: InstallationGrant[]; expiresAt: number }>()

/** Issued by the setup callback after GitHub redirects back; the client
 *  echoes it to list the grants' repos and bind one to the canvas. The pass
 *  itself carries only the canvas and a nonce — a grant can hold hundreds of
 *  repo names, which no query string should. */
export function issueInstallPass(canvasId: string, grants: InstallationGrant[], now = Date.now()): string {
  const kept = grants.slice(0, MAX_PASS_INSTALLATIONS)
  if (!kept.length || /[.]/.test(canvasId) || !kept.every((g) => /^\d+$/.test(g.installationId)))
    throw new Error('invalid id')
  for (const [nonce, entry] of passGrants) if (entry.expiresAt < now) passGrants.delete(nonce)
  const nonce = randomBytes(16).toString('base64url')
  const expiresAt = now + STATE_TTL_MS
  passGrants.set(nonce, { canvasId, grants: kept, expiresAt })
  return pack('gh-pass', [canvasId, nonce], expiresAt)
}

/** The grants a pass stands for, or undefined when it is forged, expired,
 *  for another canvas, or issued before the server last started. */
export function redeemInstallPass(pass: string, canvasId: string): InstallationGrant[] | undefined {
  const fields = unpack('gh-pass', pass, 2)
  if (!fields || fields[0] !== canvasId) return undefined
  const entry = passGrants.get(fields[1]!)
  if (!entry || entry.canvasId !== canvasId || entry.expiresAt < Date.now()) return undefined
  return entry.grants
}

/** Goes out with the authorize link "Connect GitHub" opens first: the code
 *  it brings back lists the installations the user already has, so a new
 *  canvas reaches the repo picker without visiting the install screen —
 *  which, for an installed app, is GitHub's settings page with no way back. */
export function signFindState(canvasId: string, userId: string, now = Date.now()): string {
  if (/[.]/.test(canvasId + userId)) throw new Error('invalid id')
  return pack('gh-find', [canvasId, userId], now + STATE_TTL_MS)
}

export function verifyFindState(state: string): { canvasId: string; userId: string } | undefined {
  const fields = unpack('gh-find', state, 2)
  return fields ? { canvasId: fields[0]!, userId: fields[1]! } : undefined
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

/** GitHub's authorize screen, returning to the setup callback — instant for
 *  a user who already authorized the app. Carries a find state or an
 *  already-installed bounce state. */
export function oauthBounceUrl(oauthState: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_APP_CLIENT_ID ?? '',
    redirect_uri: `${env.BETTER_AUTH_URL}/api/github/app/setup`,
    state: oauthState,
  })
  return `https://github.com/login/oauth/authorize?${params}`
}
