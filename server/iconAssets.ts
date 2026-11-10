import { createHash } from 'node:crypto'
import { Router } from 'express'
import { fetchPinnedPublicUrl } from './publicUrl.ts'
import * as storage from './storage.ts'

const ICONIFY_ORIGIN = 'https://api.iconify.design'
const MAX_ICON_BYTES = 256_000
const MAX_PENDING_ICONS = 64
const inflight = new Map<string, Promise<Buffer>>()
const ICON_PATH = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.svg$/
const PARAMETERS = new Set(['color', 'height', 'width', 'flip', 'rotate', 'box'])

/** Only Iconify's SVG endpoint, never a caller-selected origin or API route.
 * Canonical query ordering deduplicates equivalent color/size variants. */
export function iconAssetSource(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.origin !== ICONIFY_ORIGIN || url.username || url.password || url.pathname.length > 200) return null
  if (!ICON_PATH.test(url.pathname)) return null
  const seen = new Set<string>()
  for (const [name, value] of url.searchParams) {
    if (!PARAMETERS.has(name) || seen.has(name) || value.length > 128) return null
    seen.add(name)
  }
  url.hash = ''
  url.searchParams.sort()
  return url
}

export function iconAssetUrl(id: string, origin: string): string {
  const source = iconAssetSource(`${ICONIFY_ORIGIN}/${id.replace(':', '/')}.svg`)
  if (!source) throw new Error('invalid Iconify icon id')
  return `${new URL(origin).origin}/a/iconify${source.pathname}`
}

/** Successful SVGs live beside other stored assets, in their own namespace.
 * Share concurrent requests; failed fetches are never cached and can be retried. */
export async function getIconAsset(source: URL): Promise<Buffer> {
  const canonical = iconAssetSource(source.href)
  if (!canonical) throw new Error('invalid Iconify SVG URL')
  const key = `icons/${createHash('sha256').update(canonical.href).digest('hex')}.svg`
  const cached = await storage.getObject(key)
  if (cached) return cached
  const pending = inflight.get(key)
  if (pending) return pending
  if (inflight.size >= MAX_PENDING_ICONS) throw new Error('icon service is busy; try again shortly')
  const task = loadIcon(key, canonical).finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

async function loadIcon(key: string, source: URL): Promise<Buffer> {
  const response = await fetchPinnedPublicUrl(source, { signal: AbortSignal.timeout(5_000), redirect: 'error' })
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/svg+xml')) {
    await response.body?.cancel()
    throw new Error(`icon fetch failed: HTTP ${response.status}`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty icon response')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_ICON_BYTES) throw new Error('icon response is too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const body = Buffer.concat(chunks)
  if (!/^\s*<svg\b/i.test(body.toString('utf8'))) throw new Error('invalid icon SVG')
  await storage.putObject(key, body, 'image/svg+xml')
  return body
}

export const iconAssetsRouter = Router()

iconAssetsRouter.get('/:prefix/:name.svg', async (req, res) => {
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
  const source = iconAssetSource(`${ICONIFY_ORIGIN}/${req.params.prefix}/${req.params.name}.svg${query}`)
  if (!source) {
    res.status(400).end()
    return
  }
  try {
    const body = await getIconAsset(source)
    res.set({
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
    res.send(body)
  } catch {
    res.set('Retry-After', '5').status(503).end()
  }
})
