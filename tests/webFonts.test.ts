import { describe, expect, it } from 'vitest'
import type { CustomFont } from '../shared/fonts.ts'
import {
  WEB_FONTS,
  WEB_FONT_LINK_ATTR,
  webFontByFamily,
  webFontStack,
  webFontsBrief,
  webFontsUrl,
  withWebFontLinks,
} from '../shared/webFonts.ts'

const INTER = webFontByFamily('Inter')!
const LORA = webFontByFamily('Lora')!

const uploaded: CustomFont = {
  id: 'f1',
  family: 'Inter',
  weight: '400',
  style: 'normal',
  format: 'woff2',
  url: 'https://doop.test/a/inter.woff2',
  fileName: 'inter.woff2',
  size: 1,
  createdAt: 1,
}

function linkOf(html: string): string {
  return new RegExp(`<link[^>]*${WEB_FONT_LINK_ATTR}[^>]*>`).exec(html)?.[0] ?? ''
}

describe('the roster', () => {
  it('names each family once and writes a stack with the right generic', () => {
    const names = WEB_FONTS.map((font) => font.family.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
    expect(webFontStack(INTER)).toBe('"Inter", sans-serif')
    expect(webFontStack(LORA)).toBe('"Lora", serif')
    expect(webFontStack(webFontByFamily('JetBrains Mono')!)).toBe('"JetBrains Mono", monospace')
  })

  it('builds one css2 URL for several families', () => {
    const url = webFontsUrl([INTER, webFontByFamily('Space Grotesk')!])
    expect(url.startsWith('https://fonts.googleapis.com/css2?family=Inter:')).toBe(true)
    expect(url).toContain('&family=Space+Grotesk:wght@300..700')
    expect(url.endsWith('&display=swap')).toBe(true)
  })

  it('briefs agents with every family', () => {
    for (const font of WEB_FONTS) expect(webFontsBrief()).toContain(font.family)
  })
})

describe('withWebFontLinks', () => {
  const DESIGN = `<!doctype html><html><head><title>x</title></head><body><h1 style="font-family: Inter, sans-serif">Hi</h1></body></html>`

  it('links a roster family the design names, in the head', () => {
    const html = withWebFontLinks(DESIGN)
    const link = linkOf(html)
    expect(link).toContain('family=Inter:')
    expect(link).toContain('rel="stylesheet"')
    expect(html.indexOf(link)).toBeLessThan(html.indexOf('<title>'))
  })

  it('returns the very same string when nothing roster-named is used', () => {
    const plain = DESIGN.replace('Inter', 'Georgia')
    expect(withWebFontLinks(plain)).toBe(plain)
    expect(withWebFontLinks(withWebFontLinks(DESIGN))).toBe(withWebFontLinks(DESIGN))
  })

  it('does not link a family the design loads itself', () => {
    const own = DESIGN.replace(
      '<head>',
      '<head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap">',
    )
    expect(withWebFontLinks(own)).toBe(own)
    const face = DESIGN.replace('<head>', '<head><style>@font-face{font-family:"Inter";src:url(/a/i.woff2)}</style>')
    expect(withWebFontLinks(face)).toBe(face)
  })

  it('does not take Geist for Geist Mono', () => {
    const own = DESIGN.replace('Inter', 'Geist').replace(
      '<head>',
      '<head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900">',
    )
    expect(linkOf(withWebFontLinks(own))).toContain('family=Geist:')
  })

  it('leaves a family to the canvas library when both have it, and drops it from a link already there', () => {
    expect(withWebFontLinks(DESIGN, [uploaded])).toBe(DESIGN)
    /* a frame saved with hosted Inter, then the team uploads an Inter of its own */
    const linked = withWebFontLinks(DESIGN)
    expect(withWebFontLinks(linked, [uploaded])).toBe(DESIGN)
    const two = withWebFontLinks(DESIGN.replace('Hi</h1>', 'Hi</h1><p style="font-family:Lora">x</p>'))
    const link = linkOf(withWebFontLinks(two, [uploaded]))
    expect(link).toContain('family=Lora:')
    expect(link).not.toContain('family=Inter:')
  })

  it('finds a family the editor saved with entity-encoded quotes', () => {
    const saved = DESIGN.replace(
      'font-family: Inter, sans-serif',
      'font-family: &quot;Plus Jakarta Sans&quot;, sans-serif',
    )
    expect(linkOf(withWebFontLinks(saved))).toContain('family=Plus+Jakarta+Sans:')
    expect(withWebFontLinks(saved)).toContain('&quot;Plus Jakarta Sans&quot;')
  })

  it('grows the one link when another family comes into use, and keeps families that left', () => {
    const first = withWebFontLinks(DESIGN)
    const second = withWebFontLinks(first.replace('Hi</h1>', 'Hi</h1><p style="font-family:\'Lora\'">x</p>'))
    expect(second.match(new RegExp(WEB_FONT_LINK_ATTR, 'g'))).toHaveLength(1)
    expect(linkOf(second)).toContain('family=Inter:')
    expect(linkOf(second)).toContain('family=Lora:')
    const dropped = second.replace('Inter, sans-serif', 'serif')
    expect(withWebFontLinks(dropped)).toBe(dropped)
  })

  it('rewrites a link that carries a broken escape rather than refusing the document', () => {
    const damaged = DESIGN.replace(
      '<title>x</title>',
      `<title>x</title><link rel="stylesheet" ${WEB_FONT_LINK_ATTR} href="https://fonts.googleapis.com/css2?family=Roboto%&family=Inter:wght@400">`,
    )
    /* the design names Inter alone, so the families wanted match the ones
       read: the broken value still has to go */
    const html = withWebFontLinks(damaged)
    expect(linkOf(html)).toContain('family=Inter:')
    expect(linkOf(html)).not.toContain('Roboto%')
    expect(html.match(new RegExp(WEB_FONT_LINK_ATTR, 'g'))).toHaveLength(1)
  })

  it('places the link in a document without a head', () => {
    const html = withWebFontLinks('<p style="font-family:Inter">x</p>')
    expect(html.startsWith('<link rel="stylesheet"')).toBe(true)
  })

  it('escapes the ampersands of its href', () => {
    const html = withWebFontLinks(DESIGN.replace('Hi</h1>', 'Hi</h1><p style="font-family:Lora">x</p>'))
    expect(linkOf(html)).toContain('&amp;family=')
    expect(linkOf(html)).not.toMatch(/[^;]&family=/)
  })
})
