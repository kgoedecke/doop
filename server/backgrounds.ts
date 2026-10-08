import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import sharp from 'sharp'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as storage from './storage.ts'
import * as voyage from './voyage.ts'

/**
 * Curated background library for hero sections, section bands and bento
 * tiles — the answer to "every agent landing page ships the same flat CSS
 * gradient". One row per image in the backgrounds table describes it:
 * tone, style, palette, mood tags, which slots it suits, and where copy can
 * sit. The bytes live in object storage under bg/<id>.webp (display) and
 * bg/<id>-t.webp (thumbnail) and are served from /bg/<file>.
 *
 * scripts/import-backgrounds.ts bulk-loads a folder; the create / update /
 * retag / delete functions below are what an admin surface would call when
 * one is added. A fresh instance seeds
 * itself from server/backgrounds.json when its table is empty — the rows
 * for the images doop.design hosts, so BACKGROUNDS_ORIGIN can borrow them.
 *
 * Search is a plain in-memory scorer over a cached copy of the table: a few
 * hundred entries do not need an index, and the cache is refreshed on every
 * write, so search stays synchronous and cheap.
 */

export const BACKGROUND_TONES = ['light', 'dark'] as const
export type BackgroundTone = (typeof BACKGROUND_TONES)[number]

export const BACKGROUND_STYLES = [
  'gradient',
  'glow',
  'mesh',
  'grain',
  'aurora',
  'neon',
  'landscape',
  'painterly',
  'geometric',
  'texture',
  'abstract',
] as const
export type BackgroundStyle = (typeof BACKGROUND_STYLES)[number]

export const BACKGROUND_SLOTS = ['hero', 'section', 'card'] as const
export type BackgroundSlot = (typeof BACKGROUND_SLOTS)[number]

export const TEXT_ZONES = ['left', 'right', 'center', 'top', 'bottom', 'anywhere', 'none'] as const
export type TextZone = (typeof TEXT_ZONES)[number]

/** What describes an image for search — the part a human or model fills in. */
export interface BackgroundTags {
  tone: BackgroundTone
  style: BackgroundStyle
  /** 2–4 dominant colors, #rrggbb */
  palette: string[]
  /** free-form mood / subject words: "warm", "sunset", "calm", "tech", … */
  tags: string[]
  slots: BackgroundSlot[]
  /** where copy can sit without fighting the image */
  text_zone: TextZone
  /** one sentence a designer would use to describe it */
  description: string
}

export interface BackgroundEntry extends BackgroundTags {
  id: string
  /** sha1 of the source file — re-uploads of the same image are skipped */
  source: string
  width: number
  height: number
  /** average color as #rrggbb */
  avg_color: string
  enabled: boolean
  created_at: number
  /** Voyage voyage-multimodal-3 multimodal embedding vector */
  embedding?: number[] | null
}

export interface BackgroundSearchOptions {
  tone?: BackgroundTone
  style?: BackgroundStyle
  slot?: BackgroundSlot
  count?: number
}

export interface BackgroundResult extends BackgroundEntry {
  image_url: string
  thumb_url: string
  /** ready-to-paste CSS for the slot the agent asked for */
  css: string
}

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024
const MIN_SOURCE_WIDTH = 1200
const DISPLAY_WIDTH = 1600
const THUMB_WIDTH = 320
const TAGGING_WIDTH = 768
const TAGGING_MODEL = 'claude-opus-5'

const SEED_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backgrounds.json')

/* ------------------------------------------------------------------ */
/* Catalog cache                                                        */
/* ------------------------------------------------------------------ */

let catalog: BackgroundEntry[] = []

function fromRow(row: typeof t.backgrounds.$inferSelect): BackgroundEntry {
  return {
    id: row.id,
    source: row.source,
    width: row.width,
    height: row.height,
    avg_color: row.avgColor,
    tone: row.tone as BackgroundTone,
    style: row.style as BackgroundStyle,
    palette: row.palette,
    tags: row.tags,
    slots: row.slots as BackgroundSlot[],
    text_zone: row.textZone as TextZone,
    description: row.description,
    enabled: row.enabled,
    created_at: row.createdAt,
    embedding: (row.embedding as number[] | null) ?? null,
  }
}

