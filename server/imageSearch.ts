/**
 * Image sourcing for design agents: stock photo search (Pexels) and icon /
 * brand-logo search (Iconify). Both power the search_images / search_icons
 * tools in mcp.ts and resident.ts.
 *
 * Photos come back with a tiny thumbnail the agent can SEE (returned as an
 * image block) plus a display-resolution URL to embed. Photo search needs
 * PEXELS_API_KEY; the Pexels license allows hotlinking, rehosting and
 * modification without attribution. Icon search is keyless: the Iconify API
 * indexes 200k+ open-source icons, including the simple-icons and logos
 * collections (brand marks), served as hotlinkable SVGs.
 */

const PEXELS_ENDPOINT = 'https://api.pexels.com/v1/search'
const ICONIFY_ENDPOINT = 'https://api.iconify.design'
const FETCH_TIMEOUT_MS = 15_000

export function photoSearchEnabled(): boolean {
  return Boolean(process.env.PEXELS_API_KEY)
}

export interface PhotoResult {
  /** Display-resolution CDN URL (~940px wide) — what goes in frame HTML. */
  image_url: string
  /** Small preview (~280px) used for the visual thumbnail. */
  thumb_url: string
  alt: string
  photographer: string
  width: number
  height: number
  avg_color: string
}

interface PexelsPhoto {
  width: number
  height: number
  photographer: string
  avg_color: string | null
  alt: string | null
  src: Record<string, string>
}

export type PhotoOrientation = 'landscape' | 'portrait' | 'square'

export async function searchPhotos(
  query: string,
  opts: { orientation?: PhotoOrientation; count?: number } = {},
): Promise<PhotoResult[]> {
  const key = process.env.PEXELS_API_KEY
  if (!key) throw new Error('photo search is not configured (PEXELS_API_KEY is not set)')
  const count = Math.max(1, Math.min(opts.count ?? 5, 8))
  const params = new URLSearchParams({ query, per_page: String(count) })
  if (opts.orientation) params.set('orientation', opts.orientation)
  const res = await fetch(`${PEXELS_ENDPOINT}?${params}`, {
    headers: { authorization: key },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`photo search failed: HTTP ${res.status}`)
  const body = (await res.json()) as { photos?: PexelsPhoto[] }
  return (body.photos ?? []).flatMap((p) => {
    const image_url = p.src?.large
    const thumb_url = p.src?.tiny
    if (!image_url || !thumb_url) return []
    return [
      {
        image_url,
        thumb_url,
        alt: p.alt || '',
        photographer: p.photographer,
        width: p.width,
        height: p.height,
        avg_color: p.avg_color || '',
      },
    ]
  })
}

/** Fetch a photo thumbnail for an image content block. Returns null on any
 *  failure — a missing preview should not sink the whole search result. */
export async function fetchThumb(url: string): Promise<{ data: string; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) return null
    return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mime }
  } catch {
    return null
  }
}

export interface IconResult {
  /** Iconify id, e.g. "mdi:home" or "logos:stripe". */
  id: string
  /** Hotlinkable SVG URL for frame HTML. */
  svg_url: string
}

