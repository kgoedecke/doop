/* Font programs out of a PDF are not web fonts. A TrueType subset usually
   drops the tables PDF readers never need (`OS/2`, often `cmap`, `name` and
   `post`), and a bare CFF program has no sfnt wrapper at all; a browser's
   sanitizer refuses both. This module completes them: it keeps every table
   the program has and synthesises the missing ones from what the PDF knows
   (metrics from the font descriptor, the glyph-to-character map from the
   glyphs the page shows), so the face loads through `@font-face`. */

const SFNT_TRUETYPE = 0x00010000
const SFNT_CFF = 0x4f54544f /* 'OTTO' */

/** What a PDF can say about a program the tables do not. */
export interface FontMetrics {
  family: string
  unitsPerEm: number
  ascent: number
  descent: number
  /** xMin, yMin, xMax, yMax in font units. */
  bbox: [number, number, number, number]
  /** Advance width per glyph id, in font units; `numGlyphs` long for a CFF wrap. */
  advances: number[]
  /** Unicode → glyph id, from the glyphs the page draws. */
  cmap: Map<number, number>
  bold?: boolean
  italic?: boolean
}

type Table = { tag: string; data: Uint8Array }

/* ---- reading ---- */

export function sfntTables(bytes: Uint8Array): Table[] | null {
  if (bytes.length < 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = view.getUint32(0)
  if (tag !== SFNT_TRUETYPE && tag !== SFNT_CFF && tag !== 0x74727565 /* 'true' */) return null
  const count = view.getUint16(4)
  const tables: Table[] = []
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16
    if (at + 16 > bytes.length) return null
    const name = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
    const offset = view.getUint32(at + 8)
    const length = view.getUint32(at + 12)
    if (offset + length > bytes.length) return null
    tables.push({ tag: name, data: bytes.subarray(offset, offset + length) })
  }
  return tables
}

export function isCff(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 1 && bytes[1] === 0 && bytes[2]! <= 4
}

export interface CffInfo {
  numGlyphs: number
  unitsPerEm: number
  /** For a CID-keyed program, the charset inverted: CID → glyph index. A
   *  PDF reader addresses such a font by CID, an OpenType wrapper by index. */
  cidToGid: Map<number, number> | null
}

/** The glyph count, em size and CID charset a CFF program declares. */
export function cffInfo(cff: Uint8Array): CffInfo | null {
  const view = new DataView(cff.buffer, cff.byteOffset, cff.byteLength)
  const readIndex = (at: number): { items: [number, number][]; end: number } | null => {
    if (at + 2 > cff.length) return null
    const count = view.getUint16(at)
    if (count === 0) return { items: [], end: at + 2 }
    const offSize = cff[at + 2]!
    if (offSize < 1 || offSize > 4) return null
    const offsets: number[] = []
    let p = at + 3
    for (let i = 0; i <= count; i++) {
      let value = 0
      for (let b = 0; b < offSize; b++) value = (value << 8) | cff[p++]!
      offsets.push(value)
    }
    const base = p - 1
    const items: [number, number][] = []
    for (let i = 0; i < count; i++) items.push([base + offsets[i]!, base + offsets[i + 1]!])
    const end = base + offsets[count]!
    return end <= cff.length ? { items, end } : null
  }
  const hdrSize = cff[2]!
  const names = readIndex(hdrSize)
  if (!names) return null
  const topDicts = readIndex(names.end)
  const top = topDicts?.items[0]
  if (!top) return null
  /* the top DICT: operands then an operator; CharStrings is op 17, FontMatrix 12 7 */
  let charStrings = -1
  let charset = 0
  let cidKeyed = false
  let unitsPerEm = 1000
  const operands: number[] = []
  let p = top[0]
  while (p < top[1]) {
    const b0 = cff[p]!
    if (b0 <= 21) {
      let op = b0
      p++
      if (b0 === 12) op = 1200 + cff[p++]!
      if (op === 17) charStrings = operands[0] ?? -1
      if (op === 15) charset = operands[0] ?? 0
      if (op === 1230) cidKeyed = true
      if (op === 1207 && operands[0]) unitsPerEm = Math.round(1 / operands[0])
      operands.length = 0
    } else if (b0 === 28) {
      operands.push(view.getInt16(p + 1))
      p += 3
    } else if (b0 === 29) {
      operands.push(view.getInt32(p + 1))
      p += 5
    } else if (b0 === 30) {
      /* a real number: nibbles until 0xf */
      let text = ''
      p++
      let done = false
      while (p < top[1] && !done) {
        const byte = cff[p++]!
        for (const nibble of [byte >> 4, byte & 15]) {
          if (nibble <= 9) text += nibble
          else if (nibble === 10) text += '.'
          else if (nibble === 11) text += 'E'
          else if (nibble === 12) text += 'E-'
          else if (nibble === 14) text += '-'
          else if (nibble === 15) {
            done = true
            break
          }
        }
      }
      operands.push(parseFloat(text) || 0)
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139)
      p++
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + cff[p + 1]! + 108)
      p += 2
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - cff[p + 1]! - 108)
      p += 2
    } else return null
  }
  if (charStrings < 0) return null
  const glyphs = readIndex(charStrings)
  if (!glyphs) return null
  const numGlyphs = glyphs.items.length
  return { numGlyphs, unitsPerEm, cidToGid: cidKeyed ? readCharset(cff, charset, numGlyphs) : null }
}

