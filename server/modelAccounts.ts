import http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { modelAccounts } from './db/schema.ts'
import { CLAUDE_MODEL_IDS, normalizeClaudeModel } from '../shared/localAgent.ts'
import { isKnownModel, modelFor } from './openaiAgent.ts'

/**
 * "Bring your own model": a user connects their ChatGPT subscription (or an
 * OpenAI API key) so the Doop Agent keeps working once their free tasks are
 * spent. One row per user; the tokens live only here and are never sent to a
 * browser.
 *
 * The ChatGPT path uses the same OAuth clients the Codex CLI does, against
 * auth.openai.com, with inference through ChatGPT's Codex backend. OpenAI
 * registers no redirect URI for a hosted app, so the browser flow can only
 * redirect to a loopback URL — which gives three ways in, cheapest first:
 *
 *  - Doop and the browser on the same machine (local dev, self-host, desktop):
 *    we listen on 127.0.0.1:1455 ourselves and catch the redirect. Nothing to
 *    copy, and no account setting to turn on.
 *  - Doop hosted elsewhere: the device flow (`codex login --device-auth`),
 *    which has no redirect at all — the user types a short code at
 *    auth.openai.com and this process polls until they approve. Needs "device
 *    code authorization" enabled on their ChatGPT account.
 *  - Fallback when device codes are disallowed: the browser flow anyway, with
 *    the user pasting the dead loopback page's URL back to us.
 *
 * All three end at the same PKCE code exchange, server-side: we never see the
 * user's OpenAI password, and disconnecting deletes the row.
 *
 * Worth knowing before you ship this: driving a ChatGPT subscription from a
 * third-party server is not something OpenAI's terms sanction, and heavy use
 * can get an account rate-limited or suspended. The API-key path is the
 * boring, fully supported alternative and shares everything downstream.
 */

const ISSUER = process.env.CHATGPT_OAUTH_ISSUER || 'https://auth.openai.com'
/* the Codex CLI's public client; overridable if OpenAI ever issues our own */
const CLIENT_ID = process.env.CHATGPT_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann'
/* fixed by the client registration above — the browser will fail to load it,
   which is fine: the authorization code is in the URL by then */
const REDIRECT_URI = process.env.CHATGPT_OAUTH_REDIRECT_URI || 'http://localhost:1455/auth/callback'
/* auth.openai.com sits behind a bot filter that challenges a default Node
   fetch — an ordinary product User-Agent passes where no header at all does */
const AUTH_USER_AGENT = process.env.CHATGPT_AUTH_USER_AGENT || 'doop/0.1 (+https://doop.design)'

export type AccountKind = 'chatgpt' | 'openai-key' | 'anthropic-key'

const ACCOUNT_KINDS: readonly string[] = ['chatgpt', 'openai-key', 'anthropic-key'] satisfies AccountKind[]

export interface ModelAccount {
  userId: string
  kind: AccountKind
  accountId?: string
  email?: string
  plan?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  apiKey?: string
  /** model tier the user picked; unset = the server default */
  model?: string
  connectedAt: number
}

/** What the browser is allowed to know: never a token. */
export interface AccountStatus {
  connected: boolean
  kind?: AccountKind
  email?: string
  plan?: string
  /** the model tier in effect, resolved (never null in a status) */
  model?: string
  connectedAt?: number
}

export function chatgptConnectEnabled(): boolean {
  return process.env.CHATGPT_CONNECT_DISABLED !== '1'
}

/* ---------------------------------------------------------------- */
/* storage                                                          */
/* ---------------------------------------------------------------- */

function toAccount(row: typeof modelAccounts.$inferSelect): ModelAccount | null {
  if (!ACCOUNT_KINDS.includes(row.kind)) {
    /* a kind this build doesn't know (a rollback after an upgrade, say) —
       treating it as disconnected beats running it as the wrong provider */
    console.warn(`[doop-agent] ignoring model account with unknown kind "${row.kind}" for user ${row.userId}`)
    return null
  }
  return {
    userId: row.userId,
    kind: row.kind as AccountKind,
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...(row.plan ? { plan: row.plan } : {}),
    ...(row.accessToken ? { accessToken: row.accessToken } : {}),
    ...(row.refreshToken ? { refreshToken: row.refreshToken } : {}),
    ...(row.expiresAt != null ? { expiresAt: row.expiresAt } : {}),
    ...(row.apiKey ? { apiKey: row.apiKey } : {}),
    ...(row.model ? { model: row.model } : {}),
    connectedAt: row.connectedAt,
  }
}

