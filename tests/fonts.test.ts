import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readFontFile } from '../server/fontFile.ts'
import {
  describeLibrary,
  faceLabel,
  familyWeights,
  fontFaceRule,
  libraryBrief,
  usesFamily,
  withFontFaces,
  type CustomFont,
} from '../shared/fonts.ts'
import { ttf, woff, woff2, woffClaiming, woffRepeating } from './fontFiles.ts'

function font(family: string, over: Partial<CustomFont> = {}): CustomFont {
  const id = over.id ?? `${family.replace(/\W/g, '')}${over.weight ?? '400'}${over.style ?? ''}`
  return {
    id,
    family,
    weight: '400',
    style: 'normal',
    format: 'woff2',
    url: `https://doop.test/a/${id}.woff2`,
    fileName: `${id}.woff2`,
    size: 1000,
    createdAt: 1,
    ...over,
  }
}

const BRAND = font('Brand Sans')
const BRAND_BOLD = font('Brand Sans', { weight: '700', createdAt: 2 })
const SERIF = font('Display Serif', { createdAt: 3 })
const LIBRARY = [BRAND, BRAND_BOLD, SERIF]

describe('readFontFile', () => {
  it('reads family, weight and style from TrueType, WOFF and WOFF2', () => {
    for (const [wrap, format, ext] of [
      [ttf, 'truetype', 'ttf'],
      [woff, 'woff', 'woff'],
      [woff2, 'woff2', 'woff2'],
    ] as const) {
      expect(readFontFile(wrap({ family: 'Brand Sans', weight: 700, italic: true }))).toMatchObject({
        format,
        ext,
        family: 'Brand Sans',
        weight: '700',
        style: 'italic',
      })
    }
  })

  it('groups weights under the typographic family, not the legacy one', () => {
    const info = readFontFile(ttf({ family: 'Brand Sans Light', typographic: 'Brand Sans', weight: 300 }))
    expect(info).toMatchObject({ family: 'Brand Sans', weight: '300', style: 'normal' })
  })

  it('gives a variable font its weight range', () => {
    expect(readFontFile(woff2({ family: 'Flex', wght: [100, 900] })).weight).toBe('100 900')
  })

  it('reads a real WOFF2: transformed glyph tables and multi-byte table lengths', () => {
    const real = readFileSync(new URL('./fixtures/fonts/nunito-sans-bold-italic.woff2', import.meta.url))
    expect(readFontFile(real)).toMatchObject({ format: 'woff2', family: 'Nunito Sans', weight: '700', style: 'italic' })
    expect(readFontFile(woff2({ family: 'Long Name', padName: 300 })).family).toBe('Long Name')
  })

  it('refuses files that would unpack far past their size, before unpacking them', () => {
    expect(() => readFontFile(woff2({ family: 'Bomb', declare: 100 * 1024 * 1024 }))).toThrow(/too large/)
    /* a stream that inflates past what its directory declares stops at the declaration */
    expect(() => readFontFile(woff2({ family: 'Liar', padName: 300, declare: 4 }))).toThrow(/could not be read/)
    expect(() => readFontFile(woffClaiming({ family: 'Bomb' }, 64 * 1024 * 1024))).toThrow(/malformed/)
  })

  it('refuses a directory that names a table twice, before inflating it again', () => {
    /* 65,535 entries over one 1 MB table would otherwise be 64 GB of inflate work */
    expect(() => readFontFile(woffRepeating({ family: 'Echo' }, 2))).toThrow(/malformed/)
    expect(() => readFontFile(woffRepeating({ family: 'Echo' }, 5000))).toThrow(/malformed/)
  })

  it('refuses what is not a single font', () => {
    expect(() => readFontFile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow(/not a font file/)
    expect(() => readFontFile(Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(40)]))).toThrow(/collections/)
    expect(() => readFontFile(ttf({ family: 'Cut' }).subarray(0, 40))).toThrow()
  })
})

describe('usesFamily', () => {
  it('finds a family quoted, in a stack, in a custom property, or entity-encoded in a style attribute', () => {
    expect(usesFamily('h1{font-family:"Brand Sans",serif}', 'Brand Sans')).toBe(true)
    expect(usesFamily("h1{font-family: Arial, 'brand sans'}", 'Brand Sans')).toBe(true)
    expect(usesFamily(':root{--display:"Brand Sans", sans-serif}', 'Brand Sans')).toBe(true)
    expect(usesFamily('h1{font-family:Brand Sans;}', 'Brand Sans')).toBe(true)
    expect(usesFamily('h1{font-family:Arial, Brand Sans}', 'Brand Sans')).toBe(true)
  })

  it('finds a bare family in a custom property and in the font shorthand', () => {
    expect(usesFamily(':root{--display: Brand Sans, sans-serif} h1{font-family:var(--display)}', 'Brand Sans')).toBe(
      true,
    )
    expect(usesFamily('h1{font:700 24px Brand Sans}', 'Brand Sans')).toBe(true)
    expect(usesFamily('h1{font: italic 700 24px/1.2 Brand   Sans, serif}', 'Brand Sans')).toBe(true)
  })

  it('does not match a longer family that starts with the name', () => {
    expect(usesFamily('h1{font-family:"Brand Sans Mono"}', 'Brand Sans')).toBe(false)
    expect(usesFamily('h1{font-family:Brand Sans Mono}', 'Brand Sans')).toBe(false)
    expect(usesFamily('h1{font-family:MyBrand Sans}', 'Brand Sans')).toBe(false)
  })
})