/** The charset table inverted: glyph 0 is CID 0, the rest are listed as
 *  single ids (format 0) or as ranges (formats 1 and 2). */
function readCharset(cff: Uint8Array, at: number, numGlyphs: number): Map<number, number> | null {
  const map = new Map<number, number>([[0, 0]])
  /* 0, 1 and 2 name the predefined ISOAdobe, Expert and ExpertSubset charsets, identity for our purpose */
  if (at < 3) {
    for (let gid = 1; gid < numGlyphs; gid++) map.set(gid, gid)
    return map
  }
  const view = new DataView(cff.buffer, cff.byteOffset, cff.byteLength)
  const format = cff[at]
  let p = at + 1
  let gid = 1
  try {
    if (format === 0) {
      while (gid < numGlyphs) {
        map.set(view.getUint16(p), gid++)
        p += 2
      }
    } else if (format === 1 || format === 2) {
      while (gid < numGlyphs) {
        const first = view.getUint16(p)
        const left = format === 1 ? cff[p + 2]! : view.getUint16(p + 2)
        p += format === 1 ? 3 : 4
        for (let i = 0; i <= left && gid < numGlyphs; i++) map.set(first + i, gid++)
      }
    } else return null
  } catch {
    return null
  }
  return map
}

/* ---- writing ---- */

class Writer {
  private chunks: number[] = []
  u8(v: number) {
    this.chunks.push(v & 0xff)
  }
  u16(v: number) {
    this.u8(v >> 8)
    this.u8(v)
  }
  i16(v: number) {
    this.u16(v < 0 ? v + 0x10000 : v)
  }
  u32(v: number) {
    this.u16(v >>> 16)
    this.u16(v)
  }
  tag(text: string) {
    for (let i = 0; i < 4; i++) this.u8(text.charCodeAt(i) || 0x20)
  }
  bytes(data: Uint8Array) {
    for (const b of data) this.chunks.push(b)
  }
  get length() {
    return this.chunks.length
  }
  done(): Uint8Array {
    return Uint8Array.from(this.chunks)
  }
}

function checksum(data: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    const word = ((data[i]! << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0)) >>> 0
    sum = (sum + word) >>> 0
  }
  return sum
}