export async function getAccount(userId: string): Promise<ModelAccount | null> {
  const [row] = await db.select().from(modelAccounts).where(eq(modelAccounts.userId, userId))
  return row ? toAccount(row) : null
}

export async function getStatus(userId: string): Promise<AccountStatus> {
  const account = await getAccount(userId)
  if (!account) return { connected: false }
  return {
    connected: true,
    kind: account.kind,
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {}),
    /* resolved, so the UI shows what will actually run rather than "default" */
    model: accountModelFor(account),
    connectedAt: account.connectedAt,
  }
}

export function accountModelFor(account: Pick<ModelAccount, 'kind' | 'model'>): string {
  return account.kind === 'anthropic-key' ? normalizeClaudeModel(account.model) : modelFor(account)
}

/** Change which model tier this account runs on. */
export async function setAccountModel(userId: string, model: string): Promise<AccountStatus> {
  const account = await getAccount(userId)
  if (!account) throw new Error('no model account connected')
  const known = account.kind === 'anthropic-key' ? CLAUDE_MODEL_IDS.some((id) => id === model) : isKnownModel(model)
  if (!known) throw new Error('unknown model')
  await save({ ...account, model })
  return getStatus(userId)
}

async function save(account: Omit<ModelAccount, 'connectedAt'>): Promise<void> {
  const now = Date.now()
  const row = {
    userId: account.userId,
    kind: account.kind,
    accountId: account.accountId ?? null,
    email: account.email ?? null,
    plan: account.plan ?? null,
    accessToken: account.accessToken ?? null,
    refreshToken: account.refreshToken ?? null,
    expiresAt: account.expiresAt ?? null,
    apiKey: account.apiKey ?? null,
    model: account.model ?? null,
    connectedAt: now,
    updatedAt: now,
  }
  await db
    .insert(modelAccounts)
    .values(row)
    .onConflictDoUpdate({
      target: modelAccounts.userId,
      set: {
        kind: row.kind,
        accountId: row.accountId,
        email: row.email,
        plan: row.plan,
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
        expiresAt: row.expiresAt,
        apiKey: row.apiKey,
        model: row.model,
        updatedAt: row.updatedAt,
      },
    })
}

export async function disconnect(userId: string): Promise<void> {
  await db.delete(modelAccounts).where(eq(modelAccounts.userId, userId))
}

/**
 * Write ONLY the refreshed token columns, and only if the row still exists.
 * A full upsert here would race the user: disconnecting mid-refresh would see
 * the row re-created, and changing the model mid-refresh would see it reverted
 * to whatever this refresh started with.
 */
