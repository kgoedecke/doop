import type { Request, Response } from 'express'
import { env } from './env.ts'
import { hostedCopies, sendCopy } from './hostedCopies.ts'

/**
 * Stock photos from search_images, served from Doop: /photos/pexels/<id>.<jpeg|png> (the provider in the
 * path, so another photo source can sit beside it), copied from
 * Pexels into the bucket the first time anything loads them (server/hostedCopies.ts), so a frame's
 * photography renders in screenshots and exports like an /a/ asset and outlives Pexels' links. The
 * Pexels licence allows rehosting. Only photos something loads are copied, not every search result.
 */

const PEXELS_IMAGES = 'https://images.pexels.com'
/** a photo at the largest size a frame may ask for is a few MB */
const MAX_PHOTO_BYTES = 12 * 1024 * 1024

const FILE = /^(\d{1,12})\.(jpeg|jpg|png)$/
const DIMENSION = /^\d{1,4}$/

/** search_images' `large` size, and what an unsized request gets: never the multi-MB original. */
const DEFAULT_SIZE = { w: '940', h: '650' }

/** The Pexels size options a frame may ask for, each with the values it may take. */
const PARAMS: Record<string, RegExp> = {
  w: DIMENSION,
  h: DIMENSION,
  dpr: /^[1-3]$/,
  fit: /^(?:crop|max|min)$/,
}

const photos = hostedCopies({
  provider: 'pexels',
  maxBytes: MAX_PHOTO_BYTES,
  cacheLimit: 64,
  maxActive: 8,
  maxWaiting: 32,
  timeoutMs: 20_000,
})

/** The Pexels address for a photo, or null for a file or size Pexels would not serve. */
export function upstreamFor(file: string, query: Record<string, unknown>): string | null {
  const match = FILE.exec(file)
  if (!match) return null
  const [, id, ext] = match
  const params = new URLSearchParams({ auto: 'compress', cs: 'tinysrgb' })
  for (const [key, pattern] of Object.entries(PARAMS)) {
    const value = query[key]
    if (typeof value === 'string' && pattern.test(value)) params.set(key, value)
  }
  if (!params.has('w') && !params.has('h'))
    for (const [key, value] of Object.entries(DEFAULT_SIZE)) params.set(key, value)
  params.sort()
  return `${PEXELS_IMAGES}/photos/${id}/pexels-photo-${id}.${ext === 'jpg' ? 'jpeg' : ext}?${params}`
}

/** Where a frame loads a Pexels photo from, keeping the size the source URL asked for. */
export function photoUrl(pexelsUrl: string): string {
  const source = new URL(pexelsUrl)
  const match = /^\/photos\/(\d+)\/pexels-photo-\1\.(jpeg|jpg|png)$/.exec(source.pathname)
  if (source.origin !== PEXELS_IMAGES || !match) return pexelsUrl
  const params = new URLSearchParams()
  for (const key of Object.keys(PARAMS)) {
    const value = source.searchParams.get(key)
    if (value) params.set(key, value)
  }
  params.sort()
  const search = params.size ? `?${params}` : ''
  return `${env.BETTER_AUTH_URL}/photos/pexels/${match[1]}.${match[2]}${search}`
}

/** A Doop photo URL read in-process (exports that must not fetch their own origin); undefined when it is not one. */
export function hostedPhoto(src: URL): Promise<Buffer | null> | undefined {
  if (src.origin !== new URL(env.BETTER_AUTH_URL).origin) return undefined
  const match = /^\/photos\/pexels\/([^/]+)$/.exec(src.pathname)
  if (!match) return undefined
  const upstream = upstreamFor(match[1]!, Object.fromEntries(src.searchParams))
  return upstream ? photos.get(upstream).then((copy) => copy?.body ?? null) : Promise.resolve(null)
}

export async function servePhoto(req: Request, res: Response) {
  const upstream = upstreamFor((req.params as { file: string }).file, req.query)
  if (!upstream) return res.status(404).end()
  /* a Pexels photo id never changes its picture */
  await sendCopy(res, photos.get(upstream), 'public, max-age=31536000, immutable')
}

const HOTLINK = /https:\/\/images\.pexels\.com\/photos\/\d+\/pexels-photo-\d+\.(?:jpeg|jpg|png)(?:\?[^"'\s)<>]*)?/g

/** A frame's Pexels hotlinks pointed at Doop's copies, for a renderer: frames written before
 *  search_images handed out Doop URLs keep their links, and render like new ones. */
export function withHostedPhotos(html: string): string {
  return html.includes('images.pexels.com')
    ? html.replace(HOTLINK, (link) => {
        /* written the way it was found: &amp; in an attribute, a bare & in CSS */
        const escaped = link.includes('&amp;')
        const hosted = photoUrl(escaped ? link.replace(/&amp;/g, '&') : link)
        return escaped ? hosted.replace(/&/g, '&amp;') : hosted
      })
    : html
}