/** Assemble tables into one sfnt file, directory sorted by tag. */
export function buildSfnt(tables: Table[], cff: boolean): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  const count = sorted.length
  const searchRange = 2 ** Math.floor(Math.log2(count)) * 16
  const header = new Writer()
  header.u32(cff ? SFNT_CFF : SFNT_TRUETYPE)
  header.u16(count)
  header.u16(searchRange)
  header.u16(Math.floor(Math.log2(count)))
  header.u16(count * 16 - searchRange)
  const offset = 12 + count * 16
  const body = new Writer()
  for (const table of sorted) {
    header.tag(table.tag)
    header.u32(checksum(table.data))
    header.u32(offset + body.length)
    header.u32(table.data.length)
    body.bytes(table.data)
    while ((offset + body.length) % 4) body.u8(0)
  }
  const out = new Uint8Array(header.length + body.length)
  out.set(header.done(), 0)
  out.set(body.done(), header.length)
  const head = sorted.findIndex((t) => t.tag === 'head')
  if (head >= 0) {
    /* checkSumAdjustment: 0xB1B0AFBA minus the whole file's sum, with the field zeroed */
    const at = 12 + count * 16 + sorted.slice(0, head).reduce((sum, t) => sum + Math.ceil(t.data.length / 4) * 4, 0)
    new DataView(out.buffer).setUint32(at + 8, 0)
    new DataView(out.buffer).setUint32(at + 8, (0xb1b0afba - checksum(out)) >>> 0)
  }
  return out
}

const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)))

function headTable(m: FontMetrics): Uint8Array {
  const w = new Writer()
  w.u32(0x00010000) /* version */
  w.u32(0x00010000) /* fontRevision */
  w.u32(0) /* checkSumAdjustment, set by buildSfnt */
  w.u32(0x5f0f3cf5) /* magic */
  w.u16(0x000b) /* flags */
  w.u16(m.unitsPerEm)
  w.u32(0)
  w.u32(0) /* created */
  w.u32(0)
  w.u32(0) /* modified */
  for (const edge of m.bbox) w.i16(clamp16(edge))
  w.u16((m.bold ? 1 : 0) | (m.italic ? 2 : 0)) /* macStyle */
  w.u16(8) /* lowestRecPPEM */
  w.i16(2) /* fontDirectionHint */
  w.i16(0) /* indexToLocFormat */
  w.i16(0) /* glyphDataFormat */
  return w.done()
}

function hheaTable(m: FontMetrics): Uint8Array {
  const w = new Writer()
  w.u32(0x00010000)
  w.i16(clamp16(m.ascent))
  w.i16(clamp16(m.descent))
  w.i16(0) /* lineGap */
  w.u16(Math.max(0, Math.min(65535, Math.round(Math.max(0, ...m.advances)))))
  w.i16(clamp16(m.bbox[0])) /* minLeftSideBearing */
  w.i16(0) /* minRightSideBearing */
  w.i16(clamp16(m.bbox[2])) /* xMaxExtent */
  w.i16(1) /* caretSlopeRise */
  w.i16(0)
  w.i16(0) /* caretOffset */
  for (let i = 0; i < 4; i++) w.i16(0)
  w.i16(0) /* metricDataFormat */
  w.u16(m.advances.length)
  return w.done()
}

function hmtxTable(m: FontMetrics): Uint8Array {
  const w = new Writer()
  for (const advance of m.advances) {
    w.u16(Math.max(0, Math.min(65535, Math.round(advance))))
    w.i16(0)
  }
  return w.done()
}

function maxpTable(numGlyphs: number): Uint8Array {
  const w = new Writer()
  w.u32(0x00005000) /* version 0.5, the CFF form */
  w.u16(numGlyphs)
  return w.done()
}