async function saveRefreshedTokens(
  userId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number; accountId?: string; plan?: string },
): Promise<void> {
  await db
    .update(modelAccounts)
    .set({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
      ...(tokens.plan ? { plan: tokens.plan } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(modelAccounts.userId, userId))
}

/* ---------------------------------------------------------------- */
/* ChatGPT OAuth (PKCE)                                             */
/* ---------------------------------------------------------------- */

interface PendingAuth {
  userId: string
  verifier: string
  at: number
}

const pending = new Map<string, PendingAuth>()
const PENDING_TTL_MS = 15 * 60_000

function sweepPending() {
  const cutoff = Date.now() - PENDING_TTL_MS
  for (const [state, entry] of pending) if (entry.at < cutoff) pending.delete(state)
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Begin the flow: returns the OpenAI authorize URL to open in a new tab. */
export function beginChatgptAuth(userId: string): { url: string; state: string } {
  sweepPending()
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(24))
  pending.set(state, { userId, verifier, at: Date.now() })
  const url = new URL('/oauth/authorize', ISSUER)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', 'openid profile email offline_access')
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('state', state)
  return { url: url.toString(), state }
}

/** Accepts either the bare `code` or the whole failed-redirect URL pasted
 *  out of the browser's address bar. */
export function parseAuthCode(input: string): { code: string; state?: string } {
  const raw = input.trim()
  if (!raw) throw new Error('Paste the URL you were redirected to (or the code from it)')
  if (raw.includes('://') || raw.startsWith('localhost')) {
    let url: URL
    try {
      url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    } catch {
      throw new Error("That doesn't look like the redirect URL — copy the whole address bar")
    }
    const error = url.searchParams.get('error')
    if (error) throw new Error(`OpenAI refused the connection: ${url.searchParams.get('error_description') || error}`)
    const code = url.searchParams.get('code')
    if (!code) throw new Error('That URL has no ?code= in it — copy the address you were redirected to')
    return { code, ...(url.searchParams.get('state') ? { state: url.searchParams.get('state')! } : {}) }
  }
  return { code: raw }
}

function equalState(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(new URL('/oauth/token', ISSUER), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': AUTH_USER_AGENT,
    },
    body: new URLSearchParams(form).toString(),
  })
  const text = await res.text()
  let body: TokenResponse
  try {
    body = JSON.parse(text) as TokenResponse
  } catch {
    throw new Error(`OpenAI returned an unreadable token response (${res.status})`)
  }
  if (!res.ok || body.error) {
    /* OpenAI returns error/error_description as a string most of the time and
       as an object some of the time; either way the user needs words */
    throw new Error(describe(body.error_description) || describe(body.error) || `OpenAI rejected this (${res.status})`)
  }
  return body
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['message', 'error_description', 'error', 'detail']) {
      if (typeof record[key] === 'string') return record[key]
    }
    return JSON.stringify(value).slice(0, 200)
  }
  return ''
}

interface IdTokenClaims {
  email?: string
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
    chatgpt_plan_type?: string
  }
}

/** Read the id_token's payload. It arrived over TLS straight from the token
 *  endpoint, so this is a field read, not a trust decision — we never accept
 *  an id_token from anywhere else. */
function readIdToken(idToken: string | undefined): IdTokenClaims {
  if (!idToken) return {}
  const payload = idToken.split('.')[1]
  if (!payload) return {}
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdTokenClaims
  } catch {
    return {}
  }
}

/** Finish the flow: exchange the pasted code and store the account. */
export async function completeChatgptAuth(userId: string, pastedInput: string): Promise<AccountStatus> {
  sweepPending()
  const { code, state } = parseAuthCode(pastedInput)
  /* the verifier is looked up by the state we minted; without a state we fall
     back to this user's most recent pending attempt */
  let entry: PendingAuth | undefined
  let entryState: string | undefined
  if (state) {
    for (const [candidate, value] of pending) {
      if (equalState(candidate, state)) {
        entry = value
        entryState = candidate
        break
      }
    }
    if (entry && entry.userId !== userId) entry = undefined
  } else {
    for (const [candidate, value] of pending) {
      if (value.userId !== userId) continue
      if (!entry || value.at > entry.at) {
        entry = value
        entryState = candidate
      }
    }
  }
  if (!entry || !entryState) throw new Error('That sign-in expired — start the connection again')
  pending.delete(entryState)
  return exchangeAndSave(userId, code, entry.verifier)
}

/** Trade a PKCE authorization code for tokens and store the account. Shared by
 *  the browser flow and the device flow — only the way the code is obtained
 *  differs between them. */
async function exchangeAndSave(
  userId: string,
  code: string,
  verifier: string,
  redirectUri: string = REDIRECT_URI,
): Promise<AccountStatus> {
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  })
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('OpenAI did not return a usable token pair')
  const claims = readIdToken(tokens.id_token)
  const auth = claims['https://api.openai.com/auth'] ?? {}
  if (!auth.chatgpt_account_id) {
    throw new Error('That OpenAI account has no ChatGPT subscription attached — connect an API key instead')
  }
  await save({
    userId,
    kind: 'chatgpt',
    accountId: auth.chatgpt_account_id,
    ...(claims.email ? { email: claims.email } : {}),
    ...(auth.chatgpt_plan_type ? { plan: auth.chatgpt_plan_type } : {}),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  })
  return getStatus(userId)
}

