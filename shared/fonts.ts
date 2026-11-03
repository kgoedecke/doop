/**
 * Custom fonts: font files uploaded to a library (a workspace's, or a
 * person's own for their personal canvases) and used in frames by family
 * name. A frame stays self-contained: the @font-face rules for the library
 * families it uses live in its own HTML, in one managed
 * `<style data-doop-fonts>` block, so every renderer that reads frame HTML
 * (the canvas, screenshots, PDF/PSD/Figma export, the iOS app) gets the font
 * without knowing about libraries. `withFontFaces` adds that block; the
 * browser runs it on its saves, the server on every frame write.
 */

export const FONT_BLOCK_ATTR = 'data-doop-fonts'

export const FONT_FORMATS = ['woff2', 'woff', 'truetype', 'opentype'] as const
export type FontFormat = (typeof FONT_FORMATS)[number]

export type FontStyle = 'normal' | 'italic'

/** One uploaded font file: a single face, or a variable font's weight range. */
export interface CustomFont {
  id: string
  family: string
  /** a CSS font-weight: `400`, or `100 900` for a variable font */
  weight: string
  style: FontStyle
  format: FontFormat
  /** the immutable /a/ asset URL the face loads from */
  url: string
  fileName: string
  size: number
  createdAt: number
}

/** Where a library lives: a workspace's, or the signed-in person's own. */
export type FontScope = { workspaceId: string } | { personal: true }

export const MAX_FONT_BYTES = 10 * 1024 * 1024

function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&').replace(/[\n\r<>]/g, '')}"`
}

/** The @font-face rule for one library file. */
export function fontFaceRule(font: Pick<CustomFont, 'family' | 'weight' | 'style' | 'format' | 'url'>): string {
  return (
    `@font-face{font-family:${cssString(font.family)};` +
    `src:url(${cssString(font.url)}) format("${font.format}");` +
    `font-weight:${font.weight};font-style:${font.style};font-display:swap}`
  )
}

/** A family stack to write into `font-family`, with a generic fallback. */
export function fontStack(family: string): string {
  return `${cssString(family)}, sans-serif`
}

const BLOCK_RE = new RegExp(`<style\\b[^>]*\\b${FONT_BLOCK_ATTR}\\b[^>]*>([\\s\\S]*?)</style>`, 'i')

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Entity-encoded quotes are how a style attribute carries a quoted family. */
export function decodeQuotes(html: string): string {
  return html.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;|&apos;/gi, "'")
}

/** Whether the HTML names a family in CSS: quoted, or bare as a whole value
 *  item — after `font-family:`, a comma in a stack, the size in a `font:`
 *  shorthand, or a custom property's colon — wherever it ends at a CSS
 *  delimiter. Erring wide is cheap: a face that is declared but unused is
 *  never downloaded, while a missed one renders the fallback. */
export function usesFamily(html: string, family: string): boolean {
  /* CSS treats any run of whitespace inside a bare family name as one space */
  const name = family.trim().split(/\s+/).map(escapeRegExp).join('\\s+')
  const quoted = new RegExp(`(["'])\\s*${name}\\s*\\1`, 'i')
  const bare = new RegExp(`(?<![\\w-])${name}(?![\\w-])\\s*(?=[,;}"'!]|$)`, 'im')
  return quoted.test(html) || bare.test(html)
}

/**
 * The HTML with @font-face rules for every library font whose family it
 * uses and that it does not already load (its URL appears nowhere in the
 * document). Only ever adds: a face whose font has since left the library
 * keeps rendering, since its asset is immutable. Returns the input string
 * itself when nothing is missing, so callers can compare by identity.
 */
