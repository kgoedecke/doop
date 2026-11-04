/**
 * Web fonts: the open families the Design panel's font menu offers, served by
 * Google Fonts. Like a library font (shared/fonts.ts), one is used by naming
 * its family in CSS; the frame then carries the stylesheet link that loads it,
 * in one managed `<link data-doop-webfonts>`, so the canvas, screenshots, PDF
 * export and every collaborator's machine render the same glyphs at the same
 * metrics. `withWebFontLinks` adds that link; the browser runs it on its saves,
 * the server on every frame write, next to `withFontFaces`.
 *
 * Only roster families are ever linked: a frame that names some other family
 * gains no network dependency it did not ask for.
 */

import { decodeQuotes, usesFamily, type CustomFont } from './fonts.ts'

export const WEB_FONT_LINK_ATTR = 'data-doop-webfonts'

export const WEB_FONTS_ORIGIN = 'https://fonts.googleapis.com'

export type WebFontCategory = 'sans' | 'serif' | 'mono'

export interface WebFont {
  family: string
  category: WebFontCategory
  /** the css2 axis spec after the family name: every weight, italics where the family has them */
  axes: string
}

const VARIABLE = 'ital,wght@0,100..900;1,100..900'
const UPRIGHT = 'wght@100..900'

/** The menu, in the order it is shown: sans, then serif, then mono. */
export const WEB_FONTS: readonly WebFont[] = [
  { family: 'Inter', category: 'sans', axes: 'ital,opsz,wght@0,14..32,100..900;1,14..32,100..900' },
  { family: 'Geist', category: 'sans', axes: UPRIGHT },
  { family: 'Roboto', category: 'sans', axes: VARIABLE },
  { family: 'Open Sans', category: 'sans', axes: 'ital,wght@0,300..800;1,300..800' },
  { family: 'Lato', category: 'sans', axes: 'ital,wght@0,100;0,300;0,400;0,700;0,900;1,100;1,300;1,400;1,700;1,900' },
  { family: 'Manrope', category: 'sans', axes: 'wght@200..800' },
  { family: 'DM Sans', category: 'sans', axes: 'ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000' },
  { family: 'Space Grotesk', category: 'sans', axes: 'wght@300..700' },
  { family: 'Plus Jakarta Sans', category: 'sans', axes: 'ital,wght@0,200..800;1,200..800' },
  { family: 'Work Sans', category: 'sans', axes: VARIABLE },
  { family: 'Nunito', category: 'sans', axes: 'ital,wght@0,200..1000;1,200..1000' },
  {
    family: 'Poppins',
    category: 'sans',
    axes: 'ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900',
  },
  { family: 'Playfair Display', category: 'serif', axes: 'ital,wght@0,400..900;1,400..900' },
  { family: 'Lora', category: 'serif', axes: 'ital,wght@0,400..700;1,400..700' },
  {
    family: 'Merriweather',
    category: 'serif',
    axes: 'ital,opsz,wdth,wght@0,18..144,87..112,300..900;1,18..144,87..112,300..900',
  },
  { family: 'Source Serif 4', category: 'serif', axes: 'ital,opsz,wght@0,8..60,200..900;1,8..60,200..900' },
  { family: 'Fraunces', category: 'serif', axes: 'ital,opsz,wght@0,9..144,100..900;1,9..144,100..900' },
  { family: 'EB Garamond', category: 'serif', axes: 'ital,wght@0,400..800;1,400..800' },
  { family: 'JetBrains Mono', category: 'mono', axes: 'ital,wght@0,100..800;1,100..800' },
  {
    family: 'IBM Plex Mono',
    category: 'mono',
    axes: 'ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;1,100;1,200;1,300;1,400;1,500;1,600;1,700',
  },
  { family: 'Geist Mono', category: 'mono', axes: UPRIGHT },
  { family: 'Fira Code', category: 'mono', axes: 'wght@300..700' },
]

const GENERIC: Record<WebFontCategory, string> = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' }

export function webFontByFamily(family: string): WebFont | undefined {
  const key = family.trim().toLowerCase()
  return WEB_FONTS.find((font) => font.family.toLowerCase() === key)
}

/** A stack to write into `font-family`: the family, then its generic. */
export function webFontStack(font: WebFont): string {
  return `"${font.family}", ${GENERIC[font.category]}`
}

/** The css2 stylesheet URL loading the given roster fonts. */
export function webFontsUrl(fonts: readonly WebFont[]): string {
  const params = fonts.map((font) => `family=${font.family.replace(/ /g, '+')}:${font.axes}`).join('&')
  return `${WEB_FONTS_ORIGIN}/css2?${params}&display=swap`
}