function toRow(entry: BackgroundEntry): typeof t.backgrounds.$inferInsert {
  return {
    id: entry.id,
    source: entry.source,
    width: entry.width,
    height: entry.height,
    avgColor: entry.avg_color,
    tone: entry.tone,
    style: entry.style,
    palette: entry.palette,
    tags: entry.tags,
    slots: entry.slots,
    textZone: entry.text_zone,
    description: entry.description,
    enabled: entry.enabled,
    createdAt: entry.created_at,
    embedding: entry.embedding ?? null,
  }
}

async function reload(): Promise<void> {
  const rows = await db.select().from(t.backgrounds)
  catalog = rows.map(fromRow).sort((a, b) => b.created_at - a.created_at)
}

/** Load the table into the cache; seed it from backgrounds.json when empty. */
export async function initBackgrounds(): Promise<void> {
  await reload()
  if (catalog.length > 0 || !existsSync(SEED_PATH)) return
  const seed = parseSeed(readFileSync(SEED_PATH, 'utf8'))
  if (seed.length === 0) return
  await db.insert(t.backgrounds).values(seed.map(toRow))
  await reload()
  console.log(`⟡ seeded ${seed.length} backgrounds`)
}

/** Seed rows are older catalog entries, so the fields added since are defaulted. */
export function parseSeed(json: string): BackgroundEntry[] {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) throw new Error('backgrounds.json must be an array')
  return (parsed as Partial<BackgroundEntry>[]).map((e, i) => ({
    enabled: true,
    created_at: Date.now() - (parsed.length - i),
    ...e,
  })) as BackgroundEntry[]
}

/** Test seam: replace the cache without touching the database. */
export function setCatalogForTests(entries: BackgroundEntry[]): void {
  catalog = entries
}

export function listBackgrounds(): BackgroundEntry[] {
  return catalog
}

export function backgroundsEnabled(): boolean {
  return catalog.some((e) => e.enabled)
}

/* ------------------------------------------------------------------ */
/* Storage keys and URLs                                                */
/* ------------------------------------------------------------------ */

/** Where the bytes are served from. Self-hosters without the library can
 *  point BACKGROUNDS_ORIGIN at an instance that has it. */
function origin(publicOrigin: string): string {
  return (process.env.BACKGROUNDS_ORIGIN || publicOrigin).replace(/\/$/, '')
}

export function displayKey(id: string): string {
  return `bg/${id}.webp`
}

export function thumbKey(id: string): string {
  return `bg/${id}-t.webp`
}

/** Storage key for a /bg/<file> request, or null when the name is not one we serve. */
export function keyForFile(file: string): string | null {
  const m = /^([A-Za-z0-9_-]+)(-t)?\.webp$/.exec(file)
  return m ? `bg/${m[1]}${m[2] ?? ''}.webp` : null
}

export function urlsFor(entry: Pick<BackgroundEntry, 'id'>, publicOrigin: string) {
  const base = origin(publicOrigin)
  return { image_url: `${base}/bg/${entry.id}.webp`, thumb_url: `${base}/bg/${entry.id}-t.webp` }
}

const REMOTE_THUMB_TIMEOUT_MS = 10_000

/** Thumbnail bytes for the agent-facing image block. Local storage when the
 *  instance holds the library; over HTTP from BACKGROUNDS_ORIGIN when it is
 *  borrowing another instance's bytes. Null on any failure — a missing
 *  preview should not sink the whole search result. */
export async function fetchThumb(id: string): Promise<{ data: string; mime: string } | null> {
  try {
    const remote = process.env.BACKGROUNDS_ORIGIN
    if (remote) {
      const res = await fetch(`${remote.replace(/\/$/, '')}/bg/${id}-t.webp`, {
        signal: AbortSignal.timeout(REMOTE_THUMB_TIMEOUT_MS),
      })
      if (!res.ok) return null
      return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: 'image/webp' }
    }
    const buf = await storage.getObject(thumbKey(id))
    return buf ? { data: buf.toString('base64'), mime: 'image/webp' } : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

/* Words that carry no signal for ranking — the catalog vocabulary is small
   enough that everything else is worth matching. */
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to', 'background', 'bg'])

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9#]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
}

/* Query words that mean a filter, so "dark hero glow" works without the
   caller spelling out tone/style/slot. */
const TONE_WORDS: Record<string, BackgroundTone> = { dark: 'dark', black: 'dark', light: 'light', white: 'light' }
const SLOT_WORDS: Record<string, BackgroundSlot> = {
  hero: 'hero',
  section: 'section',
  band: 'section',
  card: 'card',
  bento: 'card',
  tile: 'card',
}

