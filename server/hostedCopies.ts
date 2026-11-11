import { createHash } from 'node:crypto'
import type { Response } from 'express'
import * as storage from './storage.ts'

/**
 * Doop's copies of images from a known source (Iconify icons, Pexels photos), served from Doop's
 * own origin. A frame hotlinking another host rendered blank in screenshots and exports on and off,
 * since the hosted renderer fetches outside pages itself, while Doop's own /a/ assets always loaded.
 * Each image is fetched from its source once: it is kept in the bucket (<provider>/<sha256 of the source
 * URL>.<ext>) and a small in-memory LRU, so restarts and a source outage leave every image already
 * used loading. Only the source URLs a caller builds and validates reach here.
 */

/** Too many images are being fetched from the source at once: try again shortly. */
export class CopiesBusyError extends Error {
  constructor(provider: string) {
    super(`${provider} fetches are busy`)
  }
}

export interface CopyOptions {
  /** the source: the bucket folder, and the name in logs */
  provider: 'iconify' | 'pexels'
  maxBytes: number
  /** entries held in memory */
  cacheLimit: number
  /** source fetches at once, and how many more may wait */
  maxActive: number
  maxWaiting: number
  timeoutMs: number
}

export interface Copy {
  body: Buffer
  mime: string
}

const EXT_MIME: Record<string, string> = { svg: 'image/svg+xml', jpeg: 'image/jpeg', png: 'image/png' }

/** The image type a source URL names by its extension. */
function typeOf(url: string): { ext: string; mime: string } | null {
  const ext = /\.([a-z]+)(?:\?|$)/.exec(new URL(url).pathname + '?')?.[1]
  const normal = ext === 'jpg' ? 'jpeg' : ext
  return normal && EXT_MIME[normal] ? { ext: normal, mime: EXT_MIME[normal] } : null
}

export function hostedCopies(options: CopyOptions) {
  /* insertion order is recency: a hit moves to the back, the front is evicted */
  const cache = new Map<string, Copy>()
  const inFlight = new Map<string, Promise<Copy | null>>()
  let active = 0
  const waiting: (() => void)[] = []

  function remember(url: string, copy: Copy) {
    cache.delete(url)
    cache.set(url, copy)
    if (cache.size > options.cacheLimit) cache.delete(cache.keys().next().value!)
  }

  async function limited<T>(work: () => Promise<T>): Promise<T> {
    if (active >= options.maxActive) {
      if (waiting.length >= options.maxWaiting) throw new CopiesBusyError(options.provider)
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

  async function fetchSource(url: string, mime: string): Promise<Buffer | null> {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs) })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`${options.provider} fetch failed: HTTP ${res.status}`)
    if (!res.headers.get('content-type')?.startsWith(mime))
      throw new Error(`${options.provider} fetch returned no ${mime}`)
    const declared = Number(res.headers.get('content-length'))
    if (declared > options.maxBytes) throw new Error(`${options.provider} image is too large`)
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > options.maxBytes) throw new Error(`${options.provider} image is too large`)
    return body
  }

  /** The bucket's copy, else the source's (stored for next time). A bucket that fails is skipped, not fatal. */
  async function load(url: string): Promise<Copy | null> {
    const type = typeOf(url)
    if (!type) return null
    const key = `${options.provider}/${createHash('sha256').update(url).digest('hex')}.${type.ext}`
    const stored = await storage.getObject(key).catch(() => null)
    if (stored) return { body: stored, mime: type.mime }
    const body = await limited(() => fetchSource(url, type.mime))
    if (!body) return null
    await storage
      .putObject(key, body, type.mime)
      .catch((error: unknown) => console.warn(`[${options.provider}] store`, error))
    return { body, mime: type.mime }
  }

  /** One image, from memory, the bucket or its source; null when the source has no such image. */
  async function get(url: string): Promise<Copy | null> {
    const cached = cache.get(url)
    if (cached) {
      remember(url, cached)
      return cached
    }
    let pending = inFlight.get(url)
    if (!pending) {
      pending = load(url).finally(() => inFlight.delete(url))
      inFlight.set(url, pending)
    }
    const copy = await pending
    if (copy) remember(url, copy)
    return copy
  }

  return { get }
}

/** Answer a request for a copy: the image with the headers an /a/ asset gets, or why there is none. */
export async function sendCopy(res: Response, loading: Promise<Copy | null>, cacheControl: string) {
  try {
    const copy = await loading
    if (!copy) return res.status(404).end()
    res.set('Content-Type', copy.mime)
    res.set('Cache-Control', cacheControl)
    res.set('X-Content-Type-Options', 'nosniff')
    /* CSS mask-image fetches with CORS from a sandboxed frame's opaque origin */
    res.set('Access-Control-Allow-Origin', '*')
    /* an SVG opened as a document can script: neuter it, as /a/ does */
    if (copy.mime === 'image/svg+xml')
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    res.send(copy.body)
  } catch (error) {
    if (error instanceof CopiesBusyError) {
      res.set('Retry-After', '2')
      return res.status(503).end()
    }
    res.status(502).end()
  }
}