const LINK_RE = new RegExp(`<link\\b[^>]*\\b${WEB_FONT_LINK_ATTR}\\b[^>]*>`, 'i')

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether the document already loads the family itself: a Google Fonts URL
 *  naming it, or an @font-face declaring it. */
function loadsFamily(html: string, family: string): boolean {
  const name = family.trim().split(/\s+/).map(escapeRegExp)
  const inUrl = new RegExp(
    `fonts\\.googleapis\\.com/[^"'\\s)]*family=${name.join('(?:\\+|%20| )')}(?=[:&"'\\s)]|$)`,
    'i',
  )
  const inFace = new RegExp(
    `@font-face\\s*\\{[^}]*font-family\\s*:\\s*["']?\\s*${name.join('\\s+')}\\s*["']?\\s*[;}]`,
    'i',
  )
  return inUrl.test(html) || inFace.test(html)
}

/** The roster families the link tag loads, from its href. A family that is
 *  not valid URL text (a hand-edited link with a broken escape) is no roster
 *  family, not a reason to refuse the document; the link is `damaged` and
 *  gets rewritten. */
function linkedFamilies(link: string): { fonts: WebFont[]; damaged: boolean } {
  const href = /href\s*=\s*["']([^"']*)["']/i.exec(link)?.[1] ?? ''
  let damaged = false
  const names = [...href.matchAll(/family=([^:&]+)/g)].flatMap((m) => {
    try {
      return [decodeURIComponent(m[1]!.replace(/\+/g, ' '))]
    } catch {
      damaged = true
      return []
    }
  })
  return { fonts: names.map(webFontByFamily).filter((font): font is WebFont => font !== undefined), damaged }
}

/**
 * The HTML with a stylesheet link for every roster family it names in CSS and
 * does not load itself, keeping the families the existing link already
 * carries. A family in the canvas's own library wins over the roster entry of
 * the same name, so the link drops a family the library gains, and goes when
 * none is left. Returns the input string itself when nothing changes.
 */
export function withWebFontLinks(
  html: string,
  library: readonly CustomFont[] = [],
  roster: readonly WebFont[] = WEB_FONTS,
): string {
  const existing = LINK_RE.exec(html)
  /* a style attribute carries a quoted family as &quot;…&quot; */
  const design = decodeQuotes(existing ? html.replace(LINK_RE, '') : html)
  const uploaded = new Set(library.map((font) => font.family.toLowerCase()))
  const { fonts: linked, damaged } = existing ? linkedFamilies(existing[0]) : { fonts: [], damaged: false }
  const wanted = roster.filter(
    (font) =>
      !uploaded.has(font.family.toLowerCase()) &&
      (linked.includes(font) || (usesFamily(design, font.family) && !loadsFamily(design, font.family))),
  )
  if (!wanted.length) return existing ? html.replace(LINK_RE, '') : html
  if (!damaged && wanted.length === linked.length && wanted.every((font) => linked.includes(font))) return html
  const href = webFontsUrl(wanted).replace(/&/g, '&amp;')
  const tag = `<link rel="stylesheet" ${WEB_FONT_LINK_ATTR} href="${href}">`
  if (existing) return `${html.slice(0, existing.index)}${tag}${html.slice(existing.index + existing[0].length)}`
  const headOpen = /<head\b[^>]*>/i.exec(html)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return `${html.slice(0, at)}${tag}${html.slice(at)}`
  }
  /* no <head>: the parser hoists a leading <link> into the one it makes */
  const htmlOpen = /<html\b[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html)
  const at = htmlOpen ? htmlOpen.index + htmlOpen[0].length : 0
  return `${html.slice(0, at)}${tag}${html.slice(at)}`
}

/** The roster as agents see it. */
export function webFontFamilies(): string[] {
  return WEB_FONTS.map((font) => font.family)
}

/** What an agent needs to know about the roster — one paragraph. */
export function webFontsBrief(): string {
  const groups = (['sans', 'serif', 'mono'] as const).map(
    (category) =>
      `${category}: ${WEB_FONTS.filter((font) => font.category === category)
        .map((font) => font.family)
        .join(', ')}`,
  )
  return (
    `Hosted fonts, which render identically for every viewer and in every export (${groups.join('; ')}): ` +
    `use one by naming it in CSS (font-family: "Family", sans-serif); Doop links it from Google Fonts by itself, ` +
    `so do not add the <link> yourself and keep the <link data-doop-webfonts> it adds. OS fonts such as Georgia, ` +
    `Verdana or Helvetica render differently on each machine and in exports; prefer these or the canvas's custom fonts.`
  )
}