/* Designer vocabulary → the words the catalog is tagged with. A query word
   that is not itself a tag still lands on its neighbours, at a lower weight
   than a direct hit. */
const SYNONYMS: Record<string, string[]> = {
  silver: ['grey', 'metallic', 'monochrome'],
  gray: ['grey', 'monochrome'],
  grey: ['monochrome', 'muted'],
  white: ['clean', 'minimal', 'soft'],
  cream: ['beige', 'warm', 'soft'],
  ivory: ['beige', 'soft'],
  black: ['dark', 'minimal'],
  minimal: ['clean', 'calm', 'subtle', 'minimal'],
  minimalist: ['clean', 'calm', 'minimal'],
  subtle: ['soft', 'calm', 'muted', 'minimal'],
  clean: ['minimal', 'calm', 'soft'],
  quiet: ['calm', 'soft', 'muted'],
  grid: ['geometric', 'lines', 'halftone', 'wireframe', 'mesh'],
  lines: ['geometric', 'neon', 'curve'],
  architectural: ['geometric', 'editorial', 'minimal', 'monochrome'],
  architecture: ['geometric', 'editorial', 'minimal'],
  grain: ['grain', 'texture', 'halftone', 'noise'],
  grainy: ['grain', 'texture', 'halftone'],
  noise: ['grain', 'texture'],
  film: ['grain', 'muted', 'cinematic'],
  fine: ['subtle', 'soft'],
  paper: ['texture', 'beige', 'soft'],
  fabric: ['texture', 'fabric'],
  stone: ['texture', 'grey', 'beige'],
  marble: ['texture', 'painterly', 'soft'],
  metal: ['metallic', 'grey', 'hardware'],
  chrome: ['metallic', 'grey', 'hardware'],
  glass: ['glass', 'curve', 'premium'],
  glow: ['glow', 'soft'],
  glowing: ['glow', 'neon'],
  gradient: ['gradient', 'mesh', 'glow', 'blur'],
  blur: ['blur', 'mesh', 'soft'],
  blurry: ['blur', 'mesh'],
  abstract: ['abstract', 'mesh', 'blur', 'glow'],
  space: ['space', 'stars', 'night', 'dark'],
  galaxy: ['space', 'stars', 'night'],
  nature: ['nature', 'meadow', 'hills', 'mountains'],
  sky: ['sky', 'clouds'],
  ocean: ['coast', 'beach', 'blue'],
  sea: ['coast', 'beach', 'blue'],
  fire: ['thermal', 'orange', 'energetic'],
  luxury: ['luxury', 'premium', 'gold'],
  luxurious: ['luxury', 'premium', 'gold'],
  premium: ['premium', 'luxury'],
  corporate: ['saas', 'fintech', 'premium', 'calm'],
  enterprise: ['saas', 'fintech', 'premium', 'calm'],
  startup: ['saas', 'tech', 'bold'],
  developer: ['developer', 'code', 'tech'],
  coding: ['developer', 'code', 'tech'],
  ai: ['ai', 'tech', 'purple', 'glow'],
  crypto: ['fintech', 'dark', 'neon', 'tech'],
  finance: ['fintech', 'premium', 'calm'],
  health: ['wellness', 'calm', 'soft'],
  medical: ['wellness', 'calm', 'clean'],
  fitness: ['energetic', 'bold', 'gaming'],
  kids: ['playful', 'bright', 'fresh'],
  fun: ['playful', 'bright', 'vivid'],
  vibrant: ['vivid', 'bold', 'saturated'],
  colorful: ['vivid', 'rainbow', 'colorful'],
  pastel: ['pastel', 'soft', 'pink', 'lavender'],
  purple: ['purple', 'violet', 'lavender'],
  violet: ['purple', 'violet'],
  red: ['red', 'coral', 'thermal'],
  yellow: ['yellow', 'gold', 'amber'],
  green: ['green', 'mint', 'lime'],
  blue: ['blue', 'cyan', 'navy', 'teal'],
  orange: ['orange', 'amber', 'peach', 'coral'],
  pink: ['pink', 'coral', 'magenta'],
  sunset: ['sunset', 'dusk', 'golden', 'warm'],
  sunrise: ['sunrise', 'golden', 'warm'],
  night: ['night', 'dark', 'stars'],
  moody: ['moody', 'dark', 'cinematic', 'muted'],
  dramatic: ['dramatic', 'epic', 'cinematic', 'bold'],
  cozy: ['warm', 'soft', 'calm'],
  retro: ['retro', 'halftone', 'stripes'],
  futuristic: ['tech', 'neon', 'ai', 'scifi'],
  '3d': ['3d', 'wireframe', 'terrain'],
}