export function withFontFaces(html: string, library: readonly CustomFont[]): string {
  if (!library.length) return html
  const decoded = decodeQuotes(html)
  const block = BLOCK_RE.exec(html)
  /* our own rules name every family; scan the design without them */
  const design = block ? decoded.replace(BLOCK_RE, '') : decoded
  const used = new Map<string, boolean>()
  const missing = library.filter((font) => {
    if (html.includes(font.url)) return false
    const key = font.family.toLowerCase()
    if (!used.has(key)) used.set(key, usesFamily(design, font.family))
    return used.get(key)
  })
  if (!missing.length) return html
  const rules = missing.map(fontFaceRule).join('\n')
  if (block) {
    const end = block.index + block[0].length - '</style>'.length
    return `${html.slice(0, end)}${block[1]?.endsWith('\n') ? '' : '\n'}${rules}\n${html.slice(end)}`
  }
  const tag = `<style ${FONT_BLOCK_ATTR}>\n${rules}\n</style>`
  const headOpen = /<head\b[^>]*>/i.exec(html)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return `${html.slice(0, at)}${tag}${html.slice(at)}`
  }
  /* no <head>: the parser hoists a leading <style> into the one it makes */
  const htmlOpen = /<html\b[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html)
  const at = htmlOpen ? htmlOpen.index + htmlOpen[0].length : 0
  return `${html.slice(0, at)}${tag}${html.slice(at)}`
}

/** Families in a library, each once, in the order they were first uploaded. */
export function libraryFamilies(library: readonly CustomFont[]): string[] {
  const seen = new Map<string, string>()
  for (const font of [...library].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = font.family.toLowerCase()
    if (!seen.has(key)) seen.set(key, font.family)
  }
  return [...seen.values()]
}

/** "Regular", "Bold Italic", "100–900" — how a face reads in a list. */
export function faceLabel(font: Pick<CustomFont, 'weight' | 'style'>): string {
  const names: Record<string, string> = {
    '100': 'Thin',
    '200': 'ExtraLight',
    '300': 'Light',
    '400': 'Regular',
    '500': 'Medium',
    '600': 'SemiBold',
    '700': 'Bold',
    '800': 'ExtraBold',
    '900': 'Black',
  }
  const weight = font.weight.includes(' ')
    ? `Variable ${font.weight.replace(' ', '–')}`
    : (names[font.weight] ?? font.weight)
  if (font.style !== 'italic') return weight
  return weight === 'Regular' ? 'Italic' : `${weight} Italic`
}

/** The library as agents see it: each family once, with the faces it has. */
export function describeLibrary(library: readonly CustomFont[]): { family: string; faces: string[] }[] {
  return libraryFamilies(library).map((family) => ({
    family,
    faces: library
      .filter((font) => font.family.toLowerCase() === family.toLowerCase())
      .map((font) => (font.style === 'italic' ? `${font.weight} italic` : font.weight)),
  }))
}

/** What an agent needs to design with the library — one paragraph. */
export function libraryBrief(library: readonly CustomFont[]): string {
  if (!library.length) return ''
  const families = describeLibrary(library)
    .map(({ family, faces }) => `"${family}" (${faces.join(', ')})`)
    .join('; ')
  return (
    `This canvas has custom fonts uploaded by its team: ${families}. Prefer them for type — they are the brand's. ` +
    `Use one by naming it in CSS (font-family: "Family", sans-serif — a custom property works too); Doop adds the ` +
    `@font-face rules to the frame by itself. Do not load these families from Google Fonts or write their ` +
    `@font-face yourself, and keep the <style data-doop-fonts> block Doop adds. Stick to the weights listed.`
  )
}

/** The weights a library family really has, as the weight menu offers them:
 *  each static face's, and every hundred inside a variable face's range.
 *  Null when the family is not in the library, so the menu keeps its full
 *  scale for fonts it knows nothing about. */
export function familyWeights(library: readonly CustomFont[], family: string): string[] | null {
  const faces = library.filter((font) => font.family.toLowerCase() === family.trim().toLowerCase())
  if (!faces.length) return null
  const weights = new Set<number>()
  for (const { weight } of faces) {
    const [min = 400, max = min] = weight.split(' ').map(Number)
    weights.add(min)
    weights.add(max)
    for (let w = Math.ceil(min / 100) * 100; w <= max; w += 100) weights.add(w)
  }
  return [...weights].sort((a, b) => a - b).map(String)
}
