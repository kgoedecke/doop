import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import { env } from './env.ts'
import * as storage from './storage.ts'

/**
 * Icons from search_icons, served from Doop: /icons/iconify/<prefix>/<name>.svg (the provider in the path, so another icon source
 * can sit beside it), fetched from the
 * Iconify API by the server and kept in memory. A frame hotlinking api.iconify.design rendered
 * blank in screenshots and exports on and off (the renderer is a hosted browser that fetches
 * outside pages itself), while Doop's own /a/ assets always loaded; an icon on Doop's origin
 * loads like those, for viewers and every renderer alike. Each icon is fetched from Iconify once:
 * it is kept in the bucket (iconify/<hash>.svg) and in memory, so restarts and an Iconify outage
 * leave every icon already used loading.
 */

export const ICONIFY_ENDPOINT = 'https://api.iconify.design'
const FETCH_TIMEOUT_MS = 10_000
const MAX_ICON_BYTES = 256 * 1024
const CACHE_LIMIT = 4000
/** Iconify fetches at once, and how many more may wait: a burst of new colours cannot pile up work. */
const MAX_ACTIVE = 16
const MAX_WAITING = 64

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The Iconify customisations a frame may ask for, each with the values it may take. */
const PARAMS: Record<string, RegExp> = {
  color: /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/,
  width: /^(?:\d{1,4}(?:\.\d{1,2})?|auto|unset|none)$/,
  height: /^(?:\d{1,4}(?:\.\d{1,2})?|auto|unset|none)$/,
  rotate: /^(?:[0-3]|\d{1,3}deg)$/,
  flip: /^(?:horizontal|vertical|horizontal,vertical|vertical,horizontal)$/,
  box: /^(?:1|true)$/,
}

/** Where a frame loads the icon `<prefix>:<name>` from. */
export function iconUrl(prefix: string, name: string): string {
  return `${env.BETTER_AUTH_URL}/icons/iconify/${prefix}/${name}.svg`
}

/** The upstream address for an icon, or null for a name or customisation Iconify would not serve. */
export function upstreamFor(prefix: string, file: string, query: Record<string, unknown>): string | null {
  const name = file.endsWith('.svg') ? file.slice(0, -4) : null
  if (!NAME.test(prefix) || !name || !NAME.test(name)) return null
  const params = new URLSearchParams()
  for (const [key, pattern] of Object.entries(PARAMS)) {
    const value = query[key]
    if (typeof value === 'string' && pattern.test(value)) params.set(key, value)
  }
  params.sort()
  const search = params.size ? `?${params}` : ''
  return `${ICONIFY_ENDPOINT}/${prefix}/${name}.svg${search}`
}

/* insertion order is recency: a hit moves to the back, the front is evicted */
const cache = new Map<string, Buffer>()
const inFlight = new Map<string, Promise<Buffer | null>>()

function remember(key: string, svg: Buffer) {
  cache.delete(key)
  cache.set(key, svg)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
}

/** Too many icons are being fetched at once: try again shortly. */
export class IconsBusyError extends Error {
  constructor() {
    super('icon fetches are busy')
  }
}

let active = 0
const waiting: (() => void)[] = []

async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING) throw new IconsBusyError()
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  active++
  try {
    return await work()
  } finally {
    active--
    waiting.shift()?.()
  }
}

async function fetchIcon(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`icon fetch failed: HTTP ${res.status}`)
  if (!res.headers.get('content-type')?.startsWith('image/svg+xml')) throw new Error('icon fetch returned no SVG')
  const svg = Buffer.from(await res.arrayBuffer())
  if (svg.length > MAX_ICON_BYTES) throw new Error('icon is too large')
  return svg
}

const storageKey = (url: string) => `iconify/${createHash('sha256').update(url).digest('hex')}.svg`

/** The bucket's copy, else Iconify's (stored for next time). A bucket that fails is skipped, not fatal. */
async function loadIcon(url: string): Promise<Buffer | null> {
  const key = storageKey(url)
  const stored = await storage.getObject(key).catch(() => null)
  if (stored) return stored
  const svg = await limited(() => fetchIcon(url))
  if (svg)
    await storage.putObject(key, svg, 'image/svg+xml').catch((error: unknown) => console.warn('[icons] store', error))
  return svg
}

/** One icon's SVG, from memory, the bucket or Iconify; null when Iconify has no such icon. */
export async function iconSvg(url: string): Promise<Buffer | null> {
  const cached = cache.get(url)
  if (cached) {
    remember(url, cached)
    return cached
  }
  let pending = inFlight.get(url)
  if (!pending) {
    pending = loadIcon(url).finally(() => inFlight.delete(url))
    inFlight.set(url, pending)
  }
  const svg = await pending
  if (svg) remember(url, svg)
  return svg
}

/** A Doop icon URL read in-process (exports that must not fetch their own origin); undefined when it is not one. */
export function hostedIconSvg(src: URL): Promise<Buffer | null> | undefined {
  if (src.origin !== new URL(env.BETTER_AUTH_URL).origin) return undefined
  const match = /^\/icons\/iconify\/([^/]+)\/([^/]+)$/.exec(src.pathname)
  if (!match) return undefined
  const upstream = upstreamFor(match[1]!, match[2]!, Object.fromEntries(src.searchParams))
  return upstream ? iconSvg(upstream) : Promise.resolve(null)
}

export async function serveIcon(req: Request, res: Response) {
  const { prefix, file } = req.params as { prefix: string; file: string }
  const upstream = upstreamFor(prefix, file, req.query)
  if (!upstream) return res.status(404).end()
  try {
    const svg = await iconSvg(upstream)
    if (!svg) return res.status(404).end()
    res.set('Content-Type', 'image/svg+xml')
    res.set('Cache-Control', 'public, max-age=604800')
    res.set('X-Content-Type-Options', 'nosniff')
    /* CSS mask-image fetches with CORS from a sandboxed frame's opaque origin */
    res.set('Access-Control-Allow-Origin', '*')
    /* an SVG opened as a document can script: neuter it, as /a/ does */
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    res.send(svg)
  } catch (error) {
    if (error instanceof IconsBusyError) {
      res.set('Retry-After', '2')
      return res.status(503).end()
    }
    res.status(502).end()
  }
}

const HOTLINK = /https:\/\/api\.iconify\.design\/([a-z0-9-]+)\/([a-z0-9-]+\.svg)/g

/** A frame's Iconify hotlinks pointed at Doop's copies, for a renderer: frames written
 *  before search_icons handed out Doop URLs keep their links, and render like new ones. */
export function withHostedIcons(html: string): string {
  return html.includes('api.iconify.design')
    ? html.replace(
        HOTLINK,
        (_link, prefix: string, file: string) => `${env.BETTER_AUTH_URL}/icons/iconify/${prefix}/${file}`,
      )
    : html
}