function os2Table(m: FontMetrics): Uint8Array {
  const w = new Writer()
  w.u16(1) /* version */
  const avg = m.advances.length ? m.advances.reduce((a, b) => a + b, 0) / m.advances.length : m.unitsPerEm / 2
  w.i16(clamp16(avg))
  w.u16(m.bold ? 700 : 400)
  w.u16(5) /* width class */
  w.u16(0) /* type: installable */
  const em = m.unitsPerEm
  for (const v of [0.65, 0.6, 0, 0.3, 0.65, 0.6, 0, 0.3, 0.05, 0.3]) w.i16(clamp16(v * em))
  w.u8(0)
  w.u8(m.bold ? 8 : 5)
  for (let i = 0; i < 10; i++) w.u8(0) /* panose */
  w.u32(1) /* unicode range: basic latin */
  w.u32(0)
  w.u32(0)
  w.u32(0)
  w.tag('DOOP') /* vendor */
  w.u16((m.italic ? 1 : 0) | (m.bold ? 32 : 0) | (!m.bold && !m.italic ? 64 : 0))
  const codes = [...m.cmap.keys()].filter((c) => c <= 0xffff)
  w.u16(codes.length ? Math.min(...codes) : 0x20)
  w.u16(codes.length ? Math.max(...codes) : 0x7e)
  w.i16(clamp16(m.ascent))
  w.i16(clamp16(m.descent))
  w.i16(0) /* typo line gap */
  w.u16(Math.max(0, Math.round(m.ascent)))
  w.u16(Math.max(0, Math.round(-m.descent)))
  w.u32(1) /* code page range: latin 1 */
  w.u32(0)
  return w.done()
}

function postTable(): Uint8Array {
  const w = new Writer()
  w.u32(0x00030000)
  w.u32(0) /* italicAngle */
  w.i16(0)
  w.i16(0)
  w.u32(0) /* isFixedPitch */
  for (let i = 0; i < 4; i++) w.u32(0)
  return w.done()
}

function nameTable(m: FontMetrics): Uint8Array {
  const style = m.bold && m.italic ? 'Bold Italic' : m.bold ? 'Bold' : m.italic ? 'Italic' : 'Regular'
  const records: [number, string][] = [
    [1, m.family],
    [2, style],
    [3, `${m.family} ${style}`],
    [4, `${m.family} ${style}`],
    [6, `${m.family}-${style}`.replace(/\s/g, '')],
  ]
  const strings = new Writer()
  const w = new Writer()
  w.u16(0)
  w.u16(records.length)
  w.u16(6 + records.length * 12)
  for (const [id, text] of records) {
    w.u16(3) /* windows */
    w.u16(1) /* unicode BMP */
    w.u16(0x0409)
    w.u16(id)
    w.u16(text.length * 2)
    w.u16(strings.length)
    for (const ch of text) strings.u16(ch.charCodeAt(0))
  }
  w.bytes(strings.done())
  return w.done()
}

/** Whether a cmap table has a subtable browsers read: Unicode on the
 *  Windows or Unicode platform. A Macintosh or symbol-only cmap is refused. */
function usableCmap(data: Uint8Array): boolean {
  if (data.length < 4) return false
  const count = (data[2]! << 8) | data[3]!
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8
    if (at + 8 > data.length) return false
    const platform = (data[at]! << 8) | data[at + 1]!
    const encoding = (data[at + 2]! << 8) | data[at + 3]!
    if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) return true
  }
  return false
}

