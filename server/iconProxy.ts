import type { Request, Response } from 'express'
import { env } from './env.ts'
import { hostedCopies, sendCopy } from './hostedCopies.ts'

/**
 * Icons from search_icons, served from Doop: /icons/iconify/<prefix>/<name>.svg (the provider in the path, so another icon source
 * can sit beside it), fetched from the
 * Iconify API by the server. A frame hotlinking api.iconify.design rendered
 * blank in screenshots and exports on and off (the renderer is a hosted browser that fetches
 * outside pages itself), while Doop's own /a/ assets always loaded; an icon on Doop's origin
 * loads like those, for viewers and every renderer alike. Each icon is fetched from Iconify once
 * and kept in the bucket (server/hostedCopies.ts).
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

const icons = hostedCopies({
  provider: 'iconify',
  maxBytes: MAX_ICON_BYTES,
  cacheLimit: CACHE_LIMIT,
  maxActive: MAX_ACTIVE,
  maxWaiting: MAX_WAITING,
  timeoutMs: FETCH_TIMEOUT_MS,
})

/** One icon's SVG, from memory, the bucket or Iconify; null when Iconify has no such icon. */
export async function iconSvg(url: string): Promise<Buffer | null> {
  return (await icons.get(url))?.body ?? null
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
  await sendCopy(res, icons.get(upstream), 'public, max-age=604800')
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
