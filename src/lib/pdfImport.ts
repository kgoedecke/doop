/* PDF import: every page of a dropped PDF becomes one frame whose vector
   artwork and pictures are editable layers (through the SVG importer) and
   whose text is editable text, set in the fonts the PDF embeds.

   MuPDF (WebAssembly) reads the file. Each page is rendered twice: once
   into SVG, which carries the paths, gradients, clips and images, with the
   text stripped out, and once as structured text, which carries every
   glyph with its font, size, colour and box. The embedded font programs
   come out of the page's font resources, are completed into web-loadable
   OpenType files (`sfnt.ts`: a PDF subset lacks the tables a browser
   insists on, and a bare CFF program has no wrapper at all) and ride in
   the frame as `@font-face` data URIs, so the page renders with the real
   faces.

   Proof of concept: fonts in Form XObjects are not looked up, Type1 programs
   fall back to a system face, and each text run is its own line, not a
   paragraph. */

import type { Font, PDFObject, PDFPage, Quad, Rect } from 'mupdf'
import { cffInfo, completeTrueType, isCff, sfntTables, wrapCff, type FontMetrics } from './sfnt'
import type { ImportedSvg, ImportOptions } from './svgImport'

/** PDF points are 1/72 in, CSS px 1/96 in: a page keeps its printed size on screen. */
const PX_PER_PT = 96 / 72

export interface ImportedPdfPage {
  name: string
  /** The page's size in CSS px. */
  width: number
  height: number
  html: string
  /** How many text runs and how many editable artwork layers the page gave. */
  texts: number
  layers: number
  /** The faces that ride in the frame, and the ones that could not be made loadable. */
  fonts: { embedded: string[]; fallback: string[] }
}

export interface PdfImportOptions {
  /** The SVG importer to run the page's artwork through (the browser's
   *  computed-style reader on a canvas, the attribute reader in tests). */
  importSvg: (markup: string, name: string, options: ImportOptions) => ImportedSvg | null
  /** Where an inline picture goes: given its bytes, answers the URL the
   *  frame should reference. Left out, pictures stay data URIs. */
  storeImage?: (bytes: Uint8Array, mime: string) => Promise<string>
  /** Pages past this many are left out. */
  maxPages?: number
}

export const MAX_PDF_PAGES = 50
/** A page's artwork budget: a chart or a map is many small paths. */
const MAX_PAGE_LAYERS = 6000
const MAX_PAGE_ELEMENTS = 20000

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

/* ---- fonts ---- */

interface EmbeddedFont {
  /** The CSS family the frame declares. */
  family: string
  mime: 'font/ttf' | 'font/otf'
  bytes: Uint8Array
}

/** One font the page draws with, by object: a name is not enough, since a
 *  producer can embed two subsets of one family under one name (InDesign
 *  does, per page), each with its own glyph order. */
interface FontUse {
  font: Font
  name: string
  /** Unicode → glyph id, from every glyph shown in this font. */
  glyphs: Map<number, number>
  /** Glyph id → advance, for the glyphs shown: the font's fingerprint. */
  advances: Map<number, number>
}

/** Unicode → (glyph id → how often the page drew that character with it).
 *  One character can reach several glyphs (an `f` on its own and as the
 *  first half of an `ﬁ` ligature): the glyph it uses most is the one. */
type GlyphVotes = Map<number, Map<number, number>>

/** The ligature a character sequence is drawn as, when one glyph stands for all of them. */
const LIGATURES: Record<string, number> = { ff: 0xfb00, fi: 0xfb01, fl: 0xfb02, ffi: 0xfb03, ffl: 0xfb04 }

/** `ABCDEF+Helvetica-Bold` → `Helvetica-Bold`: the subset tag is per file. */
function stripSubsetTag(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '')
}

/** `NotoSans-SemiBold_PDF_Subset` → `Noto Sans`: the family a system face or
 *  the hosted roster can be asked for. */
