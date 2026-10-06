import { createHmac } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import { webhooks as table } from './db/schema.ts'
import { store } from './store.ts'
import { hasDurableCanvasAccess } from './access.ts'
import { canvasLink, commentLink, frameLink } from './links.ts'
import {
  WEBHOOK_EVENTS,
  type WebhookDeliveryResult,
  type WebhookEventType,
  type WebhookInfo,
} from '../shared/webhooks.ts'
import type { CanvasEvent } from './events.ts'
import type { AgentTask, Canvas, ElementComment, Frame } from '../shared/types.ts'

/**
 * Outbound webhooks: the push counterpart of polling get_comments over MCP.
 * A person registers a URL and the events they care about; doop POSTs each
 * matching event on every canvas that person durably has access to (owner,
 * invited member, workspace member — the same rule as design-sync keys, so
 * a share-link visit never subscribes anyone to a canvas for good).
 *
 * Deliveries are signed (X-Doop-Signature, HMAC-SHA256 over
 * `<timestamp>.<body>` with the hook's secret) and retried a few times from
 * memory on failure. There is no durable queue: an event that fails every
 * retry is dropped, and a hook that fails DISABLE_AFTER_FAILURES times in a
 * row pauses itself until re-enabled. Delivery health is kept on the row.
 *
 * The URL is user input the server will connect to, so it is screened for
 * loopback, link-local and private ranges — at registration and again at
 * every delivery (DNS can change) — unless the operator opts in with
 * WEBHOOK_ALLOW_PRIVATE_URLS=true (a self-host whose n8n lives on the same
 * Docker network). Redirects are never followed for the same reason.
 */

export const MAX_WEBHOOKS = 10
export const RETRY_DELAYS_MS = [10_000, 60_000, 5 * 60_000]
export const DISABLE_AFTER_FAILURES = 100
export const TIMEOUT_MS = 10_000
const USER_AGENT = 'doop-webhooks/1'
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true'

interface WebhookRecord extends WebhookInfo {
  userId: string
  secret: string
}

const hooks = new Map<string, WebhookRecord>()

/** User input the route turns into a 400. */
export class WebhookInputError extends Error {}

function swallow(p: Promise<unknown>) {
  p.catch((err) => console.error('[webhooks] write failed', err))
}

function info(hook: WebhookRecord): WebhookInfo {
  const { userId: _userId, secret: _secret, ...rest } = hook
  return rest
}

function normalizeEvents(list: unknown): WebhookEventType[] {
  if (!Array.isArray(list)) return []
  const known = new Set<string>(WEBHOOK_EVENTS)
  return [...new Set(list.filter((e): e is WebhookEventType => typeof e === 'string' && known.has(e)))]
}

export async function hydrateWebhooks(): Promise<void> {
  hooks.clear()
  for (const row of await db.select().from(table)) hooks.set(row.id, { ...row, events: normalizeEvents(row.events) })
}

/* ------------------------------------------------------------------ */
/* URL screening                                                       */
/* ------------------------------------------------------------------ */

const PRIVATE_MSG =
  'that address is private to the server’s own network — the operator can allow it with WEBHOOK_ALLOW_PRIVATE_URLS=true'

function privateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** Loopback, link-local, unique-local, carrier-grade NAT and RFC 1918 — the
 *  addresses a webhook must not reach from inside the deployment. Anything
 *  that is not an IP literal counts as private: it is not an address. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return privateV4(ip)
  if (version !== 6) return true
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  /* IPv4-mapped, in both spellings: the WHATWG URL parser serialises
     [::ffff:127.0.0.1] as [::ffff:7f00:1], so the dotted form alone would
     wave a bracketed loopback through */
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (dotted) return privateV4(dotted[1] ?? '')
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hex) {
    const hi = parseInt(hex[1] ?? '0', 16)
    const lo = parseInt(hex[2] ?? '0', 16)
    return privateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  const first = parseInt(lower.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10
  return false
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}

/** Why a URL may not be a webhook target, or null when its syntax is fine.
 *  `targetProblem` goes on to check where the name points. */
export function urlProblem(raw: string): string | null {
  if (raw.length > 2_000) return 'that URL is too long'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'that is not a valid URL'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'the URL must start with https:// or http://'
  if (url.username || url.password) return 'credentials in the URL are not supported — use a secret path or header'
  if (allowPrivate()) return null
  const host = hostOf(url)
  if (host === 'localhost' || host.endsWith('.localhost')) return PRIVATE_MSG
  if (isIP(host) && isPrivateAddress(host)) return PRIVATE_MSG
  return null
}

export async function targetProblem(raw: string): Promise<string | null> {
  const syntax = urlProblem(raw)
  if (syntax || allowPrivate()) return syntax
  const host = hostOf(new URL(raw))
  if (isIP(host)) return null
  let addresses: { address: string }[]
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return 'that host name does not resolve'
  }
  if (!addresses.length) return 'that host name does not resolve'
  return addresses.some((a) => isPrivateAddress(a.address)) ? PRIVATE_MSG : null
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

function owned(userId: string, id: string): WebhookRecord | undefined {
  const hook = hooks.get(id)
  return hook && hook.userId === userId ? hook : undefined
}

export function listWebhooks(userId: string): WebhookInfo[] {
  return [...hooks.values()]
    .filter((h) => h.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(info)
}

async function checkedInput(input: { url?: string; events?: unknown }) {
  const url = input.url?.trim()
  if (url !== undefined) {
    const problem = await targetProblem(url)
    if (problem) throw new WebhookInputError(problem)
  }
  const events = input.events === undefined ? undefined : normalizeEvents(input.events)
  if (events && !events.length) throw new WebhookInputError('pick at least one event')
  return { url, events }
}

/* Creates for one account run one at a time: the per-account cap is checked
   in memory, and two requests racing through the DNS check could both pass it. */
const creating = new Map<string, Promise<unknown>>()
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = creating.get(key) ?? Promise.resolve()
  const run = prev.then(work, work)
  creating.set(key, run)
  const settle = () => {
    if (creating.get(key) === run) creating.delete(key)
  }
  void run.then(settle, settle)
  return run
}

/** The secret leaves the server here and in `rotateWebhookSecret` — the
 *  settings page shows it once. Memory changes only after the row is
 *  written, here and in every other mutation below, so a failed write
 *  leaves the running server and the database agreeing. */
export function createWebhook(
  userId: string,
  input: { url: string; events: unknown },
): Promise<{ info: WebhookInfo; secret: string }> {
  return serialized(userId, () => insertWebhook(userId, input))
}

async function insertWebhook(
  userId: string,
  input: { url: string; events: unknown },
): Promise<{ info: WebhookInfo; secret: string }> {
  if (listWebhooks(userId).length >= MAX_WEBHOOKS)
    throw new WebhookInputError(`you can have ${MAX_WEBHOOKS} webhooks — remove one you no longer use`)
  const { url, events } = await checkedInput(input)
  if (!url || !events) throw new WebhookInputError('a URL and at least one event are required')
  const hook: WebhookRecord = {
    id: nanoid(10),
    userId,
    url,
    secret: `whsec_${nanoid(32)}`,
    events,
    enabled: true,
    createdAt: Date.now(),
    lastStatus: null,
    lastAt: null,
    lastError: null,
    failures: 0,
  }
  await db.insert(table).values(hook)
  hooks.set(hook.id, hook)
  return { info: info(hook), secret: hook.secret }
}

export async function updateWebhook(
  userId: string,
  id: string,
  patch: { url?: string; events?: unknown; enabled?: boolean },
): Promise<WebhookInfo | undefined> {
  const hook = owned(userId, id)
  if (!hook) return undefined
  const { url, events } = await checkedInput(patch)
  /* only the fields asked for: a delivery that pauses the hook while this
     write is in flight must not be undone by a stale copy of its health */
  const next: Partial<Pick<WebhookRecord, 'url' | 'events' | 'enabled' | 'failures' | 'lastError'>> = {}
  if (url !== undefined) next.url = url
  if (events) next.events = events
  if (patch.enabled !== undefined) {
    next.enabled = patch.enabled
    /* switching a paused hook back on is a fresh start for its health */
    if (patch.enabled) {
      next.failures = 0
      next.lastError = null
    }
  }
  await db.update(table).set(next).where(eq(table.id, hook.id))
  Object.assign(hook, next)
  return info(hook)
}

export async function deleteWebhook(userId: string, id: string): Promise<boolean> {
  const hook = owned(userId, id)
  if (!hook) return false
  await db.delete(table).where(eq(table.id, id))
  hooks.delete(id)
  return true
}

export async function rotateWebhookSecret(userId: string, id: string): Promise<string | undefined> {
  const hook = owned(userId, id)
  if (!hook) return undefined
  const secret = `whsec_${nanoid(32)}`
  await db.update(table).set({ secret }).where(eq(table.id, id))
  hook.secret = secret
  return secret
}

/* ------------------------------------------------------------------ */
/* Payloads                                                            */
/* ------------------------------------------------------------------ */

function publicComment(c: ElementComment) {
  return {
    id: c.id,
    frameId: c.frameId,
    parentId: c.parentId ?? null,
    from: c.from,
    text: c.text,
    at: c.at,
    forAgent: c.forAgent ?? false,
    targetAgent: c.targetAgent ?? null,
    resolvedBy: c.resolvedBy ?? null,
    resolvedAt: c.resolvedAt ?? null,
    url: commentLink(c),
  }
}

/** Geometry and name — never the HTML, which can be megabytes. */
function publicFrame(f: Frame) {
  return { id: f.id, name: f.name, x: f.x, y: f.y, width: f.width, height: f.height, url: frameLink(f.canvasId, f.id) }
}

function publicTask(t: AgentTask) {
  return {
    id: t.id,
    title: t.status,
    agentName: t.agentName,
    queuedBy: t.queuedBy ?? null,
    startedAt: t.startedAt,
    endedAt: t.endedAt ?? null,
    failedAt: t.failedAt ?? null,
    failureReason: t.failureReason ?? null,
    frameIds: t.frameIds ?? [],
  }
}

/** The event-specific part of a delivery body. */
export function payloadFor(event: CanvasEvent): Record<string, unknown> {
  switch (event.type) {
    case 'comment.created':
    case 'comment.replied':
      return {
        actor: { name: event.comment.from, kind: event.actorKind },
        comment: publicComment(event.comment),
        frame: publicFrame(event.frame),
      }
    case 'comment.resolved':
      return {
        actor: { name: event.by },
        comment: publicComment(event.comment),
        frame: event.frame ? publicFrame(event.frame) : null,
      }
    case 'frame.created':
      return { actor: { name: event.actor.name, kind: event.actor.kind }, frame: publicFrame(event.frame) }
    case 'task.completed':
      return { actor: { name: event.task.agentName, kind: 'agent' }, task: publicTask(event.task) }
    case 'task.failed':
      return {
        actor: { name: event.task.agentName, kind: 'agent' },
        task: publicTask(event.task),
        reason: event.reason,
      }
  }
}

export function deliveryBody(canvas: Pick<Canvas, 'id' | 'name'>, event: CanvasEvent): Record<string, unknown> {
  return {
    id: `evt_${nanoid(12)}`,
    type: event.type,
    at: Date.now(),
    canvas: { id: canvas.id, name: canvas.name, url: canvasLink(canvas.id) },
    ...payloadFor(event),
  }
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

/** `sha256=<hex>` over `<timestamp>.<body>`: the timestamp in the signed
 *  string lets a receiver reject stale replays. */
export function sign(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

/** null = not sent and nothing to record: `stillWanted` said no after the
 *  lookup, which is where the owner may have lost the canvas meanwhile. */
async function post(
  hook: WebhookRecord,
  payload: Record<string, unknown>,
  stillWanted: () => boolean = () => true,
): Promise<WebhookDeliveryResult | null> {
  const problem = await targetProblem(hook.url)
  if (problem) return { ok: false, status: null, error: problem }
  if (!stillWanted()) return null
  const body = JSON.stringify(payload)
  const timestamp = Date.now()
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        'x-doop-event': String(payload.type),
        'x-doop-delivery': String(payload.id),
        'x-doop-timestamp': String(timestamp),
        'x-doop-signature': sign(hook.secret, timestamp, body),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    await res.body?.cancel().catch(() => {})
    if (res.ok) return { ok: true, status: res.status }
    const redirected = res.status >= 300 && res.status < 400
    return { ok: false, status: res.status, error: redirected ? 'redirects are not followed' : `HTTP ${res.status}` }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'TimeoutError'
          ? `no response within ${TIMEOUT_MS / 1000}s`
          : err.message
        : String(err)
    return { ok: false, status: null, error: message }
  }
}

/* Attempts to one hook can overlap (a slow failure, then a quick success);
   only the latest-started attempt may speak for the hook's health. */
const recorded = new Map<string, number>() // hookId -> ticket of the attempt last recorded
let nextTicket = 0

function record(hook: WebhookRecord, ticket: number, result: WebhookDeliveryResult) {
  if (ticket < (recorded.get(hook.id) ?? -1)) return
  recorded.set(hook.id, ticket)
  hook.lastStatus = result.status
  hook.lastAt = Date.now()
  hook.lastError = result.ok ? null : (result.error ?? 'failed')
  hook.failures = result.ok ? 0 : hook.failures + 1
  if (!result.ok && hook.failures >= DISABLE_AFTER_FAILURES && hook.enabled) {
    hook.enabled = false
    hook.lastError = `paused after ${DISABLE_AFTER_FAILURES} failed deliveries in a row (last: ${hook.lastError})`
  }
  swallow(
    db
      .update(table)
      .set({
        lastStatus: hook.lastStatus,
        lastAt: hook.lastAt,
        lastError: hook.lastError,
        failures: hook.failures,
        enabled: hook.enabled,
      })
      .where(eq(table.id, hook.id)),
  )
}

/** Whether an event on this canvas is still this hook's to receive: not
 *  deleted or paused meanwhile, and its owner can still open the canvas.
 *  Asked right before every POST, first attempt included, and before every
 *  retry — access can go away during a DNS lookup or a back-off. */
function stillDeliverable(hook: WebhookRecord, canvasId: string): boolean {
  if (hooks.get(hook.id) !== hook || !hook.enabled) return false
  const canvas = store.getCanvas(canvasId)
  return !!canvas && hasDurableCanvasAccess(hook.userId, canvas)
}

async function send(
  hook: WebhookRecord,
  canvasId: string,
  payload: Record<string, unknown>,
  attempt: number,
): Promise<void> {
  const ticket = nextTicket++
  const result = await post(hook, payload, () => stillDeliverable(hook, canvasId))
  if (!result) return
  record(hook, ticket, result)
  if (result.ok || attempt >= RETRY_DELAYS_MS.length) return
  const delay = RETRY_DELAYS_MS[attempt] ?? 0
  const timer = setTimeout(() => {
    if (stillDeliverable(hook, canvasId)) void send(hook, canvasId, payload, attempt + 1)
  }, delay)
  timer.unref?.()
}

/** The canvas event bus listener: fan an event out to every hook that
 *  subscribed to it and whose owner durably has access to the canvas. */
export function onCanvasEvent(canvasId: string, event: CanvasEvent): void {
  if (!hooks.size) return
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return
  const targets = [...hooks.values()].filter(
    (h) => h.enabled && h.events.includes(event.type) && hasDurableCanvasAccess(h.userId, canvas),
  )
  if (!targets.length) return
  const body = deliveryBody(canvas, event)
  for (const hook of targets) void send(hook, canvasId, body, 0)
}

/** A synchronous `ping`, so the settings page can show whether the other
 *  end answers before any real event happens. */
export async function testWebhook(userId: string, id: string): Promise<WebhookDeliveryResult | undefined> {
  const hook = owned(userId, id)
  if (!hook) return undefined
  const ticket = nextTicket++
  const result = await post(hook, {
    id: `evt_${nanoid(12)}`,
    type: 'ping',
    at: Date.now(),
    message: 'Hello from doop — this webhook is wired up.',
  })
  if (!result) return undefined
  record(hook, ticket, result)
  return result
}