function cmapTable(map: Map<number, number>, numGlyphs: number): Uint8Array {
  /* a glyph past the end would fail the whole table; a character the page
     drew with one is left unmapped instead */
  const entries = [...map].filter(([code, gid]) => code > 0 && gid >= 0 && gid < numGlyphs)
  const bmp = entries.filter(([code]) => code <= 0xffff).sort((a, b) => a[0] - b[0])
  const wide = entries.filter(([code]) => code > 0xffff).sort((a, b) => a[0] - b[0])
  /* format 4: one segment per run of consecutive codes, glyphs listed in glyphIdArray */
  const segments: [number, number][] = []
  for (const [code] of bmp) {
    const last = segments[segments.length - 1]
    if (last && last[1] === code - 1) last[1] = code
    else segments.push([code, code])
  }
  const segCount = segments.length + 1
  const f4 = new Writer()
  f4.u16(4)
  f4.u16(0) /* length, patched */
  f4.u16(0)
  f4.u16(segCount * 2)
  const search = 2 ** Math.floor(Math.log2(segCount))
  f4.u16(search * 2)
  f4.u16(Math.log2(search))
  f4.u16(segCount * 2 - search * 2)
  for (const [, end] of segments) f4.u16(end)
  f4.u16(0xffff)
  f4.u16(0)
  for (const [start] of segments) f4.u16(start)
  f4.u16(0xffff)
  for (let i = 0; i < segCount; i++) f4.u16(i === segCount - 1 ? 1 : 0) /* idDelta */
  let glyphIndex = 0
  segments.forEach((segment, i) => {
    /* offset from this idRangeOffset entry to the glyphIdArray entry */
    f4.u16((segCount - i + glyphIndex) * 2)
    glyphIndex += segment[1] - segment[0] + 1
  })
  f4.u16(0)
  for (const [, gid] of bmp) f4.u16(gid)
  const f4bytes = f4.done()
  new DataView(f4bytes.buffer).setUint16(2, f4bytes.length)
  const subtables: Uint8Array[] = [f4bytes]
  if (wide.length) {
    /* a browser that finds a format 12 table reads that one alone, so it
       carries every character, not only those past the BMP */
    const all = [...bmp, ...wide]
    const f12 = new Writer()
    f12.u16(12)
    f12.u16(0)
    f12.u32(16 + all.length * 12)
    f12.u32(0)
    f12.u32(all.length)
    for (const [code, gid] of all) {
      f12.u32(code)
      f12.u32(code)
      f12.u32(gid)
    }
    subtables.push(f12.done())
  }
  const w = new Writer()
  w.u16(0)
  w.u16(subtables.length)
  let offset = 4 + subtables.length * 8
  subtables.forEach((sub, i) => {
    w.u16(3)
    w.u16(i === 0 ? 1 : 10)
    w.u32(offset)
    offset += sub.length
  })
  for (const sub of subtables) w.bytes(sub)
  return w.done()
}

/* ---- the entry points ---- */

/** A TrueType program with every table a browser insists on. `null` when
 *  the bytes are not an sfnt or lack even the glyph tables. */
export function completeTrueType(bytes: Uint8Array, metrics: FontMetrics): Uint8Array | null {
  const tables = sfntTables(bytes)
  if (!tables) return null
  const has = (tag: string) => tables.some((t) => t.tag === tag)
  if (!has('glyf') || !has('loca') || !has('head') || !has('hhea') || !has('hmtx') || !has('maxp')) return null
  const cmap = tables.find((t) => t.tag === 'cmap')
  const cmapOk = !!cmap && usableCmap(cmap.data)
  if (has('OS/2') && cmapOk && has('name') && has('post')) return bytes
  const kept = tables.filter((t) => t.tag !== 'cmap' || cmapOk)
  const extra: Table[] = []
  if (!has('OS/2')) extra.push({ tag: 'OS/2', data: os2Table(metrics) })
  if (!cmapOk) extra.push({ tag: 'cmap', data: cmapTable(metrics.cmap, metrics.advances.length) })
  if (!has('name')) extra.push({ tag: 'name', data: nameTable(metrics) })
  if (!has('post')) extra.push({ tag: 'post', data: postTable() })
  return buildSfnt([...kept, ...extra], false)
}

/** A bare CFF program wrapped as an OpenType file. */
export function wrapCff(cff: Uint8Array, metrics: FontMetrics): Uint8Array | null {
  if (!isCff(cff)) return null
  const numGlyphs = metrics.advances.length
  if (!numGlyphs) return null
  return buildSfnt(
    [
      { tag: 'CFF ', data: cff },
      { tag: 'cmap', data: cmapTable(metrics.cmap, numGlyphs) },
      { tag: 'head', data: headTable(metrics) },
      { tag: 'hhea', data: hheaTable(metrics) },
      { tag: 'hmtx', data: hmtxTable(metrics) },
      { tag: 'maxp', data: maxpTable(numGlyphs) },
      { tag: 'name', data: nameTable(metrics) },
      { tag: 'OS/2', data: os2Table(metrics) },
      { tag: 'post', data: postTable() },
    ],
    true,
  )
}