function baseFamily(name: string): string {
  const stem = stripSubsetTag(name)
    .replace(/_PDF_Subset$/i, '')
    .split(/[-,]/)[0]!
    .replace(/(MT|PS|PSMT)$/, '')
    .replace(/(Bold|Italic|Oblique|Regular|Roman|Light|Medium|Semibold|Black)+$/i, '')
  return stem
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim()
}

/** Every glyph each font draws on the page, by base font name. */
function fontUses(mupdf: typeof import('mupdf'), page: PDFPage): Map<number, FontUse> {
  const fonts = new Map<number, Font>()
  const votes = new Map<number, GlyphVotes>()
  const advances = new Map<number, Map<number, number>>()
  /* a ligature arrives as one glyph with the first character, then the
     other characters with glyph -1; the whole sequence gets the glyph */
  let ligature: { key: number; gid: number; text: string } | null = null
  const vote = (key: number, unicode: number, gid: number, weight: number) => {
    let byChar = votes.get(key)
    if (!byChar) votes.set(key, (byChar = new Map()))
    let byGid = byChar.get(unicode)
    if (!byGid) byChar.set(unicode, (byGid = new Map()))
    byGid.set(gid, (byGid.get(gid) ?? 0) + weight)
  }
  const settle = () => {
    if (ligature && ligature.text.length > 1) {
      vote(ligature.key, ligature.text.codePointAt(0)!, ligature.gid, -1)
      const code = LIGATURES[ligature.text]
      if (code) vote(ligature.key, code, ligature.gid, 1)
    }
    ligature = null
  }
  const record = (text: import('mupdf').Text) =>
    text.walk({
      showGlyph(font, _trm, gid, unicode) {
        const key = font.pointer as unknown as number
        if (!fonts.has(key)) {
          fonts.set(key, font)
          advances.set(key, new Map())
        }
        if (gid < 0) {
          if (ligature && ligature.key === key) ligature.text += String.fromCodePoint(unicode)
          return
        }
        settle()
        const widths = advances.get(key)!
        if (!widths.has(gid)) widths.set(gid, font.advanceGlyph(gid))
        if (unicode <= 0) return
        vote(key, unicode, gid, 1)
        ligature = { key, gid, text: String.fromCodePoint(unicode) }
      },
    })
  const device = new mupdf.Device({
    fillText: (text) => record(text),
    strokeText: (text) => record(text),
    clipText: (text) => record(text),
    clipStrokeText: (text) => record(text),
    ignoreText: (text) => record(text),
  })
  try {
    page.run(device, mupdf.Matrix.identity)
    settle()
  } finally {
    device.destroy()
  }
  const uses = new Map<number, FontUse>()
  for (const [key, font] of fonts) {
    const glyphs = new Map<number, number>()
    for (const [unicode, byGid] of votes.get(key) ?? []) {
      const [best] = [...byGid].sort((a, b) => b[1] - a[1])[0] ?? []
      if (best !== undefined) glyphs.set(unicode, best)
    }
    uses.set(key, { font, name: font.getName(), glyphs, advances: advances.get(key)! })
  }
  return uses
}

const number = (obj: PDFObject, fallback: number) => (obj.isNumber() ? obj.asNumber() : fallback)

/** A font's descriptor and base name, for every font the page's resources
 *  name, the resources of its Form XObjects included (InDesign and friends
 *  put most of a page in forms). */
function pageFonts(page: PDFPage): { name: string; descriptor: PDFObject }[] {
  const found: { name: string; descriptor: PDFObject }[] = []
  const visit = (resources: PDFObject, depth: number) => {
    if (depth > 6 || !resources.isDictionary()) return
    const dict = resources.get('Font')
    if (dict.isDictionary())
      dict.forEach((font) => {
        try {
          /* `get` resolves references; a `resolve()`d stream forgets it is one */
          if (!font.isDictionary()) return
          const descendants = font.get('DescendantFonts')
          const base = descendants.isArray() ? descendants.get(0) : font
          const descriptor = base.get('FontDescriptor')
          if (descriptor.isDictionary()) found.push({ name: font.get('BaseFont').asName(), descriptor })
        } catch {
          /* a font without a descriptor has nothing to offer */
        }
      })
    const xobjects = resources.get('XObject')
    if (xobjects.isDictionary())
      xobjects.forEach((xobject) => {
        try {
          if (xobject.isStream() && xobject.get('Subtype').asName() === 'Form')
            visit(xobject.get('Resources'), depth + 1)
        } catch {
          /* not a form */
        }
      })
  }
  try {
    visit(page.getObject().get('Resources'), 0)
  } catch {
    /* no resources */
  }
  return found
}