/* ---------------------------------------------------------------- */
/* Device code: the flow that works when Doop is hosted elsewhere   */
/* ---------------------------------------------------------------- */

/**
 * OAuth device authorization, the same one `codex login --device-auth` uses.
 * No redirect URI is involved, so it works identically whether Doop runs on
 * the user's machine or on a server: we get a short code, they type it at
 * auth.openai.com, and this process polls until they approve.
 *
 * Requires "device code authorization" to be on in the user's ChatGPT
 * security settings (workspace members need an admin to allow it) — the one
 * bit of setup the loopback flow avoids, which is why that stays the default
 * when Doop and the browser share a machine.
 */

export const DEVICE_VERIFICATION_URL = process.env.CHATGPT_DEVICE_URL || `${ISSUER}/codex/device`
/* the device endpoints sit under /api/accounts, and the code they hand back was
   minted against this redirect — not the loopback one the browser flow uses */
const DEVICE_API = '/api/accounts'
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`
const DEVICE_TTL_MS = 15 * 60_000

export interface DeviceFlow {
  userCode: string
  verificationUrl: string
  /** 'pending' until the user approves; then 'connected', or 'error' */
  status: 'pending' | 'connected' | 'error'
  error?: string
}

interface DeviceState extends DeviceFlow {
  at: number
  cancelled?: boolean
}

const deviceFlows = new Map<string, DeviceState>()

function sweepDeviceFlows() {
  const cutoff = Date.now() - DEVICE_TTL_MS
  for (const [userId, flow] of deviceFlows) if (flow.at < cutoff) deviceFlows.delete(userId)
}

async function deviceRequest(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(new URL(`${DEVICE_API}${path}`, ISSUER), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': AUTH_USER_AGENT },
    body: JSON.stringify(body),
  })
}

/** Ask OpenAI for a one-time code and start polling for approval. */
export async function beginDeviceAuth(userId: string): Promise<DeviceFlow> {
  sweepDeviceFlows()
  cancelDeviceAuth(userId)
  const res = await deviceRequest('/deviceauth/usercode', { client_id: CLIENT_ID })
  const text = await res.text()
  if (!res.ok) {
    /* auth.openai.com answers a blocked request with a Cloudflare interstitial;
       saying "enable the setting" there would send people to the wrong place */
    if (text.includes('Just a moment') || text.includes('challenges.cloudflare.com')) {
      throw new Error('OpenAI blocked this server from starting a device sign-in. Use the browser sign-in instead.')
    }
    throw new Error(
      res.status === 403 || res.status === 401
        ? 'OpenAI refused to issue a device code. Turn on "device code authorization" in ChatGPT → Settings → Security (workspace members need an admin to allow it), then try again.'
        : `OpenAI could not start a device sign-in (${res.status}). ${describe(text) || ''}`.trim(),
    )
  }
  let parsed: { device_auth_id?: string; user_code?: string; usercode?: string; interval?: number }
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('OpenAI returned an unreadable device-code response')
  }
  const deviceAuthId = parsed.device_auth_id
  const userCode = parsed.user_code || parsed.usercode
  if (!deviceAuthId || !userCode) throw new Error('OpenAI did not return a device code')

  const flow: DeviceState = {
    userCode,
    verificationUrl: DEVICE_VERIFICATION_URL,
    status: 'pending',
    at: Date.now(),
  }
  deviceFlows.set(userId, flow)
  /* the poller is handed the flow object it owns, so a restart's poller can
     never write its outcome into the replacement flow */
  void pollDeviceAuth(userId, flow, deviceAuthId, userCode, Math.max(1, Number(parsed.interval) || 5) * 1000)
  return { userCode: flow.userCode, verificationUrl: flow.verificationUrl, status: 'pending' }
}

async function pollDeviceAuth(
  userId: string,
  own: DeviceState,
  deviceAuthId: string,
  userCode: string,
  intervalMs: number,
) {
  const deadline = Date.now() + DEVICE_TTL_MS
  /* this poller only ever owns the flow it was started for — if the user
     restarted, `own` is no longer the live entry and its result is stale */
  const live = () => (!own.cancelled && deviceFlows.get(userId) === own ? own : null)
  const fail = (message: string) => {
    const flow = live()
    if (flow) Object.assign(flow, { status: 'error', error: message })
  }
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    if (!live()) return
    let res: Response
    try {
      res = await deviceRequest('/deviceauth/token', { device_auth_id: deviceAuthId, user_code: userCode })
    } catch {
      continue // transient network trouble: keep waiting rather than giving up
    }
    /* not approved yet — OpenAI answers 403/404 until the user types the code */
    if (res.status === 403 || res.status === 404) continue
    if (!res.ok) {
      fail(`OpenAI rejected the device sign-in (${res.status})`)
      return
    }
    let granted: { authorization_code?: string; code_verifier?: string }
    try {
      granted = (await res.json()) as typeof granted
    } catch {
      fail('OpenAI returned an unreadable approval')
      return
    }
    if (!granted.authorization_code || !granted.code_verifier) {
      fail('OpenAI approved the sign-in but returned no authorization code')
      return
    }
    try {
      /* the device flow hands back a normal PKCE pair; the exchange and the
         account write are exactly the browser flow's */
      await exchangeAndSave(userId, granted.authorization_code, granted.code_verifier, DEVICE_REDIRECT_URI)
      const done = live()
      if (done) done.status = 'connected'
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Could not finish connecting that account')
    }
    return
  }
  fail('That code expired before it was approved — start again.')
}

/** Where a device sign-in has got to; the browser polls this. */
export function deviceAuthStatus(userId: string): DeviceFlow | null {
  sweepDeviceFlows()
  const flow = deviceFlows.get(userId)
  if (!flow) return null
  return {
    userCode: flow.userCode,
    verificationUrl: flow.verificationUrl,
    status: flow.status,
    ...(flow.error ? { error: flow.error } : {}),
  }
}

export function cancelDeviceAuth(userId: string) {
  const flow = deviceFlows.get(userId)
  if (flow) flow.cancelled = true
  deviceFlows.delete(userId)
}

/* ---------------------------------------------------------------- */
/* Loopback catcher: same-machine flows need no copying             */
/* ---------------------------------------------------------------- */

const CALLBACK_PORT = Number(process.env.CHATGPT_OAUTH_CALLBACK_PORT || 1455)
const CATCHER_TTL_MS = PENDING_TTL_MS

let catcher: http.Server | null = null
let catcherTimer: NodeJS.Timeout | null = null

/* the message can carry text OpenAI chose, so it is escaped, not trusted */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="margin:0;display:grid;place-items:center;height:100vh;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#faf9f7;color:#121217"><div style="max-width:26rem;padding:2rem;text-align:center"><h1 style="font-size:1.35rem;margin:0 0 .5rem">${escapeHtml(title)}</h1><p style="margin:0;color:#5b5b63">${escapeHtml(body)}</p></div>`
}