function score(entry: BackgroundEntry, words: string[]): number {
  const haystack = new Set([...entry.tags, entry.style, ...tokens(entry.description)])
  let hits = 0
  for (const w of words) {
    if (haystack.has(w)) hits += 2
    else if (entry.style.startsWith(w) || [...haystack].some((h) => h.startsWith(w) && w.length >= 4)) hits += 1
    else if ((SYNONYMS[w] ?? []).some((syn) => haystack.has(syn))) hits += 1
  }
  return hits
}

export interface BackgroundListing {
  results: BackgroundResult[]
  /** enabled images that passed the filters, before the count cap */
  total: number
  /** true when the query hint actually matched something in the ordering */
  hinted: boolean
}

export interface BrowseOptions extends BackgroundSearchOptions {
  /** optional mood / palette words that bias the order; never a filter */
  query?: string
}

const DEFAULT_COUNT = 12
const MAX_COUNT = 24

/* Words in the query that name a tone, style or slot are hints, not
   filters: "white grain grid" should still surface a light textured image
   when the library has no grain-styled one. Only the explicit options filter. */
function hints(words: string[]) {
  return {
    tone: words.map((w) => TONE_WORDS[w]).find(Boolean),
    style: words.find((w): w is BackgroundStyle => (BACKGROUND_STYLES as readonly string[]).includes(w)),
    slot: words.map((w) => SLOT_WORDS[w]).find(Boolean),
  }
}

/* Interleave entries by style so a page of results shows the breadth of the
   library rather than twelve variations of one look. Stable within a style. */
function spreadByStyle(entries: BackgroundEntry[]): BackgroundEntry[] {
  const byStyle = new Map<BackgroundStyle, BackgroundEntry[]>()
  for (const e of entries) byStyle.set(e.style, [...(byStyle.get(e.style) ?? []), e])
  const lanes = [...byStyle.values()]
  const out: BackgroundEntry[] = []
  for (let i = 0; out.length < entries.length; i++) {
    for (const lane of lanes) {
      const next = lane[i]
      if (next) out.push(next)
    }
  }
  return out
}

/** A page of the library for the agent to judge by eye. Explicit filters
 *  narrow; query words only reorder; matched entries lead, the rest are
 *  spread across styles. Never empty unless a filter excludes everything. */
export function browseBackgrounds(opts: BrowseOptions, publicOrigin: string): BackgroundListing {
  const count = Math.max(1, Math.min(opts.count ?? DEFAULT_COUNT, MAX_COUNT))
  const words = tokens(opts.query ?? '')
  const hint = hints(words)
  const slotForCss = opts.slot ?? hint.slot

  const pool = catalog
    .filter((e) => e.enabled)
    .filter(
      (e) =>
        (!opts.tone || e.tone === opts.tone) &&
        (!opts.style || e.style === opts.style) &&
        (!opts.slot || e.slots.includes(opts.slot)),
    )
  const scored = pool.map((entry) => {
    const matched = score(entry, words)
    const boost =
      (hint.tone && entry.tone === hint.tone ? 2 : 0) +
      (hint.style && entry.style === hint.style ? 3 : 0) +
      (hint.slot && entry.slots.includes(hint.slot) ? 1 : 0)
    return { entry, matched, score: matched + boost }
  })
  /* a tone or slot word alone ("white", "hero") is not a match — only tags,
     description words or a style are */
  const hinted = words.length > 0 && scored.some(({ matched }) => matched > 0)

  const lead = scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry)
  const rest = spreadByStyle(scored.filter(({ score }) => score === 0).map(({ entry }) => entry))
  const picked = [...spreadByStyle(lead.slice(0, count)), ...rest].slice(0, count)

  const results = picked.map((entry) => {
    const urls = urlsFor(entry, publicOrigin)
    return { ...entry, ...urls, css: cssFor(entry, urls.image_url, slotForCss ?? entry.slots[0] ?? 'hero') }
  })
  return { results, total: pool.length, hinted }
}

