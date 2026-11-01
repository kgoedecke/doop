/**
 * Live design inspiration for agents (roadmap 20): search One Page Love's
 * hand-curated catalog of single-page sites and get back real, live pages WITH
 * visual thumbnails plus their taxonomy — style, colour, typefaces, genre and
 * the sections the page is built from.
 *
 * Powers the search_inspiration tool in mcp.ts and resident.ts. Needs
 * ONEPAGELOVE_API_KEY (https://api.onepagelove.com/docs/); unset, the tool says
 * so instead of failing. Results are INSPIRATION to look at and adapt in a brief
 * — never imagery to embed in frames (the screenshots are other people's work).
 * One Page Love's terms ask that every surfaced result credits them and its
 * authors, so describeInspiration always carries both.
 */

import { env } from './env.ts'

const OPL_API = 'https://api.onepagelove.com/v1'
const FETCH_TIMEOUT_MS = 15_000
/** The free plan allows 1,000 requests a day; agents repeat the same archetype queries. */
const CACHE_TTL_MS = 6 * 60 * 60_000
const CACHE_MAX = 500
const FIELDS = 'title,slug,url,genre,color,style,typeface,sections,authors,screenshot,hero_copy'

/** Taxonomies /v1/inspirations filters on, in the order a zero-result query
 *  gives them up: the broadest go first, the look itself (style, colour) last. */
const RELAX_ORDER = ['platform', 'tech', 'genre', 'sections', 'typeface', 'color', 'style'] as const
type FilterTaxonomy = (typeof RELAX_ORDER)[number]

export interface InspirationResult {
  site: string
  /** The live site; null when One Page Love has marked it offline. */
  source_url: string | null
  /** One Page Love's page for the entry — the attribution link its terms require. */
  opl_url: string
  style: string[]
  color: string[]
  fonts: string[]
  genre: string[]
  sections: string[]
  /** Designers/studios credited for the page. */
  authors: string[]
  /** The hero's headline, when One Page Love extracted one. */
  headline: string | null
  /** 1280x800 hero crop used for the visual thumbnail block. */
  thumb_url: string
}

interface OplInspiration {
  title: string
  slug: string
  url: string | null
  genre?: string[]
  color?: string[]
  style?: string[]
  typeface?: string[]
  sections?: string[]
  authors?: string[]
  screenshot?: { hero?: string; thumbnail?: string }
  hero_copy?: { headline?: string }
}

interface OplSearch {
  matched_filters?: { taxonomy: string; slug: string }[]
  results?: { items?: OplInspiration[] }
}

export function inspirationSearchEnabled(): boolean {
  return Boolean(env.ONEPAGELOVE_API_KEY)
}

export const INSPIRATION_UNAVAILABLE_NOTE =
  'Inspiration search is not configured on this Doop instance. Write the brief from the canvas context and the design-quality principles, and say in the brief that no exemplar was available.'

const cache = new Map<string, { at: number; results: InspirationResult[] }>()
const inflight = new Map<string, Promise<InspirationResult[]>>()

/** Test seam: forget cached searches. */
export function clearInspirationCache(): void {
  cache.clear()
  inflight.clear()
}

async function oplGet<T>(path: string, params: URLSearchParams): Promise<T> {
  const key = env.ONEPAGELOVE_API_KEY
  if (!key) throw new Error('inspiration search is not configured (ONEPAGELOVE_API_KEY is not set)')
  const res = await fetch(`${OPL_API}${path}?${params}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 429) throw new Error('inspiration search is busy — try again in a minute')
  if (!res.ok) throw new Error(`inspiration search failed: HTTP ${res.status}`)
  return (await res.json()) as T
}

function toResult(s: OplInspiration): InspirationResult | null {
  /* f=auto keeps a PNG original as PNG (~700 KB at hero size); JPEG is a fifth of that */
  const thumb = (s.screenshot?.hero ?? s.screenshot?.thumbnail)?.replace(',f=auto,', ',f=jpeg,')
  if (!thumb) return null
  return {
    site: s.title.trim(),
    source_url: s.url,
    opl_url: `https://onepagelove.com/${s.slug}`,
    style: s.style ?? [],
    color: s.color ?? [],
    fonts: s.typeface ?? [],
    genre: s.genre ?? [],
    sections: s.sections ?? [],
    authors: s.authors ?? [],
    headline: s.hero_copy?.headline ?? null,
    thumb_url: thumb,
  }
}

