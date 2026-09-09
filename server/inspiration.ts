/**
 * Live design inspiration for agents (roadmap 20): search the Refero Styles
 * gallery (styles.refero.design) by category and get back real, curated
 * landing pages WITH visual thumbnails plus pre-distilled style facts — a
 * north-star mood line, a named palette, and the fonts in use.
 *
 * Powers the search_inspiration tool in mcp.ts and resident.ts. Keyless, same
 * API the validated scripts/refero-extract.ts pipeline uses. Results are
 * INSPIRATION to look at and adapt in a brief — never imagery to embed in
 * frames (the screenshots are other companies' copyrighted pages).
 */

const REFERO_ENDPOINT = 'https://styles.refero.design/api/styles/search'
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; doop-design-agent)' }
const FETCH_TIMEOUT_MS = 15_000

export interface InspirationResult {
  site: string
  /** The live site the style was captured from. */
  source_url: string
  /** Refero's detail page for the capture. */
  refero_url: string
  /** Pre-distilled one-line mood direction, e.g. "Editorial fintech on warm marble". */
  north_star: string | null
  color_scheme: string | null
  palette: { name: string; hex: string }[]
  fonts: string[]
  /** Small (~800px) jpg preview used for the visual thumbnail block. */
  thumb_url: string
}

interface ReferoStyle {
  id: string
  url: string
  siteName: string
  screenshotUrl: string | null
  thumbnailUrl: string | null
  previewVideoPosterUrl: string | null
  previewVideoDetailPosterUrl: string | null
  colorScheme: string | null
  colors: { name: string; hex: string }[] | null
  fonts: string[] | null
  northStar: string | null
}

export async function searchInspiration(query: string, count = 4): Promise<InspirationResult[]> {
  const take = Math.max(1, Math.min(count, 6))
  const res = await fetch(`${REFERO_ENDPOINT}?q=${encodeURIComponent(query)}`, {
    headers: UA,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`inspiration search failed: HTTP ${res.status}`)
  const body = (await res.json()) as { styles?: ReferoStyle[] }
  return (body.styles ?? [])
    .map((s) => ({ style: s, thumb: s.thumbnailUrl ?? s.previewVideoPosterUrl ?? s.screenshotUrl }))
    .filter((x): x is { style: ReferoStyle; thumb: string } => Boolean(x.thumb))
    .slice(0, take)
    .map(({ style: s, thumb }) => ({
      site: s.siteName,
      source_url: s.url,
      refero_url: `https://styles.refero.design/style/${s.id}`,
      north_star: s.northStar,
      color_scheme: s.colorScheme,
      palette: s.colors ?? [],
      fonts: s.fonts ?? [],
      thumb_url: thumb,
    }))
}

export const INSPIRATION_USAGE_NOTE =
  'Study these pages closely — ground and accent discipline, type contrast, density, mood, what carries the hero. Pick the ONE that fits your brief best and follow it; do not blend several into a composite. Name it in the brief. Do not embed these screenshots in a frame.'

export function describeInspiration(r: InspirationResult, index: number): string {
  const palette = r.palette.length > 0 ? r.palette.map((c) => `${c.hex} (${c.name})`).join(', ') : 'n/a'
  const facts = [
    r.north_star ? `north star: "${r.north_star}"` : null,
    `palette: ${palette}`,
    r.fonts.length > 0 ? `fonts: ${r.fonts.join(', ')}` : null,
    r.color_scheme ? `scheme: ${r.color_scheme}` : null,
  ].filter(Boolean)
  return `#${index + 1} — ${r.site} (${r.source_url})\n${facts.join('\n')}`
}