describe('withFontFaces', () => {
  const page = (style: string) =>
    `<!doctype html><html><head><title>x</title></head><body style='${style}'><h1>Hi</h1></body></html>`

  it('adds a managed block with every face of each used family, and nothing else', () => {
    const html = withFontFaces(page('font-family: &quot;Brand Sans&quot;, sans-serif'), LIBRARY)
    expect(html).toContain('<head><style data-doop-fonts>')
    expect(html).toContain(fontFaceRule(BRAND))
    expect(html).toContain(fontFaceRule(BRAND_BOLD))
    expect(html).not.toContain(SERIF.url)
  })

  it('returns the very same string when nothing is missing', () => {
    const plain = page('color: red')
    expect(withFontFaces(plain, LIBRARY)).toBe(plain)
    const once = withFontFaces(page('font-family: "Brand Sans"'), LIBRARY)
    expect(withFontFaces(once, LIBRARY)).toBe(once)
  })

  it('appends to the existing block when another family comes into use', () => {
    const once = withFontFaces(page('font-family: "Brand Sans"'), LIBRARY)
    const twice = withFontFaces(once.replace('<h1>', '<h1 style="font-family:\'Display Serif\'">'), LIBRARY)
    expect(twice.match(/<style data-doop-fonts>/g)).toHaveLength(1)
    expect(twice).toContain(fontFaceRule(SERIF))
    expect(twice).toContain(fontFaceRule(BRAND))
  })

  it('does not count its own rules as use, and keeps faces whose family left the design', () => {
    const once = withFontFaces(page('font-family: "Brand Sans"'), LIBRARY)
    const dropped = once.replace('font-family: "Brand Sans"', 'color: red')
    expect(withFontFaces(dropped, LIBRARY)).toBe(dropped)
  })

  it('skips a face the document already loads itself', () => {
    const own = `<html><head><style>@font-face{font-family:"Brand Sans";src:url(${BRAND.url})}</style></head><body style="font-family:'Brand Sans'"></body></html>`
    const html = withFontFaces(own, LIBRARY)
    expect(html.split(BRAND.url)).toHaveLength(2)
    expect(html).toContain(BRAND_BOLD.url)
  })

  it('places the block in a document without a head', () => {
    expect(withFontFaces('<div style="font-family:\'Brand Sans\'">x</div>', LIBRARY)).toMatch(
      /^<style data-doop-fonts>[\s\S]*<\/style><div/,
    )
    expect(withFontFaces('<!doctype html><html><body style="font-family:Brand Sans">x</body></html>', LIBRARY)).toMatch(
      /^<!doctype html><html><style data-doop-fonts>/,
    )
  })

  it('cannot be broken out of by a hostile family name or URL', () => {
    const evil = font('</style><script>alert(1)</script>', { url: 'https://doop.test/a/x.woff2")}</style>' })
    const rule = fontFaceRule(evil)
    expect(rule).not.toContain('<')
    expect(rule).not.toContain('>')
  })
})

describe('library descriptions', () => {
  it('lists each family once with its faces, for agents', () => {
    const italic = font('Brand Sans', { style: 'italic', createdAt: 4 })
    expect(describeLibrary([...LIBRARY, italic])).toEqual([
      { family: 'Brand Sans', faces: ['400', '700', '400 italic'] },
      { family: 'Display Serif', faces: ['400'] },
    ])
    const brief = libraryBrief(LIBRARY)
    expect(brief).toContain('"Brand Sans" (400, 700)')
    expect(brief).toContain('Do not load these families from Google Fonts')
    expect(libraryBrief([])).toBe('')
  })

  it('offers only the weights a library family has', () => {
    const italic = font('Brand Sans', { style: 'italic', weight: '700', id: 'bi' })
    expect(familyWeights([...LIBRARY, italic], 'brand sans')).toEqual(['400', '700'])
    expect(familyWeights([font('Flex', { weight: '250 780' })], 'Flex')).toEqual([
      '250',
      '300',
      '400',
      '500',
      '600',
      '700',
      '780',
    ])
    expect(familyWeights(LIBRARY, 'Georgia')).toBeNull()
  })

  it('names faces the way a type menu does', () => {
    expect(faceLabel({ weight: '400', style: 'normal' })).toBe('Regular')
    expect(faceLabel({ weight: '400', style: 'italic' })).toBe('Italic')
    expect(faceLabel({ weight: '700', style: 'italic' })).toBe('Bold Italic')
    expect(faceLabel({ weight: '100 900', style: 'normal' })).toBe('Variable 100–900')
  })
})