/** A scrim keeps copy legible: light images get a white veil, dark ones a
 *  black one, fading toward the side the text sits on. */
function cssFor(entry: BackgroundEntry, url: string, slot: BackgroundSlot): string {
  const veil = entry.tone === 'dark' ? '0,0,0' : '255,255,255'
  const direction =
    entry.text_zone === 'left'
      ? 'to right'
      : entry.text_zone === 'right'
        ? 'to left'
        : entry.text_zone === 'bottom'
          ? 'to top'
          : 'to bottom'
  const strength = slot === 'card' ? '.25' : '.45'
  return `background: linear-gradient(${direction}, rgba(${veil},${strength}), rgba(${veil},0) 70%), url("${url}") center/cover no-repeat;`
}

/** First line of a tool result: what the agent is looking at and how to use it. */
export function listHeadline(listing: BackgroundListing, query?: string): string {
  const shown = `${listing.results.length} of ${listing.total} backgrounds`
  const order = query
    ? listing.hinted
      ? `ordered with the closest matches for "${query}" first, then a spread of other looks`
      : `nothing is tagged for "${query}", so this is a spread across the library's looks`
    : "a spread across the library's looks"
  return `${shown} — ${order}. Thumbnails below. Judge each by eye against the frame's style and palette; pick one only if it genuinely serves the design, otherwise draw the background yourself in CSS or SVG.`
}

export function describeBackground(r: BackgroundResult, index: number): string {
  return [
    `#${index + 1} — ${r.description}`,
    `style: ${r.style} · tone: ${r.tone} · palette: ${r.palette.join(' ')} · text sits: ${r.text_zone} · fits: ${r.slots.join(', ')}`,
    `tags: ${r.tags.join(', ')}`,
    `image_url: ${r.image_url}`,
    `css: ${r.css}`,
  ].join('\n')
}

export const BACKGROUND_USAGE_NOTE =
  'Use the css line as-is on the section (it includes a scrim so copy stays readable), or set image_url as background-image with your own overlay. Put the headline in the text_zone; keep the busiest part of the image away from copy. For a bento tile use one image per tile at most and keep the rest flat. Match the frame palette: pick by the palette hexes, not the thumbnail alone.'

/* ------------------------------------------------------------------ */
/* Writes: upload, tag, edit, delete                                    */
/* ------------------------------------------------------------------ */

function toHex(n: number): string {
  return Math.round(n).toString(16).padStart(2, '0')
}

export interface PreparedImage {
  source: string
  width: number
  height: number
  avg_color: string
  display: Buffer
  thumb: Buffer
  /** mid-size jpeg for the tagging model */
  tagging: Buffer
}

/** Decode, re-encode and measure an uploaded image. Throws on anything that
 *  is not a usable background (too small, not an image). */
export async function prepareImage(bytes: Buffer): Promise<PreparedImage> {
  if (bytes.length === 0) throw new Error('empty file')
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('file exceeds the 40 MB limit')
  const source = createHash('sha1').update(bytes).digest('hex')
  const image = sharp(bytes, { failOn: 'none' }).rotate()
  const meta = await image.metadata().catch(() => {
    throw new Error('not an image')
  })
  if (!meta.width || !meta.height) throw new Error('not an image')
  if (meta.width < MIN_SOURCE_WIDTH)
    throw new Error(`image is ${meta.width}px wide — backgrounds need at least ${MIN_SOURCE_WIDTH}px`)
  const display = await image
    .clone()
    .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer()
  const displayMeta = await sharp(display).metadata()
  const thumb = await image.clone().resize({ width: THUMB_WIDTH }).webp({ quality: 70 }).toBuffer()
  const tagging = await image.clone().resize({ width: TAGGING_WIDTH }).jpeg({ quality: 80 }).toBuffer()
  const { channels } = await image.clone().stats()
  const [r = 0, g = 0, b = 0] = channels.map((c) => c.mean)
  return {
    source,
    width: displayMeta.width ?? DISPLAY_WIDTH,
    height: displayMeta.height ?? 0,
    avg_color: `#${toHex(r)}${toHex(g)}${toHex(b)}`,
    display,
    thumb,
    tagging,
  }
}

