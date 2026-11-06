import { brotliDecompressSync, inflateSync } from 'node:zlib'
import type { FontFormat, FontStyle } from '../shared/fonts.ts'

/**
 * Reads what a font library needs from an uploaded file: its format (from the
 * bytes, never the file name), family, weight and style. TrueType/OpenType
 * tables are read straight; WOFF tables are zlib-inflated one by one; WOFF2's
 * single brotli stream is unpacked far enough to reach `name`, `OS/2`, `head`
 * and `fvar`, none of which WOFF2 ever transforms. Collections (.ttc) are
 * refused: one file has to be one face for @font-face.
 */

export interface FontFileInfo {
  format: FontFormat
  mime: string
  ext: string
  family: string
  weight: string
  style: FontStyle
}

const FORMATS = {
  woff2: { mime: 'font/woff2', ext: 'woff2' },
  woff: { mime: 'font/woff', ext: 'woff' },
  truetype: { mime: 'font/ttf', ext: 'ttf' },
  opentype: { mime: 'font/otf', ext: 'otf' },
} as const satisfies Record<FontFormat, { mime: string; ext: string }>

/* WOFF2's table directory names common tables by index into this list
   (`_` stands for the padding space in four-letter tags like `cvt `) */
const WOFF2_KNOWN_TAGS = (
  'cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx kern LTSH PCLT ' +
  'VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc bsln cvar ' +
  'fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill'
)
  .split(' ')
  .map((tag) => tag.replace('_', ' '))

const WANTED = new Set(['name', 'OS/2', 'head', 'fvar'])

/* Decompression is bounded before it starts, so a small upload cannot expand
   into a stall or an out-of-memory: the tables read here are metadata (a
   name table is kilobytes), and WOFF2's single stream also carries the
   glyphs, which a real font keeps well under this. A directory that names a
   wanted table twice is refused before anything is inflated (`claim`), so the
   work a WOFF can ask for is at most one inflate per wanted table — a
   directory of 65,535 `name` entries over one compressed table would
   otherwise inflate it 65,535 times. */
const MAX_TABLE_BYTES = 1024 * 1024
const MAX_WOFF2_STREAM_BYTES = 48 * 1024 * 1024

type Tables = Map<string, Buffer>

class FontFileError extends Error {}

function fail(message: string): never {
  throw new FontFileError(message)
}

/** Takes a wanted table's slot in the directory; a second entry for the same
 *  table is malformed, and refusing it is what bounds the inflate work. */
function claim(tables: Tables, tag: string): boolean {
  if (!WANTED.has(tag)) return false
  if (tables.has(tag)) fail('the font file is malformed')
  return true
}

function slice(buf: Buffer, offset: number, length: number): Buffer {
  if (offset < 0 || length < 0 || offset + length > buf.length) fail('the font file is truncated')
  return buf.subarray(offset, offset + length)
}

function sfntTables(buf: Buffer): Tables {
  const count = buf.readUInt16BE(4)
  const tables: Tables = new Map()
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16
    const tag = slice(buf, at, 4).toString('latin1')
    if (claim(tables, tag)) tables.set(tag, slice(buf, buf.readUInt32BE(at + 8), buf.readUInt32BE(at + 12)))
  }
  return tables
}

function woffTables(buf: Buffer): Tables {
  const count = buf.readUInt16BE(12)
  const tables: Tables = new Map()
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20
    const tag = slice(buf, at, 4).toString('latin1')
    if (!claim(tables, tag)) continue
    const data = slice(buf, buf.readUInt32BE(at + 4), buf.readUInt32BE(at + 8))
    const origLength = buf.readUInt32BE(at + 12)
    if (origLength > MAX_TABLE_BYTES) fail('the font file is malformed')
    tables.set(tag, data.length < origLength ? inflateSync(data, { maxOutputLength: origLength }) : data)
  }
  return tables
}

function woff2Tables(buf: Buffer): Tables {
  if (buf.toString('latin1', 4, 8) === 'ttcf') fail('font collections are not supported — upload one face per file')
  const count = buf.readUInt16BE(12)
  const compressedLength = buf.readUInt32BE(20)
  let at = 48
  const base128 = () => {
    let value = 0
    for (let i = 0; i < 5; i++) {
      const byte = slice(buf, at++, 1)[0]!
      value = value * 128 + (byte & 0x7f)
      if (!(byte & 0x80)) return value
    }
    return fail('the font file is malformed')
  }
  const entries: { tag: string; length: number }[] = []
  for (let i = 0; i < count; i++) {
    const flags = slice(buf, at++, 1)[0]!
    const index = flags & 0x3f
    const tag = index === 63 ? slice(buf, at, 4).toString('latin1') : WOFF2_KNOWN_TAGS[index]
    if (index === 63) at += 4
    if (!tag) fail('the font file is malformed')
    const version = flags >> 6
    const origLength = base128()
    /* glyf/loca are transformed at version 0, everything else at non-zero */
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0
    entries.push({ tag, length: transformed ? base128() : origLength })
  }
  const declared = entries.reduce((sum, e) => sum + e.length, 0)
  if (declared > MAX_WOFF2_STREAM_BYTES) fail('the font is too large once unpacked')
  const stream = brotliDecompressSync(slice(buf, at, compressedLength), { maxOutputLength: Math.max(declared, 1) })
  const tables: Tables = new Map()
  let offset = 0
  for (const { tag, length } of entries) {
    if (claim(tables, tag)) tables.set(tag, slice(stream, offset, length))
    offset += length
  }
  return tables
}

