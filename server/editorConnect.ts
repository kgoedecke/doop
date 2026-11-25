import { randomBytes } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import { serializeSignedCookie } from 'better-call'
import { and, eq, gt } from 'drizzle-orm'
import { auth, isBanned } from './auth.ts'
import * as agentKeys from './agentKeys.ts'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import {
  EDITOR_EMBED_PATH,
  EDITOR_EMBED_TICKET_PATH,
  EDITOR_EXCHANGE_PATH,
  EDITOR_SIGN_OUT_PATH,
  EDITOR_WHOAMI_PATH,
  editorCallbackURL,
  editorRedirect,
  embedTarget,
  type EditorConnectRequest,
} from '../shared/editorConnect.ts'

/* The server half of the editor extension (shared/editorConnect.ts):

   - POST /api/editor/connect (signed in): a two-minute exchange code for the
     editor that sent the person here; answers the deep link to follow.
   - POST /editor/exchange: the extension trades the code, once, for an agent
     key named after the editor. The key is minted here, not at approval, so a
     sign-in nobody finishes leaves no key behind.
   - POST /editor/whoami, /editor/sign-out (Bearer agent key): whose key it is;
     signing out deletes the key, and with it the canvas views it signed in.
   - POST /editor/embed-ticket (Bearer agent key): a one-minute, single-use
     ticket for the canvas view inside the editor.
   - GET /editor/embed?ticket&to: loaded as that view's iframe. Signs the
     iframe in and lands on `to`.

   Why the embed needs its own sign-in: the editor shows the canvas in an
   iframe inside a webview, whose top frame is `vscode-webview://…`. To the
   browser engine the Doop origin there is a third party, so the ordinary
   SameSite=Lax session cookie is never sent, and the canvas would load signed
   out. The embed sets the session cookie again as SameSite=None, Secure and
   Partitioned (CHIPS): it lives in a cookie jar keyed by that webview's top
   frame, so it signs in that one view and nothing on the open web can send it.
   It is only set for an iframe (Sec-Fetch-Dest), so a ticket link opened as a
   page cannot sign a browser into someone else's account. Every view of one
   key shares one session, marked with the key (agentKeys.embedSessionAgent),
   which deleting the key ends.

   Codes and tickets live in memory: the process that minted one redeems it a
   moment later, and a restart in between costs one retry. */

const CODE_TTL_MS = 2 * 60_000
const TICKET_TTL_MS = 60_000
const MAX_PENDING = 10_000

interface Code {
  userId: string
  expires: number
  /** the key's name: the editor it is for */
  name: string
}

interface Ticket {
  userId: string
  keyId: string
  expires: number
}

const codes = new Map<string, Code>()
const tickets = new Map<string, Ticket>()

/** Keeps `value` under a fresh random id (the CLI's sign-in codes are kept the same way,
 *  server/cliConnect.ts). Every entry of a map lives as long, so
 *  insertion order is expiry order: the expired ones are dropped from the front. */
export function rememberPending<T extends { expires: number }>(map: Map<string, T>, value: T): string {
  const now = Date.now()
  for (const [id, entry] of map) {
    if (entry.expires > now && map.size < MAX_PENDING) break
    map.delete(id)
  }
  const id = randomBytes(24).toString('base64url')
  map.set(id, value)
  return id
}

export function takePending<T extends { expires: number }>(map: Map<string, T>, id: unknown): T | null {
  if (typeof id !== 'string') return null
  const entry = map.get(id)
  map.delete(id)
  return entry && entry.expires > Date.now() ? entry : null
}

function bearer(req: Request): string {
  const header = req.get('authorization') ?? ''
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
}

export async function accountOf(userId: string) {
  const [row] = await db
    .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, userId))
  return row ?? null
}

/** The end of a sign-in that was approved in the browser (an editor's, the CLI's): mints an
 *  agent key named `name` for the account and answers it with whose it is. Minted here, not
 *  at approval, so a sign-in nobody finishes leaves no key behind. */
export async function answerWithKey(res: Response, userId: string, name: string): Promise<void> {
  if (await isBanned(userId)) return void res.status(403).json({ error: 'account suspended' })
  const user = await accountOf(userId)
  if (!user) return void res.status(400).json({ error: 'account not found' })
  const created = await agentKeys.createAgentKey(userId, name)
  if (!created) return void res.status(409).json({ error: 'too many agent keys — remove one in Settings → Connect AI' })
  res.json({ key: created.secret, user: { name: user.name, email: user.email } })
}