const TAG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tone', 'style', 'palette', 'tags', 'slots', 'text_zone', 'description'],
  properties: {
    tone: { type: 'string', enum: [...BACKGROUND_TONES] },
    style: { type: 'string', enum: [...BACKGROUND_STYLES] },
    palette: { type: 'array', items: { type: 'string', pattern: '^#[0-9a-f]{6}$' }, minItems: 2, maxItems: 4 },
    tags: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 10 },
    slots: { type: 'array', items: { type: 'string', enum: [...BACKGROUND_SLOTS] }, minItems: 1 },
    text_zone: { type: 'string', enum: [...TEXT_ZONES] },
    description: { type: 'string' },
  },
} as const

const TAGGING_PROMPT = `You are cataloguing a background image for a design tool. Designers will search this catalog by mood and palette when they need a hero, section band or bento-tile background, then place headline copy on it.

Describe the image for that search:
- tone: "dark" if light copy would read best on it, "light" if dark copy would. Judge the area where text would sit, not the whole image.
- style: the single closest look. gradient = smooth color blend; glow = a soft light source on a plain field; mesh = multi-point blurred color blobs; grain = visibly noisy/grainy blend; aurora = flowing ribbons of light; neon = saturated glowing lines or fire on dark; landscape = a scene with horizon, terrain or sky; painterly = brush/paint texture; geometric = shapes or grids; texture = paper, fabric, stone; abstract = none of these.
- palette: 2–4 dominant colors as lowercase #rrggbb.
- tags: 4–10 lowercase single words a designer would type: color names ("teal", "coral"), mood ("calm", "energetic", "premium", "playful"), temperature ("warm", "cool"), subjects ("sunset", "clouds", "mountains"), and industries it suits ("saas", "fintech", "wellness", "gaming"). No hashtags, no duplicates of tone or style.
- slots: which of hero (wide, quiet enough for a headline), section (a band behind a row of content), card (small tile, strong focal point still reads when cropped) it suits. Most images suit several.
- text_zone: the region where a headline would sit cleanly — left, right, center, top, bottom, anywhere (uniformly quiet), or none (too busy everywhere).
- description: one plain sentence, under 20 words, as a designer would say it ("Soft teal aurora ribbon drifting across a near-black field").`

export function taggingEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

/** Ask the model to describe an image. Throws when tagging is off or refused. */
export async function tagWithModel(jpeg: Buffer): Promise<BackgroundTags> {
  if (!taggingEnabled()) throw new Error('auto-tagging is off (ANTHROPIC_API_KEY is not set)')
  const client = new Anthropic()
  const response = await client.beta.messages.create({
    model: TAGGING_MODEL,
    max_tokens: 2048,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: TAG_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: TAGGING_PROMPT },
        ],
      },
    ],
  })
  if (response.stop_reason === 'refusal') throw new Error('the model declined to describe this image')
  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('no text in tagging response')
  return normalizeTags(JSON.parse(block.text))
}

/** Placeholder tags for an upload nobody has described yet: searchable by
 *  filter only, and disabled until someone fills them in. */
export function blankTags(prepared: Pick<PreparedImage, 'avg_color'>): BackgroundTags {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(prepared.avg_color.slice(i, i + 2), 16))
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return {
    tone: luminance > 0.5 ? 'light' : 'dark',
    style: 'abstract',
    palette: [prepared.avg_color],
    tags: [],
    slots: ['hero', 'section', 'card'],
    text_zone: 'anywhere',
    description: '',
  }
}

const HEX = /^#[0-9a-f]{6}$/

/** Validate a tag payload from the admin UI or the model; throws on bad values. */
export function normalizeTags(input: unknown): BackgroundTags {
  const raw = (input ?? {}) as Record<string, unknown>
  const oneOf = <T extends string>(list: readonly T[], v: unknown, field: string): T => {
    if (!list.includes(v as T)) throw new Error(`${field} must be one of ${list.join(', ')}`)
    return v as T
  }
  const words = (v: unknown): string[] =>
    (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [])
      .map((w) => String(w).toLowerCase().trim())
      .filter(Boolean)
  const palette = words(raw.palette).filter((h) => HEX.test(h))
  if (palette.length === 0) throw new Error('palette needs at least one #rrggbb color')
  const slots = [...new Set(words(raw.slots))].map((s) => oneOf(BACKGROUND_SLOTS, s, 'slots'))
  if (slots.length === 0) throw new Error('slots needs at least one of hero, section, card')
  return {
    tone: oneOf(BACKGROUND_TONES, raw.tone, 'tone'),
    style: oneOf(BACKGROUND_STYLES, raw.style, 'style'),
    palette: palette.slice(0, 4),
    tags: [...new Set(words(raw.tags))].slice(0, 12),
    slots,
    text_zone: oneOf(TEXT_ZONES, raw.text_zone, 'text_zone'),
    description: String(raw.description ?? '').trim(),
  }
}