export async function searchIcons(
  query: string,
  opts: { logos?: boolean; limit?: number } = {},
): Promise<IconResult[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 24, 48))
  const params = new URLSearchParams({ query, limit: String(Math.max(limit, 32)) })
  /* the logos + simple-icons collections are the brand marks */
  if (opts.logos) params.set('prefixes', 'logos,simple-icons')
  const res = await fetch(`${ICONIFY_ENDPOINT}/search?${params}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`icon search failed: HTTP ${res.status}`)
  const body = (await res.json()) as { icons?: string[] }
  return (body.icons ?? []).slice(0, limit).map((id) => {
    const [prefix, name] = id.split(':')
    return { id, svg_url: `${ICONIFY_ENDPOINT}/${prefix}/${name}.svg` }
  })
}

export const ICON_USAGE_NOTE =
  'Hotlink svg_url in <img src> or CSS. Monochrome icons render black by default — append ?color=%23<hex> (URL-encoded #) to recolor, and &height=<px> to size. For company/brand logos use search_logos instead.'

export function logoSearchEnabled(): boolean {
  return Boolean(process.env.BRANDFETCH_CLIENT_ID)
}

export interface LogoResult {
  name: string
  domain: string
  /** Hotlinkable Brandfetch Logo Link CDN URL — the company's current logo. */
  logo_url: string
  /** Small square icon rendition used for the visual thumbnail. */
  thumb_url: string
}

interface BrandfetchHit {
  name?: string
  domain?: string
  icon?: string
}

/** Company-logo search via the Brandfetch brand-search API + Logo Link CDN
 *  (the successor to the retired Clearbit logo API — free client ID, URLs
 *  designed for hotlinking). Empty when BRANDFETCH_CLIENT_ID is unset. */
export async function searchLogos(query: string, count = 5): Promise<LogoResult[]> {
  const clientId = process.env.BRANDFETCH_CLIENT_ID
  if (!clientId) return []
  const res = await fetch(`https://api.brandfetch.io/v2/search/${encodeURIComponent(query)}?c=${clientId}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`logo search failed: HTTP ${res.status}`)
  const body = (await res.json()) as BrandfetchHit[]
  return (Array.isArray(body) ? body : [])
    .filter((b) => b.domain)
    .slice(0, Math.max(1, Math.min(count, 8)))
    .map((b) => ({
      name: b.name || b.domain!,
      domain: b.domain!,
      logo_url: `https://cdn.brandfetch.io/${b.domain}?c=${clientId}`,
      thumb_url: b.icon || `https://cdn.brandfetch.io/${b.domain}/w/128/h/128?c=${clientId}`,
    }))
}

const DDG_ICON_ENDPOINT = 'https://icons.duckduckgo.com/ip3'

/** Keyless any-company fallback: the DuckDuckGo favicon service. Resolves the
 *  query to a domain (used directly if it looks like one, else <name>.com) and
 *  verifies the icon exists — DDG 404s for unknown domains. Favicons are small
 *  raster images (16–48px), so callers should render them small. */
export async function faviconLogos(query: string): Promise<LogoResult[]> {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  const wasDomain = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(q)
  const domain = wasDomain ? q : `${q.replace(/[^a-z0-9]/g, '')}.com`
  if (domain === '.com') return []
  const url = `${DDG_ICON_ENDPOINT}/${domain}.ico`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return []
    return [{ name: wasDomain ? domain : query.trim(), domain, logo_url: url, thumb_url: url }]
  } catch {
    return []
  }
}

/** The full logo lookup behind search_logos: Brandfetch when configured
 *  (high-res, searchable by name), DuckDuckGo favicons as the keyless
 *  any-company fallback, open-source vector marks alongside either way. */
export async function lookupLogos(
  query: string,
  count?: number,
): Promise<{ brands: LogoResult[]; vector: IconResult[] }> {
  const [brands, vector] = await Promise.all([
    (logoSearchEnabled() ? searchLogos(query, count).catch(() => [] as LogoResult[]) : Promise.resolve([])).then((b) =>
      b.length > 0 ? b : faviconLogos(query),
    ),
    searchIcons(query, { logos: true, limit: 6 }).catch(() => [] as IconResult[]),
  ])
  return { brands, vector }
}

export const LOGO_USAGE_NOTE =
  'Hotlink logo_url directly in <img src>. URLs from icons.duckduckgo.com are the company\'s favicon — a SMALL raster (16–48px): display at 32px or less (logo rows, avatars, list bullets) and never scale up; if the design needs a large logo, prefer a vector mark below or ask your human for a logo file. URLs from cdn.brandfetch.io are high-res and stay current if the brand rebrands; size with CSS (height + width: auto). Vector marks are open-source SVG: "logos:" ids are full-color, "simple-icons:" ids are monochrome glyphs that take ?color=%23<hex>.'