/** The raw program a descriptor embeds, whatever its kind. */
function rawProgram(descriptor: PDFObject): Uint8Array | null {
  for (const key of ['FontFile2', 'FontFile3']) {
    const stream = descriptor.get(key)
    if (stream.isStream()) return stream.readStream().asUint8Array()
  }
  return null
}

/** How well a program fits the font object that drew with it: the share of
 *  shown glyphs whose advance FreeType reads the same from the program.
 *  The page's own advances may come from the PDF's width table, rounded to
 *  1/1000 em, so a little slack is allowed. */
function fit(mupdf: typeof import('mupdf'), use: FontUse, program: Uint8Array): number {
  let probe: Font
  try {
    probe = new mupdf.Font(use.name, program)
  } catch {
    return 0
  }
  try {
    let hits = 0
    for (const [gid, advance] of use.advances) if (Math.abs(probe.advanceGlyph(gid) - advance) <= 2e-3) hits++
    return use.advances.size ? hits / use.advances.size : 1
  } catch {
    return 0
  } finally {
    probe.destroy()
  }
}

/** A cheap identity for a program: two resources often point at one stream. */
function programKey(program: Uint8Array): string {
  let hash = 0
  for (let i = 0; i < program.length; i += Math.max(1, program.length >> 8)) hash = (hash * 31 + program[i]!) >>> 0
  return `${program.length}:${hash}`
}

/** Every font the page draws with whose program can be made loadable, by
 *  font object. A program is paired with its object by name, and by
 *  fingerprint when one name covers several programs. */
function embeddedFonts(
  mupdf: typeof import('mupdf'),
  page: PDFPage,
  uses: Map<number, FontUse>,
): Map<number, EmbeddedFont> {
  const fonts = new Map<number, EmbeddedFont>()
  const entries = pageFonts(page).map((entry) => ({ ...entry, program: undefined as Uint8Array | null | undefined }))
  const families = new Map<string, number>()
  for (const [key, use] of uses) {
    const named = entries.filter((entry) => entry.name === use.name)
    for (const entry of named) if (entry.program === undefined) entry.program = rawProgram(entry.descriptor)
    const programs = new Map<string, (typeof entries)[number]>()
    for (const entry of named) if (entry.program) programs.set(programKey(entry.program), entry)
    const candidates = [...programs.values()]
    let entry = candidates[0]
    if (candidates.length > 1) {
      const scored = candidates.map((candidate) => ({ candidate, score: fit(mupdf, use, candidate.program!) }))
      entry = scored.sort((a, b) => b.score - a.score)[0]!.candidate
    }
    if (!entry) continue
    try {
      const program = loadableProgram(entry.descriptor, use)
      if (!program) continue
      const base = `pdf-${stripSubsetTag(use.name)}`
      const seen = families.get(base) ?? 0
      families.set(base, seen + 1)
      fonts.set(key, { family: seen ? `${base}-${seen + 1}` : base, ...program })
    } catch {
      /* a font without a loadable program falls back to a system face */
    }
  }
  return fonts
}