export interface CreateOptions {
  /** Pre-made tags; when absent the model is asked, and if that is not
   *  possible the row starts disabled with blank tags. */
  tags?: BackgroundTags
  /** Skip the model even when it is available. */
  skipModel?: boolean
}

export type CreateOutcome =
  | { status: 'created'; entry: BackgroundEntry; tagged: 'given' | 'model' | 'none'; error?: string }
  | { status: 'duplicate'; entry: BackgroundEntry }

/** Ingest one image: bytes → storage objects + row. Duplicate sources are
 *  reported, not re-added. */
export async function createBackground(bytes: Buffer, opts: CreateOptions = {}): Promise<CreateOutcome> {
  const prepared = await prepareImage(bytes)
  const existing = catalog.find((e) => e.source === prepared.source)
  if (existing) return { status: 'duplicate', entry: existing }

  let tags = opts.tags
  let tagged: 'given' | 'model' | 'none' = tags ? 'given' : 'none'
  let error: string | undefined
  if (!tags && !opts.skipModel && taggingEnabled()) {
    try {
      tags = await tagWithModel(prepared.tagging)
      tagged = 'model'
    } catch (e) {
      error = e instanceof Error ? e.message : 'tagging failed'
    }
  }
  let embedding: number[] | null = null
  if (voyage.embeddingEnabled()) {
    try {
      embedding = await voyage.embedImage(prepared.tagging)
    } catch (e) {
      console.warn(`[backgrounds] embedding failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  const entry: BackgroundEntry = {
    id: nanoid(10),
    source: prepared.source,
    width: prepared.width,
    height: prepared.height,
    avg_color: prepared.avg_color,
    ...(tags ?? blankTags(prepared)),
    enabled: Boolean(tags),
    created_at: Date.now(),
    embedding,
  }
  /* objects first, row second: an orphaned object is harmless, a row
     without bytes would serve 404s */
  await storage.putObject(displayKey(entry.id), prepared.display, 'image/webp')
  await storage.putObject(thumbKey(entry.id), prepared.thumb, 'image/webp')
  await db.insert(t.backgrounds).values(toRow(entry))
  await reload()
  return { status: 'created', entry, tagged, error }
}

export async function updateBackground(
  id: string,
  patch: Partial<BackgroundTags> & { enabled?: boolean; embedding?: number[] | null },
): Promise<BackgroundEntry | null> {
  const current = catalog.find((e) => e.id === id)
  if (!current) return null
  const tags = normalizeTags({ ...current, ...patch })
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled
  const embedding = patch.embedding !== undefined ? patch.embedding : current.embedding
  await db
    .update(t.backgrounds)
    .set(toRow({ ...current, ...tags, enabled, embedding }))
    .where(eq(t.backgrounds.id, id))
  await reload()
  return catalog.find((e) => e.id === id) ?? null
}

/** Re-run the model on a stored image and save what it says. */
export async function retagBackground(id: string): Promise<BackgroundEntry | null> {
  const current = catalog.find((e) => e.id === id)
  if (!current) return null
  const display = await storage.getObject(displayKey(id))
  if (!display) throw new Error('image bytes are missing from storage')
  const jpeg = await sharp(display).resize({ width: TAGGING_WIDTH }).jpeg({ quality: 80 }).toBuffer()
  const tags = await tagWithModel(jpeg)
  let embedding: number[] | null = current.embedding ?? null
  if (voyage.embeddingEnabled()) {
    try {
      embedding = (await voyage.embedImage(jpeg)) ?? embedding
    } catch {
      /* non-fatal */
    }
  }
  return updateBackground(id, { ...tags, enabled: true, embedding })
}

export async function deleteBackground(id: string): Promise<boolean> {
  if (!catalog.some((e) => e.id === id)) return false
  await db.delete(t.backgrounds).where(eq(t.backgrounds.id, id))
  await reload()
  await Promise.all([storage.deleteObject(displayKey(id)), storage.deleteObject(thumbKey(id))])
  return true
}