/* UTF-16BE; swap16 works in place, so on a copy */
function utf16be(bytes: Buffer): string {
  return Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)))
    .swap16()
    .toString('utf16le')
}

/* Windows English first, then any Windows, Unicode, and Mac Roman names */
function nameRecords(name: Buffer): Map<number, string> {
  const count = name.readUInt16BE(2)
  const strings = name.readUInt16BE(4)
  const best = new Map<number, { rank: number; value: string }>()
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12
    if (at + 12 > name.length) break
    const platform = name.readUInt16BE(at)
    const language = name.readUInt16BE(at + 4)
    const id = name.readUInt16BE(at + 6)
    const start = strings + name.readUInt16BE(at + 10)
    const bytes = name.subarray(start, start + name.readUInt16BE(at + 8))
    const rank = platform === 3 ? (language === 0x409 ? 0 : 1) : platform === 0 ? 2 : platform === 1 ? 3 : 9
    if (rank === 9) continue
    const value = (platform === 1 ? bytes.toString('latin1') : utf16be(bytes)).replace(/\0/g, '').trim()
    if (!value) continue
    const prior = best.get(id)
    if (!prior || rank < prior.rank) best.set(id, { rank, value })
  }
  return new Map([...best].map(([id, { value }]) => [id, value]))
}

function weightOf(tables: Tables): string {
  const fvar = tables.get('fvar')
  if (fvar && fvar.length >= 16) {
    const axesAt = fvar.readUInt16BE(4)
    const axisCount = fvar.readUInt16BE(8)
    const axisSize = fvar.readUInt16BE(10)
    for (let i = 0; i < axisCount; i++) {
      const at = axesAt + i * axisSize
      if (at + 20 > fvar.length) break
      if (fvar.toString('latin1', at, at + 4) !== 'wght') continue
      const min = Math.round(fvar.readInt32BE(at + 4) / 65536)
      const max = Math.round(fvar.readInt32BE(at + 12) / 65536)
      if (min >= 1 && max <= 1000 && min < max) return `${min} ${max}`
    }
  }
  const os2 = tables.get('OS/2')
  const weight = os2 && os2.length >= 6 ? os2.readUInt16BE(4) : 400
  return String(weight >= 1 && weight <= 1000 ? weight : 400)
}

function italicOf(tables: Tables): boolean {
  const os2 = tables.get('OS/2')
  if (os2 && os2.length >= 64) return (os2.readUInt16BE(62) & 0x0201) !== 0
  const head = tables.get('head')
  return !!head && head.length >= 46 && (head.readUInt16BE(44) & 0x02) !== 0
}

function formatOf(buf: Buffer): FontFormat | undefined {
  if (buf.length < 12) return undefined
  const sig = buf.toString('latin1', 0, 4)
  if (sig === 'wOF2') return 'woff2'
  if (sig === 'wOFF') return 'woff'
  if (sig === 'OTTO') return 'opentype'
  if (sig === 'true' || buf.readUInt32BE(0) === 0x00010000) return 'truetype'
  if (sig === 'ttcf') fail('font collections are not supported — upload one face per file')
  return undefined
}

/** The format and identity of an uploaded font, or a reason it is refused. */
export function readFontFile(buf: Buffer): FontFileInfo {
  const format = formatOf(buf)
  if (!format) fail('not a font file — ttf, otf, woff and woff2 are accepted')
  let tables: Tables
  try {
    tables = format === 'woff2' ? woff2Tables(buf) : format === 'woff' ? woffTables(buf) : sfntTables(buf)
  } catch (e) {
    if (e instanceof FontFileError) throw e
    return fail('the font file could not be read')
  }
  const name = tables.get('name')
  if (!name || name.length < 6) fail('the font has no name table')
  const names = nameRecords(name)
  /* typographic family (16) groups weights that legacy family (1) splits */
  const family = (names.get(16) ?? names.get(1) ?? '').replace(/\s+/g, ' ').slice(0, 100)
  if (!family) fail('the font does not name its family')
  return { format, ...FORMATS[format], family, weight: weightOf(tables), style: italicOf(tables) ? 'italic' : 'normal' }
}

export { FontFileError }
