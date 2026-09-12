import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import { integrations } from './db/schema.ts'
import { createAsset, fetchRemote } from './assets.ts'
import { store } from './store.ts'
import * as actions from './actions.ts'
import type { Actor, Frame } from '../shared/types.ts'
import type { PullFilter } from '../shared/automations.ts'

/**
 * The Meta integration: a user-level OAuth connection to Meta (scope
 * ads_read) and what it unlocks — pulling ad creatives onto a canvas.
 *
 * The token is a long-lived user token (~60 days). It is stored on the
 * integrations row and never leaves the server; API responses carry the ad
 * account list and display fields only. When Meta rejects the token the
 * pull fails with `reconnect`, which the Runs list turns into a button.
 */

const GRAPH = 'https://graph.facebook.com/v21.0'
const DIALOG = 'https://www.facebook.com/v21.0/dialog/oauth'
const SCOPES = 'ads_read'
const STATE_TTL_MS = 15 * 60_000
/** ads fetched per pull, across pages — a canvas is not an archive */
const MAX_ADS = 200
const PAGE_SIZE = 50

/* same env read as server/auth.ts — not imported, so this module stays
   loadable in unit tests without the auth stack */
const PUBLIC_ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:4300'

export function metaEnabled(): boolean {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET)
}

export function redirectUri(): string {
  return `${PUBLIC_ORIGIN}/api/integrations/meta/callback`
}

/* ------------------------------------------------------------------ */
/* Signed OAuth state                                                  */

function secret(): string {
  return process.env.BETTER_AUTH_SECRET || 'doop-dev-secret-not-for-production'
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

/** Goes out with the authorize link; proves the round-trip began here, for
 *  this user. Dots would collide with the separator — user ids never carry
 *  them, but refuse rather than assume. */
export function signState(userId: string, now = Date.now()): string {
  if (/[.]/.test(userId)) throw new Error('invalid id')
  const payload = ['meta-state', userId, String(now + STATE_TTL_MS)].join('.')
  return `${payload}.${sign(payload)}`
}

export function verifyState(state: string): { userId: string } | undefined {
  const parts = state.split('.')
  if (parts.length !== 4 || parts[0] !== 'meta-state') return undefined
  const mac = parts.pop()!
  const payload = parts.join('.')
  const a = Buffer.from(mac)
  const b = Buffer.from(sign(payload))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  if (Number(parts[2]) < Date.now()) return undefined
  return { userId: parts[1]! }
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID ?? '',
    redirect_uri: redirectUri(),
    state,
    scope: SCOPES,
    response_type: 'code',
  })
  return `${DIALOG}?${params}`
}

/* ------------------------------------------------------------------ */
/* Graph API                                                           */

export class MetaAuthError extends Error {}

interface GraphError {
  error?: { message?: string; code?: number; type?: string }
}