/** Signing out of a sign-in like that: deletes the key the request carries. A key can only
 *  delete itself here, so holding it is the permission. */
export async function deleteOwnKey(req: Request, res: Response): Promise<void> {
  const key = await agentKeys.verifyAgentKey(bearer(req))
  if (key) await agentKeys.deleteAgentKey(key.userId, key.keyId)
  res.status(204).end()
}

/** The key a request carries and its account, or null after answering it. */
async function keyHolder(req: Request, res: Response) {
  const key = await agentKeys.verifyAgentKey(bearer(req))
  if (!key) {
    res.status(401).json({ error: 'unauthorized' })
    return null
  }
  if (await isBanned(key.userId)) {
    res.status(403).json({ error: 'account suspended' })
    return null
  }
  const user = await accountOf(key.userId)
  if (!user) {
    res.status(401).json({ error: 'unauthorized' })
    return null
  }
  return { ...key, user: { name: user.name, email: user.email } }
}

/** The signed session cookie for the canvas views of one key, set for a partitioned,
 *  cross-site iframe. The key's live session is reused, so views do not pile sessions up. */
async function embedSessionCookie(userId: string, keyId: string): Promise<string> {
  const ctx = await auth.$context
  const userAgent = agentKeys.embedSessionAgent(keyId)
  const [live] = await db
    .select({ token: authSchema.session.token, expiresAt: authSchema.session.expiresAt })
    .from(authSchema.session)
    .where(
      and(
        eq(authSchema.session.userId, userId),
        eq(authSchema.session.userAgent, userAgent),
        gt(authSchema.session.expiresAt, new Date(Date.now() + 60 * 60_000)),
      ),
    )
  const session = live ?? (await ctx.internalAdapter.createSession(userId, false, { userAgent, ipAddress: null }))
  const maxAge = Math.max(60, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000))
  return serializeSignedCookie(ctx.authCookies.sessionToken.name, session.token, ctx.secret, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    partitioned: true,
    maxAge,
  })
}

/** Routes the session gate must not cover: mounted before it. */
export function mountEditorPublicRoutes(app: Express): void {
  app.post(EDITOR_EXCHANGE_PATH, async (req: Request, res: Response) => {
    const entry = takePending(codes, req.body?.code)
    if (!entry) return res.status(400).json({ error: 'this sign-in expired — start again from the editor' })
    await answerWithKey(res, entry.userId, entry.name)
  })

  app.post(EDITOR_WHOAMI_PATH, async (req: Request, res: Response) => {
    const holder = await keyHolder(req, res)
    if (holder) res.json({ user: holder.user })
  })

  app.post(EDITOR_SIGN_OUT_PATH, deleteOwnKey)

  app.post(EDITOR_EMBED_TICKET_PATH, async (req: Request, res: Response) => {
    const holder = await keyHolder(req, res)
    if (!holder) return
    const ticket = rememberPending(tickets, {
      userId: holder.userId,
      keyId: holder.keyId,
      expires: Date.now() + TICKET_TTL_MS,
    })
    res.json({ ticket, user: holder.user })
  })

  app.get(EDITOR_EMBED_PATH, async (req: Request, res: Response) => {
    const to = embedTarget(req.query.to) ?? '/'
    const entry = takePending(tickets, req.query.ticket)
    res.setHeader('Cache-Control', 'no-store')
    /* an iframe only: opened as a page, the ticket would sign that browser into the ticket's account */
    if (!entry || req.get('sec-fetch-dest') !== 'iframe' || (await isBanned(entry.userId))) return res.redirect(to)
    res.setHeader('Set-Cookie', await embedSessionCookie(entry.userId, entry.keyId))
    res.redirect(to)
  })
}

/** Behind the session gate: the signed-in browser approves the editor. */
export function mountEditorSessionRoutes(app: Express): void {
  app.post('/api/editor/connect', (req: Request, res: Response) => {
    const request: EditorConnectRequest = {
      redirect: String(req.body?.redirect ?? ''),
      state: String(req.body?.state ?? ''),
    }
    const target = editorRedirect(request.redirect)
    if (!target || !/^[0-9a-f]{32}$/.test(request.state))
      return res.status(400).json({ error: 'this link is not from a Doop editor extension' })
    const code = rememberPending(codes, {
      userId: req.user!.id,
      name: `${target.editor} extension`,
      expires: Date.now() + CODE_TTL_MS,
    })
    res.json({ url: editorCallbackURL(request, code), editor: target.editor })
  })
}