/** The descriptor's metrics, scaled from 1/1000 text space to font units. */
function descriptorMetrics(
  descriptor: PDFObject,
  name: string,
  unitsPerEm: number,
): Omit<FontMetrics, 'advances' | 'cmap'> {
  const scale = unitsPerEm / 1000
  const flags = number(descriptor.get('Flags'), 0)
  const box = descriptor.get('FontBBox')
  const bbox: FontMetrics['bbox'] = box.isArray()
    ? ([0, 1, 2, 3].map((i) => number(box.get(i), 0) * scale) as FontMetrics['bbox'])
    : [0, -0.25 * unitsPerEm, unitsPerEm, 0.75 * unitsPerEm]
  return {
    family: baseFamily(name),
    unitsPerEm,
    ascent: number(descriptor.get('Ascent'), 750) * scale,
    descent: number(descriptor.get('Descent'), -250) * scale,
    bbox,
    bold: /bold|black|heavy|semibold/i.test(name) || !!(flags & (1 << 18)) || number(descriptor.get('StemV'), 0) >= 120,
    italic: /italic|oblique/i.test(name) || !!(flags & (1 << 6)),
  }
}

function loadableProgram(descriptor: PDFObject, use: FontUse): Pick<EmbeddedFont, 'mime' | 'bytes'> | null {
  const name = use.name
  const advances = (count: number, unitsPerEm: number) =>
    Array.from({ length: count }, (_, gid) => use.font.advanceGlyph(gid) * unitsPerEm)
  const cmap = use.glyphs
  const trueType = descriptor.get('FontFile2')
  if (trueType.isStream()) {
    const bytes = trueType.readStream().asUint8Array()
    const tables = sfntTables(bytes)
    const head = tables?.find((t) => t.tag === 'head')?.data
    const maxp = tables?.find((t) => t.tag === 'maxp')?.data
    if (!head || !maxp) return null
    const unitsPerEm = (head[18]! << 8) | head[19]!
    const numGlyphs = (maxp[4]! << 8) | maxp[5]!
    const metrics = {
      ...descriptorMetrics(descriptor, name, unitsPerEm),
      advances: advances(numGlyphs, unitsPerEm),
      cmap,
    }
    const complete = completeTrueType(bytes, metrics)
    return complete ? { mime: 'font/ttf', bytes: complete } : null
  }
  const other = descriptor.get('FontFile3')
  if (!other.isStream()) return null
  const bytes = other.readStream().asUint8Array()
  /* an OpenType stream is a whole file; a Type1C / CIDFontType0C stream is a bare CFF program */
  if (sfntTables(bytes)) return { mime: 'font/otf', bytes }
  if (!isCff(bytes)) return null
  const info = cffInfo(bytes)
  if (!info) return null
  /* a CID-keyed program is addressed by CID on the page, by glyph index once wrapped */
  const byIndex = info.cidToGid
  const metrics = {
    ...descriptorMetrics(descriptor, name, info.unitsPerEm),
    advances: byIndex ? Array.from({ length: info.numGlyphs }, () => 0) : advances(info.numGlyphs, info.unitsPerEm),
    cmap: byIndex ? remapCids(cmap, byIndex) : cmap,
  }
  if (byIndex) for (const [cid, gid] of byIndex) metrics.advances[gid] = use.font.advanceGlyph(cid) * info.unitsPerEm
  const wrapped = wrapCff(bytes, metrics)
  return wrapped ? { mime: 'font/otf', bytes: wrapped } : null
}