async function graph<T>(path: string, params: Record<string, string>, token?: string): Promise<T> {
  const url = new URL(`${GRAPH}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  if (token) url.searchParams.set('access_token', token)
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  const body = (await res.json().catch(() => ({}))) as T & GraphError
  if (!res.ok || body.error) {
    const code = body.error?.code
    const message = body.error?.message ?? `Meta responded ${res.status}`
    /* 190 = invalid/expired token, 102 = session; 10/200-299 = permission */
    if (res.status === 401 || code === 190 || code === 102 || body.error?.type === 'OAuthException')
      throw new MetaAuthError(message)
    throw new Error(message)
  }
  return body
}

/** Code → short-lived token → long-lived token. */
export async function exchangeCode(code: string): Promise<{ token: string; expiresAt: number | null }> {
  const appId = process.env.META_APP_ID ?? ''
  const appSecret = process.env.META_APP_SECRET ?? ''
  const short = await graph<{ access_token: string }>('/oauth/access_token', {
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri(),
    code,
  })
  const long = await graph<{ access_token: string; expires_in?: number }>('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: short.access_token,
  })
  return {
    token: long.access_token,
    expiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : null,
  }
}

export interface AdAccount {
  id: string
  name: string
}

export async function fetchIdentity(token: string): Promise<{ name: string; accounts: AdAccount[] }> {
  const me = await graph<{ name?: string }>('/me', { fields: 'name' }, token)
  const accounts: AdAccount[] = []
  let after: string | undefined
  for (let page = 0; page < 5; page++) {
    const res = await graph<{
      data: { id: string; name?: string; account_id: string }[]
      paging?: { cursors?: { after?: string }; next?: string }
    }>('/me/adaccounts', { fields: 'name,account_id', limit: '100', ...(after ? { after } : {}) }, token)
    for (const a of res.data) accounts.push({ id: a.id, name: a.name || `Account ${a.account_id}` })
    after = res.paging?.next ? res.paging.cursors?.after : undefined
    if (!after) break
  }
  return { name: me.name ?? 'Meta account', accounts }
}

/* ------------------------------------------------------------------ */
/* Connection rows                                                     */

export type MetaConnection = typeof integrations.$inferSelect

export interface MetaConnectionInfo {
  connected: boolean
  accountName?: string
  accounts?: AdAccount[]
  connectedAt?: number
  expiresAt?: number | null
}

export function connectionInfo(row: MetaConnection | undefined): MetaConnectionInfo {
  if (!row) return { connected: false }
  return {
    connected: true,
    accountName: row.accountName ?? undefined,
    accounts: row.accounts,
    connectedAt: row.connectedAt,
    expiresAt: row.expiresAt,
  }
}

export async function getConnection(userId: string): Promise<MetaConnection | undefined> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.provider, 'meta')))
  return row ?? undefined
}

/** Finish the OAuth round-trip: swap the code, learn who this is and which
 *  ad accounts they can read, and (re)place the one Meta row for the user. */
export async function connect(userId: string, code: string): Promise<MetaConnection> {
  const { token, expiresAt } = await exchangeCode(code)
  const identity = await fetchIdentity(token)
  const now = Date.now()
  const fresh = {
    accessToken: token,
    expiresAt,
    accountName: identity.name,
    accounts: identity.accounts,
    updatedAt: now,
  }
  /* one row per user and provider, enforced by the unique index: two
     callbacks racing each other both land on the same row, last token wins */
  const [row] = await db
    .insert(integrations)
    .values({ id: nanoid(8), userId, provider: 'meta', connectedAt: now, ...fresh })
    .onConflictDoUpdate({ target: [integrations.userId, integrations.provider], set: fresh })
    .returning()
  return row!
}

export async function disconnect(userId: string): Promise<boolean> {
  const gone = await db
    .delete(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.provider, 'meta')))
    .returning({ id: integrations.id })
  return gone.length > 0
}

/* ------------------------------------------------------------------ */
/* Pulling creatives                                                   */

export interface AdCreative {
  adId: string
  name: string
  headline: string
  body: string
  cta: string
  /** the best image URL known so far — a thumbnail until resolveImages runs */
  imageUrl: string | null
  /** the ad image's hash, when the creative has one — the key to the full-size file */
  imageHash: string | null
  /** creative id, for the sized-thumbnail fallback */
  creativeId: string | null
  /** natural size of the image, once known — the frame follows its aspect */
  width: number | null
  height: number | null
  status: string
}

interface GraphAd {
  id: string
  name?: string
  effective_status?: string
  creative?: {
    id?: string
    title?: string
    body?: string
    image_url?: string
    image_hash?: string
    thumbnail_url?: string
    call_to_action_type?: string
    object_story_spec?: {
      link_data?: {
        message?: string
        name?: string
        picture?: string
        image_hash?: string
        call_to_action?: { type?: string }
        /** carousel cards */
        child_attachments?: { name?: string; description?: string; picture?: string; image_hash?: string }[]
      }
      video_data?: {
        message?: string
        title?: string
        image_url?: string
        image_hash?: string
        call_to_action?: { type?: string }
      }
    }
    asset_feed_spec?: {
      titles?: { text?: string }[]
      bodies?: { text?: string }[]
      images?: { hash?: string }[]
      call_to_action_types?: string[]
    }
  }
}

function titleCase(cta: string | undefined): string {
  if (!cta) return ''
  return cta
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Flatten Meta's several creative shapes into cards. Most ads are one
 *  card; a dynamic-creative ad (asset feed) yields one card per image and a
 *  carousel one card per child — each keyed by ad id plus image, so a later
 *  pull still recognises them. */
export function toCreatives(ad: GraphAd): AdCreative[] {
  const c = ad.creative ?? {}
  const link = c.object_story_spec?.link_data
  const video = c.object_story_spec?.video_data
  const feed = c.asset_feed_spec
  const name = ad.name || `Ad ${ad.id}`
  const base: AdCreative = {
    adId: ad.id,
    name,
    headline: c.title || link?.name || video?.title || feed?.titles?.[0]?.text || '',
    body: c.body || link?.message || video?.message || feed?.bodies?.[0]?.text || '',
    cta: titleCase(
      c.call_to_action_type ||
        link?.call_to_action?.type ||
        video?.call_to_action?.type ||
        feed?.call_to_action_types?.[0],
    ),
    imageUrl: c.image_url || link?.picture || video?.image_url || c.thumbnail_url || null,
    imageHash: c.image_hash || link?.image_hash || video?.image_hash || feed?.images?.[0]?.hash || null,
    creativeId: c.id ?? null,
    width: null,
    height: null,
    status: ad.effective_status ?? '',
  }
  const feedImages = (feed?.images ?? []).filter((i): i is { hash: string } => !!i.hash)
  if (feedImages.length > 1) {
    return feedImages.map((img, i) => ({
      ...base,
      adId: `${ad.id}:${img.hash}`,
      name: `${name} · ${i + 1}`,
      imageUrl: null,
      imageHash: img.hash,
      /* every card has its own image, so no sized-thumbnail fallback */
      creativeId: null,
    }))
  }
  const cards = link?.child_attachments ?? []
  if (cards.length > 1) {
    return cards.map((card, i) => ({
      ...base,
      adId: `${ad.id}:${card.image_hash ?? i}`,
      name: `${name} · ${i + 1}`,
      headline: card.name || base.headline,
      body: card.description || base.body,
      imageUrl: card.picture || null,
      imageHash: card.image_hash || null,
      creativeId: null,
    }))
  }
  return [base]
}

/** The single-card view of an ad — the first card for multi-image ads. */
export function toCreative(ad: GraphAd): AdCreative {
  return toCreatives(ad)[0]!
}

/** Trade thumbnails for the real files. `thumbnail_url` and `picture` are
 *  64px previews; the full-size image lives behind the creative's image
 *  hash on the account's ad-image library. Creatives without a hash (video
 *  covers, some dynamic formats) get a re-sized thumbnail instead. */
export async function resolveImages(token: string, accountId: string, ads: AdCreative[]): Promise<void> {
  const hashes = [...new Set(ads.map((a) => a.imageHash).filter((h): h is string => !!h))]
  const byHash = new Map<string, { url: string; width: number | null; height: number | null }>()
  for (let i = 0; i < hashes.length; i += 50) {
    const chunk = hashes.slice(i, i + 50)
    try {
      const res = await graph<{
        data: { hash: string; url?: string; permalink_url?: string; width?: number; height?: number }[]
      }>(
        `/${accountId}/adimages`,
        { hashes: JSON.stringify(chunk), fields: 'hash,url,permalink_url,width,height' },
        token,
      )
      for (const img of res.data) {
        const url = img.url || img.permalink_url
        if (url) byHash.set(img.hash, { url, width: img.width ?? null, height: img.height ?? null })
      }
    } catch (err) {
      if (err instanceof MetaAuthError) throw err
      /* keep the thumbnails for this chunk rather than fail the pull */
    }
  }
  for (const ad of ads) {
    const full = ad.imageHash ? byHash.get(ad.imageHash) : undefined
    if (full) {
      ad.imageUrl = full.url
      ad.width = full.width
      ad.height = full.height
      continue
    }
    if (!ad.creativeId) continue
    try {
      const sized = await graph<{ thumbnail_url?: string }>(
        `/${ad.creativeId}`,
        { fields: 'thumbnail_url', thumbnail_width: '1080', thumbnail_height: '1080' },
        token,
      )
      if (sized.thumbnail_url) ad.imageUrl = sized.thumbnail_url
    } catch (err) {
      if (err instanceof MetaAuthError) throw err
    }
  }
}

export async function fetchAds(token: string, accountId: string, filter: PullFilter): Promise<AdCreative[]> {
  const out: AdCreative[] = []
  let after: string | undefined
  while (out.length < MAX_ADS) {
    const res = await graph<{ data: GraphAd[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      `/${accountId}/ads`,
      {
        fields:
          'id,name,effective_status,creative{id,title,body,image_url,image_hash,thumbnail_url,call_to_action_type,object_story_spec,asset_feed_spec}',
        limit: String(PAGE_SIZE),
        ...(filter === 'active' ? { effective_status: '["ACTIVE"]' } : {}),
        ...(after ? { after } : {}),
      },
      token,
    )
    for (const ad of res.data) out.push(...toCreatives(ad))
    after = res.paging?.next ? res.paging.cursors?.after : undefined
    if (!after) break
  }
  const ads = out.slice(0, MAX_ADS)
  await resolveImages(token, accountId, ads)
  return ads
}

/* ------------------------------------------------------------------ */
/* Frames                                                              */

const MARKER = 'doop-meta-ad'
const FRAME_W = 480
/** the copy block under the image; the image adds its own height */
const COPY_H = 190
const GAP = 40
const COLUMNS = 4

/** The image's height at frame width. Unknown dimensions read as square,
 *  which is Meta's most common feed format. */
export function imageHeight(ad: Pick<AdCreative, 'width' | 'height'>): number {
  if (!ad.width || !ad.height) return FRAME_W
  return Math.round((FRAME_W * ad.height) / ad.width)
}

export function frameHeight(ad: Pick<AdCreative, 'width' | 'height'>): number {
  return imageHeight(ad) + COPY_H
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The ad id a pulled frame carries, if it is one. */
export function metaFrameMarker(html: string): string | undefined {
  const m = html.match(new RegExp(`<meta name="${MARKER}" content="([^"]+)"`))
  return m?.[1]
}