function stopCatcher() {
  if (catcherTimer) clearTimeout(catcherTimer)
  catcherTimer = null
  catcher?.close()
  catcher = null
}

/** Which user a pending state belongs to. */
function userIdForState(state: string): string | undefined {
  for (const [candidate, value] of pending) if (equalState(candidate, state)) return value.userId
  return undefined
}

/**
 * Listen on the loopback callback port for the duration of one connect flow,
 * so the browser's redirect completes the exchange by itself.
 *
 * Only ever bound to 127.0.0.1: the port is meaningful exactly when the
 * browser is on this machine, and binding it publicly would be an unauthenticated
 * endpoint that hands tokens to whoever reaches it first. Returns false when
 * the port is taken (a Codex login in flight, say) — the caller then falls back
 * to the paste flow rather than fighting over it.
 */
export function startCallbackCatcher(): Promise<boolean> {
  if (catcher) return Promise.resolve(true)
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${CALLBACK_PORT}`)
      const state = url.searchParams.get('state')
      const finish = (status: number, title: string, body: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(page(title, body))
      }
      if (!state || !url.searchParams.get('code')) {
        const error = url.searchParams.get('error')
        return finish(
          400,
          error ? 'Connection refused' : 'Nothing to do here',
          error
            ? `OpenAI reported: ${url.searchParams.get('error_description') || error}. You can close this tab and try again in Doop.`
            : 'This page only handles the ChatGPT sign-in redirect.',
        )
      }
      const userId = userIdForState(state)
      if (!userId) return finish(400, 'That sign-in expired', 'Start the connection again from Doop.')
      completeChatgptAuth(userId, url.toString()).then(
        () => {
          finish(200, 'ChatGPT connected', 'You can close this tab — Doop already knows. Back to designing.')
          /* one flow per listener: the code is spent and the port goes back */
          stopCatcher()
        },
        (err: unknown) => {
          finish(400, "That didn't work", err instanceof Error ? err.message : 'Try connecting again from Doop.')
        },
      )
    })
    server.on('error', () => resolve(false))
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      catcher = server
      catcherTimer = setTimeout(stopCatcher, CATCHER_TTL_MS)
      catcherTimer.unref?.()
      resolve(true)
    })
  })
}

export async function connectApiKey(userId: string, apiKey: string): Promise<AccountStatus> {
  const key = apiKey.trim()
  if (!key.startsWith('sk-')) throw new Error('That does not look like an OpenAI API key (they start with "sk-")')
  const previous = await getAccount(userId)
  await save({
    userId,
    kind: 'openai-key',
    apiKey: key,
    model: previous?.kind === 'openai-key' ? previous.model : undefined,
  })
  return getStatus(userId)
}

export async function connectAnthropicKey(userId: string, apiKey: string): Promise<AccountStatus> {
  const key = apiKey.trim()
  if (!key.startsWith('sk-ant-') || /\s/.test(key))
    throw new Error('That does not look like an Anthropic API key (they start with "sk-ant-")')
  const previous = await getAccount(userId)
  await save({
    userId,
    kind: 'anthropic-key',
    apiKey: key,
    model: previous?.kind === 'anthropic-key' ? previous.model : undefined,
  })
  return getStatus(userId)
}

/* refreshes are per-user serialized: two runs starting together must not both
   spend the single-use refresh token */
const refreshing = new Map<string, Promise<ModelAccount>>()
const REFRESH_MARGIN_MS = 120_000

/** A ChatGPT account with a live access token, refreshing it if it is close
 *  to expiry. Throws when the connection has gone stale for good — the caller
 *  surfaces that as "reconnect your ChatGPT account". */
export async function withFreshToken(account: ModelAccount): Promise<ModelAccount> {
  if (account.kind !== 'chatgpt') return account
  if (!account.refreshToken) throw new Error('ChatGPT connection is missing its refresh token — reconnect it')
  if ((account.expiresAt ?? 0) - REFRESH_MARGIN_MS > Date.now() && account.accessToken) return account
  const inFlight = refreshing.get(account.userId)
  if (inFlight) return inFlight
  const task = (async () => {
    const tokens = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: account.refreshToken!,
      scope: 'openid profile email',
    })
    if (!tokens.access_token) throw new Error('OpenAI did not return a refreshed access token')
    const claims = readIdToken(tokens.id_token)
    const auth = claims['https://api.openai.com/auth'] ?? {}
    const next: ModelAccount = {
      ...account,
      accessToken: tokens.access_token,
      /* rotation is optional — keep the current token when none comes back */
      refreshToken: tokens.refresh_token || account.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      ...(auth.chatgpt_account_id ? { accountId: auth.chatgpt_account_id } : {}),
      ...(auth.chatgpt_plan_type ? { plan: auth.chatgpt_plan_type } : {}),
    }
    await saveRefreshedTokens(account.userId, {
      accessToken: next.accessToken!,
      refreshToken: next.refreshToken!,
      expiresAt: next.expiresAt!,
      ...(auth.chatgpt_account_id ? { accountId: auth.chatgpt_account_id } : {}),
      ...(auth.chatgpt_plan_type ? { plan: auth.chatgpt_plan_type } : {}),
    })
    return next
  })().finally(() => refreshing.delete(account.userId))
  refreshing.set(account.userId, task)
  return task
}