function remapCids(cmap: Map<number, number>, cidToGid: Map<number, number>): Map<number, number> {
  const mapped = new Map<number, number>()
  for (const [unicode, cid] of cmap) {
    const gid = cidToGid.get(cid)
    if (gid !== undefined) mapped.set(unicode, gid)
  }
  return mapped
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

function fontFaceRule(font: EmbeddedFont): string {
  return `@font-face{font-family:"${font.family}";src:url(data:${font.mime};base64,${toBase64(font.bytes)});}`
}

/** In a browser, ask the engine whether it will load the face at all; a
 *  face its sanitizer refuses would only weigh the frame down. */
async function loadable(font: EmbeddedFont): Promise<boolean> {
  if (typeof FontFace === 'undefined') return true
  try {
    await new FontFace(font.family, font.bytes as BufferSource).load()
    return true
  } catch (err) {
    console.warn(`PDF import: ${font.family} is not loadable`, err)
    return false
  }
}

/* ---- text ---- */

interface TextRun {
  text: string
  /** The font object's key, pairing the run with `FontUse` and `EmbeddedFont`. */
  fontKey: number
  fontName: string
  font: Font
  size: number
  color: string
  /** The run's box in points: left, top, right, bottom (the glyph boxes' union). */
  box: Rect
  /** The first glyph's upper-left corner and the line's direction, for a rotated run. */
  origin: [number, number]
  angle: number
  /** The run's extent along its line and across it, in points. */
  length: number
  height: number
}

function hexColor(color: number[] | number): string {
  if (typeof color === 'number') return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
  const channel = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
  if (color.length === 1) return `rgb(${channel(color[0]!)} ${channel(color[0]!)} ${channel(color[0]!)})`
  if (color.length === 4) {
    const [c, m, y, k] = color as [number, number, number, number]
    return `rgb(${channel((1 - c) * (1 - k))} ${channel((1 - m) * (1 - k))} ${channel((1 - y) * (1 - k))})`
  }
  const [r, g, b] = color as [number, number, number]
  return `rgb(${channel(r)} ${channel(g)} ${channel(b)})`
}

/** The glyph box of a character: a quad's corners are ul, ur, ll, lr. */
function quadBox(quad: Quad): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function union(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

/** Every line's runs: one run per stretch of one font, size and colour. */
function textRuns(stext: import('mupdf').StructuredText): TextRun[] {
  const runs: TextRun[] = []
  let current: TextRun | null = null
  stext.walk({
    beginLine() {
      current = null
    },
    onChar(c, _origin, font, size, quad, color) {
      const fontKey = font.pointer as unknown as number
      const hex = hexColor(color)
      const box = quadBox(quad)
      const [ulx, uly, urx, ury, llx, lly] = quad
      const along = Math.hypot(urx - ulx, ury - uly)
      if (current && current.fontKey === fontKey && current.size === size && current.color === hex) {
        current.text += c
        current.box = union(current.box, box)
        current.length += along
        return
      }
      current = {
        text: c,
        fontKey,
        fontName: font.getName(),
        font,
        size,
        color: hex,
        box,
        origin: [ulx, uly],
        angle: Math.atan2(ury - uly, urx - ulx),
        length: along,
        height: Math.hypot(llx - ulx, lly - uly),
      }
      runs.push(current)
    },
    endLine() {
      current = null
    },
  })
  return runs.filter((run) => run.text.trim().length > 0)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const px = (pt: number) => `${+(pt * PX_PER_PT).toFixed(2)}px`

/** Serif, mono or sans, from the descriptor's flags when the page has them. */
function genericFamily(run: TextRun, flags: number | undefined): string {
  if (flags !== undefined) return flags & 1 ? 'monospace' : flags & 2 ? 'serif' : 'sans-serif'
  return run.font.isMono() ? 'monospace' : run.font.isSerif() ? 'serif' : 'sans-serif'
}

function textElement(run: TextRun, fonts: Map<number, EmbeddedFont>, flags: Map<string, number>): string {
  const name = run.fontName
  const embedded = fonts.get(run.fontKey)
  const generic = genericFamily(run, flags.get(name))
  /* single quotes: the declaration sits inside a double-quoted style attribute */
  const family = embedded
    ? `'${embedded.family}', '${baseFamily(name)}', ${generic}`
    : `'${baseFamily(name)}', ${generic}`
  /* an embedded face is already the bold or italic cut; only a fallback needs synthesising */
  const bold = /bold|black|heavy|semibold/i.test(name) || run.font.isBold()
  const italic = /italic|oblique/i.test(name) || run.font.isItalic()
  const weight = !embedded && bold ? 'font-weight:700;' : ''
  const style = !embedded && italic ? 'font-style:italic;' : ''
  /* a flat run sits by its glyph box; a rotated one by its first glyph's
     corner, turned about it */
  const rotated = Math.abs(run.angle) > 0.005
  const [left, top, , bottom] = run.box
  const place = rotated
    ? `left:${px(run.origin[0])};top:${px(run.origin[1])};transform-origin:0 0;transform:rotate(${+((run.angle * 180) / Math.PI).toFixed(2)}deg);`
    : `left:${px(left)};top:${px(top)};`
  const lineHeight = rotated ? run.height : bottom - top
  const styles =
    `position:absolute;${place}margin:0;` +
    `font-family:${family};font-size:${px(run.size)};line-height:${px(lineHeight)};${weight}${style}` +
    `color:${run.color};white-space:pre;`
  const label = run.text.trim().slice(0, 40)
  return `<p data-doop-drawing="text" data-name="${escapeHtml(label)}" style="${styles}">${escapeHtml(run.text)}</p>`
}

/* ---- artwork ---- */

/** The page as SVG without its text (that comes back as HTML), on a white
 *  page-sized sheet so the importer's content box is the whole page. Drawn
 *  in CSS px, since a clip on an imported group is measured in the frame's
 *  px, not the file's units. */
function artworkSvg(mupdf: typeof import('mupdf'), page: PDFPage, bounds: Rect): string {
  const buffer = new mupdf.Buffer()
  const writer = new mupdf.DocumentWriter(buffer, 'svg', 'text=text')
  const sheet = bounds.map((edge) => edge * PX_PER_PT) as Rect
  const device = writer.beginPage(sheet)
  page.run(device, mupdf.Matrix.scale(PX_PER_PT, PX_PER_PT))
  writer.endPage()
  writer.close()
  const svg = buffer.asString()
  buffer.destroy()
  const [x, y, right, bottom] = sheet
  const paper = `<rect x="${x}" y="${y}" width="${right - x}" height="${bottom - y}" fill="#ffffff"/>`
  return rgbPictures(
    mupdf,
    page,
    svg.replace(/<text\b[\s\S]*?<\/text>/g, '').replace(/<svg\b[^>]*>/, (open) => `${open}\n${paper}`),
  )
}

/** Whether a JPEG has four colour components: a CMYK picture, which
 *  browsers show inverted or not at all. */
function isCmykJpeg(bytes: Uint8Array): boolean {
  let at = 2
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return bytes[at + 9] === 4
    if (marker === 0xda) return false
    at += 2 + length
  }
  return false
}

/** The SVG's pictures in a form browsers show. MuPDF writes a JPEG stream
 *  as it is, so a CMYK one is decoded through the page instead (which
 *  applies the PDF's decode array too) and re-encoded as RGB JPEG. The
 *  writer and the page device paint pictures in the same order, so the
 *  n-th CMYK picture of a size in the markup is the n-th four-component
 *  one of that size the page draws. */
function rgbPictures(mupdf: typeof import('mupdf'), page: PDFPage, svg: string): string {
  const pattern =
    /(<image\b[^>]*\bwidth="(\d+)"\s+height="(\d+)"[^>]*href=")data:image\/jpeg;base64,([A-Za-z0-9+/=\s]+)"/g
  const cmyk = (data: string) => isCmykJpeg(fromBase64(data.replace(/\s/g, '')))
  const wanted = new Map<string, number>()
  for (const m of svg.matchAll(pattern))
    if (cmyk(m[4]!)) wanted.set(`${m[2]}x${m[3]}`, (wanted.get(`${m[2]}x${m[3]}`) ?? 0) + 1)
  if (!wanted.size) return svg
  const decoded = new Map<string, string[]>()
  const device = new mupdf.Device({
    fillImage(image) {
      const key = `${image.getWidth()}x${image.getHeight()}`
      if (!wanted.get(key) || image.getColorSpace()?.getNumberOfComponents() !== 4) return
      try {
        const pixmap = image.toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceRGB)
        decoded.set(key, [...(decoded.get(key) ?? []), `data:image/jpeg;base64,${toBase64(pixmap.asJPEG(85, false))}`])
        pixmap.destroy()
      } catch {
        /* left as it is */
      }
    },
  })
  try {
    page.run(device, mupdf.Matrix.identity)
  } finally {
    device.destroy()
  }
  return svg.replace(pattern, (whole, prefix: string, w: string, h: string, data: string) => {
    if (!cmyk(data)) return whole
    const url = decoded.get(`${w}x${h}`)?.shift()
    return url ? `${prefix}${url}"` : whole
  })
}

function bodyOf(html: string): string {
  return /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? ''
}

function fromBase64(text: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'))
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}

/** Every inline picture in the markup, stored and referenced by URL instead. */
async function storePictures(html: string, store: NonNullable<PdfImportOptions['storeImage']>): Promise<string> {
  const pattern = /((?:xlink:href|href|src)=")data:(image\/[a-z+]+);base64,([^"]+)"/g
  const matches = [...html.matchAll(pattern)]
  if (!matches.length) return html
  const urls = await Promise.all(
    matches.map((m) => store(fromBase64(m[3]!.replace(/\s/g, '')), m[2]!).catch(() => null)),
  )
  let i = 0
  return html.replace(pattern, (whole, prefix: string) => {
    const url = urls[i++]
    return url ? `${prefix}${url}"` : whole
  })
}

/* ---- the entry point ---- */

/** Read a PDF into one frame per page. */
export async function importPdf(
  bytes: Uint8Array,
  name: string,
  { importSvg, storeImage, maxPages = MAX_PDF_PAGES }: PdfImportOptions,
): Promise<ImportedPdfPage[]> {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
  const pages: ImportedPdfPage[] = []
  try {
    const count = Math.min(doc.countPages(), maxPages)
    for (let index = 0; index < count; index++) {
      const page = doc.loadPage(index) as PDFPage
      try {
        const imported = await importPage(mupdf, page, count > 1 ? `${name} · ${index + 1}` : name, importSvg)
        if (storeImage) imported.html = await storePictures(imported.html, storeImage)
        pages.push(imported)
      } finally {
        page.destroy()
      }
    }
  } finally {
    doc.destroy()
  }
  return pages
}

async function importPage(
  mupdf: typeof import('mupdf'),
  page: PDFPage,
  name: string,
  importSvg: PdfImportOptions['importSvg'],
): Promise<ImportedPdfPage> {
  const bounds = page.getBounds()
  const width = Math.round((bounds[2] - bounds[0]) * PX_PER_PT)
  const height = Math.round((bounds[3] - bounds[1]) * PX_PER_PT)
  const stext = page.toStructuredText('preserve-whitespace,preserve-spans,preserve-ligatures')
  let runs: TextRun[]
  try {
    runs = textRuns(stext)
  } finally {
    stext.destroy()
  }
  const used = new Set(runs.map((run) => run.fontKey))
  const fonts = embeddedFonts(mupdf, page, fontUses(mupdf, page))
  for (const [key, font] of fonts) if (!used.has(key) || !(await loadable(font))) fonts.delete(key)
  const flags = new Map(pageFonts(page).map(({ name, descriptor }) => [name, number(descriptor.get('Flags'), 0)]))
  const artwork = importSvg(artworkSvg(mupdf, page, bounds), 'Artwork', {
    box: 'root',
    maxLayers: MAX_PAGE_LAYERS,
    maxElements: MAX_PAGE_ELEMENTS,
  })
  const faces = [...fonts.values()].map(fontFaceRule)
  const texts = runs.map((run) => textElement(run, fonts, flags))
  const html =
    '<!doctype html>\n<html><head><meta charset="utf-8">' +
    (faces.length ? `<style data-doop-pdf-fonts>${faces.join('\n')}</style>` : '') +
    `</head><body style="margin:0;width:${width}px;height:${height}px;position:relative;overflow:hidden;background:#fff;">` +
    (artwork ? bodyOf(artwork.html) : '') +
    texts.join('') +
    '</body></html>'
  return {
    name,
    width,
    height,
    html,
    texts: texts.length,
    layers: artwork?.layers ?? 0,
    fonts: {
      embedded: [...new Set([...fonts.values()].map((font) => font.family.slice(4)))],
      fallback: [...new Set(runs.filter((run) => !fonts.has(run.fontKey)).map((run) => stripSubsetTag(run.fontName)))],
    },
  }
}