/** One filter per taxonomy, from what /v1/search resolved the free text to. */
function filtersFrom(search: OplSearch): Map<FilterTaxonomy, string> {
  const filters = new Map<FilterTaxonomy, string>()
  for (const f of search.matched_filters ?? []) {
    const taxonomy = RELAX_ORDER.find((t) => t === f.taxonomy)
    if (taxonomy && !filters.has(taxonomy)) filters.set(taxonomy, f.slug)
  }
  return filters
}

/** /v1/search ANDs every term it recognises, so a descriptive query ("premium
 *  audio landing page, editorial industrial") often matches nothing. Re-ask
 *  /v1/inspirations (live sites, full taxonomy) with the resolved filters,
 *  dropping the broadest one at a time until something matches. */
async function browse(filters: Map<FilterTaxonomy, string>, take: number): Promise<OplInspiration[]> {
  const remaining = new Map(filters)
  while (remaining.size > 0) {
    const params = new URLSearchParams({ status: 'live', limit: String(take), fields: FIELDS })
    for (const [taxonomy, slug] of remaining) params.set(taxonomy, slug)
    const page = await oplGet<{ results?: OplInspiration[] }>('/inspirations', params)
    if (page.results?.length) return page.results
    const broadest = RELAX_ORDER.find((t) => remaining.has(t))
    if (broadest) remaining.delete(broadest)
  }
  return []
}

export async function searchInspiration(query: string, count = 4): Promise<InspirationResult[]> {
  const take = Math.max(1, Math.min(count, 6))
  const cacheKey = `${take}:${query.trim().toLowerCase()}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results
  /* parallel agents asking the same thing share one round trip, not one each */
  const pending = inflight.get(cacheKey)
  if (pending) return pending

  const search = lookUp(query, take)
    .then((results) => {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? '')
      cache.set(cacheKey, { at: Date.now(), results })
      return results
    })
    .finally(() => inflight.delete(cacheKey))
  inflight.set(cacheKey, search)
  return search
}

async function lookUp(query: string, take: number): Promise<InspirationResult[]> {
  const search = await oplGet<OplSearch>('/search', new URLSearchParams({ q: query, limit: String(take) }))
  const filters = filtersFrom(search)
  /* nothing filterable (a tag or title match only): the search's own hits are the answer */
  const found = filters.size > 0 ? await browse(filters, take) : (search.results?.items ?? [])
  return found
    .map(toResult)
    .filter((r): r is InspirationResult => r !== null)
    .slice(0, take)
}

export const INSPIRATION_USAGE_NOTE =
  'Study these pages closely — ground and accent discipline, type contrast, density, mood, what carries the hero. Pick the ONE that fits your brief best and follow it; do not blend several into a composite. Name it in the brief. Read its palette from the thumbnail. Do not embed these screenshots in a frame. Data from One Page Love (onepagelove.com): when you name an exemplar to a human, credit it with its One Page Love link.'

export const INSPIRATION_NO_MATCH_NOTE =
  'try the words the catalog is tagged with: a style (minimal, typographic, editorial, illustrative, brutalism, retro, 3d, gradients, luxury, bold, corporate), a colour (dark, light, blue, colorful…), a genre (saas, finance, portfolio, app, e-commerce, startup, agency…) or a section (pricing, testimonials, faq, how it works…)'

export function describeInspiration(r: InspirationResult, index: number): string {
  const facts = [
    r.style.length > 0 ? `style: ${r.style.join(', ')}` : null,
    r.color.length > 0 ? `colour: ${r.color.join(', ')}` : null,
    r.fonts.length > 0 ? `fonts: ${r.fonts.join(', ')}` : null,
    r.genre.length > 0 ? `genre: ${r.genre.join(', ')}` : null,
    r.sections.length > 0 ? `sections: ${r.sections.slice(0, 6).join(', ')}` : null,
    r.headline ? `hero headline: "${r.headline}"` : null,
    r.authors.length > 0 ? `designed by ${r.authors.join(', ')}` : null,
    `via One Page Love: ${r.opl_url}`,
  ].filter(Boolean)
  return `#${index + 1} — ${r.site} (${r.source_url ?? 'offline'})\n${facts.join('\n')}`
}