/** A plain, faithful card: the creative's image with its headline, body and
 *  CTA underneath — a reference for agents to iterate on, not a redesign. */
export function creativeHtml(ad: AdCreative, imageSrc: string | null): string {
  const artH = imageHeight(ad)
  const image = imageSrc
    ? `<img class="art" src="${escapeHtml(imageSrc)}" alt="">`
    : `<div class="art blank">No image on this creative</div>`
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="${MARKER}" content="${escapeHtml(ad.adId)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;background:#fff;font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111}
  .card{width:${FRAME_W}px;min-height:${frameHeight(ad)}px;display:flex;flex-direction:column}
  .art{display:block;width:${FRAME_W}px;height:${artH}px;object-fit:contain;background:#f1f1f1}
  .blank{display:grid;place-items:center;color:#999;font-size:13px}
  .copy{padding:18px 20px 22px;display:flex;flex-direction:column;gap:8px;flex:1}
  .name{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a}
  h1{margin:0;font-size:20px;line-height:1.25;font-weight:700}
  p{margin:0;font-size:14px;line-height:1.5;color:#444;white-space:pre-line}
  .cta{margin-top:auto;align-self:flex-start;background:#111;color:#fff;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px}
</style></head>
<body><div class="card">
  ${image}
  <div class="copy">
    <div class="name">${escapeHtml(ad.name)}</div>
    ${ad.headline ? `<h1>${escapeHtml(ad.headline)}</h1>` : ''}
    ${ad.body ? `<p>${escapeHtml(ad.body)}</p>` : ''}
    ${ad.cta ? `<span class="cta">${escapeHtml(ad.cta)}</span>` : ''}
  </div>
</div></body></html>`
}

/** Meta's image URLs are signed and expire — copy the bytes into Doop's own
 *  asset store so the frame keeps rendering. A failed copy still lands the
 *  frame, with the remote URL as a best effort. */
async function keepImage(url: string | null, canvasId: string, ownerId: string): Promise<string | null> {
  if (!url) return null
  try {
    /* the asset layer's guarded fetch: SSRF-checked hops, 5 MB cap while streaming */
    const buf = await fetchRemote(url)
    const asset = await createAsset(buf, { canvasId, ownerId, uploadedBy: 'Automation' })
    return `/a/${asset.id}.${asset.ext}`
  } catch {
    return url
  }
}

export interface PullResult {
  created: Frame[]
  /** ads already on the canvas from an earlier pull */
  skipped: number
  total: number
}

/** Land the account's creatives on the canvas as frames, one row grid below
 *  whatever is already there. Ads already present (by marker) are skipped,
 *  so a weekly pull only adds what's new. */
export async function pullCreatives(input: {
  connection: MetaConnection
  accountId: string
  filter: PullFilter
  canvasId: string
  ownerId: string
  actor: Actor
}): Promise<PullResult> {
  const canvas = store.getCanvas(input.canvasId)
  if (!canvas) throw new Error('canvas not found')
  if (!input.connection.accounts.some((a) => a.id === input.accountId))
    throw new Error('that ad account is not part of the Meta connection')
  const ads = await fetchAds(input.connection.accessToken, input.accountId, input.filter)
  const present = new Set<string>()
  for (const f of canvas.frames) {
    const id = metaFrameMarker(f.html)
    if (id) present.add(id)
  }
  const fresh = ads.filter((ad) => !present.has(ad.adId))
  const bottom = canvas.frames.reduce((my, f) => Math.max(my, f.y + f.height), 0)
  const startY = canvas.frames.length ? bottom + 80 : 120
  const created: Frame[] = []
  let y = startY
  let rowHeight = 0
  for (const [i, ad] of fresh.entries()) {
    const column = i % COLUMNS
    if (column === 0 && i > 0) {
      y += rowHeight + GAP
      rowHeight = 0
    }
    const src = await keepImage(ad.imageUrl, input.canvasId, input.ownerId)
    const height = frameHeight(ad)
    rowHeight = Math.max(rowHeight, height)
    const frame = actions.createFrame(
      input.canvasId,
      {
        name: ad.name.slice(0, 80),
        x: 120 + column * (FRAME_W + GAP),
        y,
        width: FRAME_W,
        height,
        html: creativeHtml(ad, src),
      },
      input.actor,
    )
    if (frame) created.push(frame)
  }
  return { created, skipped: ads.length - fresh.length, total: ads.length }
}
