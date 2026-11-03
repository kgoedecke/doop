import { brotliCompressSync, deflateSync } from 'node:zlib'

/**
 * Tiny synthetic font files for the font-library tests: just the tables the
 * reader looks at (name, OS/2, optionally fvar), wrapped as TrueType, WOFF or
 * WOFF2. No glyphs — browsers would refuse them, the reader must not care.
 */

interface FaceSpec {
  family: string
  subfamily?: string
  /** typographic family (name id 16), when it differs from the legacy one */
  typographic?: string
  weight?: number
  italic?: boolean
  /** a variable font's wght axis */
  wght?: [number, number]
}

function utf16be(text: string): Buffer {
  return Buffer.from(text, 'utf16le').swap16()
}

function nameTable(spec: FaceSpec): Buffer {
  const names: [number, string][] = [
    [1, spec.family],
    [2, spec.subfamily ?? 'Regular'],
    ...(spec.typographic ? ([[16, spec.typographic]] as [number, string][]) : []),
  ]
  const strings = names.map(([, value]) => utf16be(value))
  const header = Buffer.alloc(6 + names.length * 12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(names.length, 2)
  header.writeUInt16BE(header.length, 4)
  let offset = 0
  names.forEach(([id], i) => {
    const at = 6 + i * 12
    header.writeUInt16BE(3, at) // Windows
    header.writeUInt16BE(1, at + 2) // Unicode BMP
    header.writeUInt16BE(0x409, at + 4) // en-US
    header.writeUInt16BE(id, at + 6)
    header.writeUInt16BE(strings[i]!.length, at + 8)
    header.writeUInt16BE(offset, at + 10)
    offset += strings[i]!.length
  })
  return Buffer.concat([header, ...strings])
}

function os2Table(spec: FaceSpec): Buffer {
  const os2 = Buffer.alloc(96)
  os2.writeUInt16BE(4, 0)
  os2.writeUInt16BE(spec.weight ?? 400, 4)
  os2.writeUInt16BE(spec.italic ? 0x0001 : 0x0040, 62)
  return os2
}

function fvarTable([min, max]: [number, number]): Buffer {
  const fvar = Buffer.alloc(16 + 20)
  fvar.writeUInt16BE(1, 0)
  fvar.writeUInt16BE(16, 4) // axes offset
  fvar.writeUInt16BE(2, 6)
  fvar.writeUInt16BE(1, 8) // one axis
  fvar.writeUInt16BE(20, 10)
  fvar.write('wght', 16, 'latin1')
  fvar.writeInt32BE(min * 65536, 20)
  fvar.writeInt32BE(400 * 65536, 24)
  fvar.writeInt32BE(max * 65536, 28)
  return fvar
}

function tablesFor(spec: FaceSpec): [string, Buffer][] {
  return [
    ['OS/2', os2Table(spec)],
    ...(spec.wght ? ([['fvar', fvarTable(spec.wght)]] as [string, Buffer][]) : []),
    ['name', nameTable(spec)],
  ]
}

const pad4 = (buf: Buffer) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)])

export function ttf(spec: FaceSpec): Buffer {
  const tables = tablesFor(spec)
  const header = Buffer.alloc(12 + tables.length * 16)
  header.writeUInt32BE(0x00010000, 0)
  header.writeUInt16BE(tables.length, 4)
  let offset = header.length
  const bodies: Buffer[] = []
  tables.forEach(([tag, data], i) => {
    const at = 12 + i * 16
    header.write(tag, at, 'latin1')
    header.writeUInt32BE(offset, at + 8)
    header.writeUInt32BE(data.length, at + 12)
    const padded = pad4(data)
    bodies.push(padded)
    offset += padded.length
  })
  return Buffer.concat([header, ...bodies])
}

export function woff(spec: FaceSpec): Buffer {
  const tables = tablesFor(spec)
  const header = Buffer.alloc(44 + tables.length * 20)
  header.write('wOFF', 0, 'latin1')
  header.writeUInt32BE(0x00010000, 4)
  header.writeUInt16BE(tables.length, 12)
  let offset = header.length
  const bodies: Buffer[] = []
  tables.forEach(([tag, data], i) => {
    const at = 44 + i * 20
    const packed = deflateSync(data)
    const stored = packed.length < data.length ? packed : data
    header.write(tag, at, 'latin1')
    header.writeUInt32BE(offset, at + 4)
    header.writeUInt32BE(stored.length, at + 8)
    header.writeUInt32BE(data.length, at + 12)
    const padded = pad4(stored)
    bodies.push(padded)
    offset += padded.length
  })
  return Buffer.concat([header, ...bodies])
}

const WOFF2_INDEX: Record<string, number> = { name: 5, 'OS/2': 6, fvar: 47 }

/** UIntBase128, WOFF2's variable-length integer */
function base128(value: number): number[] {
  const bytes = [value & 0x7f]
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7f) | 0x80)
  return bytes
}

/** `padName` grows the name table past 127 bytes, so its length needs more
 *  than one base128 byte; `declare` overrides the lengths the directory
 *  claims, for files that lie about their size. */
export function woff2(spec: FaceSpec & { padName?: number; declare?: number }): Buffer {
  const tables = tablesFor(spec).map(([tag, data]): [string, Buffer] =>
    tag === 'name' && spec.padName ? [tag, Buffer.concat([data, Buffer.alloc(spec.padName)])] : [tag, data],
  )
  const directory = Buffer.from(
    tables.flatMap(([tag, data]) => [WOFF2_INDEX[tag]!, ...base128(spec.declare ?? data.length)]),
  )
  const stream = brotliCompressSync(Buffer.concat(tables.map(([, data]) => data)))
  const header = Buffer.alloc(48)
  header.write('wOF2', 0, 'latin1')
  header.writeUInt32BE(0x00010000, 4)
  header.writeUInt16BE(tables.length, 12)
  header.writeUInt32BE(stream.length, 20)
  return Buffer.concat([header, directory, stream])
}

/** A WOFF whose name table claims `origLength` bytes once inflated. */
export function woffClaiming(spec: FaceSpec, origLength: number): Buffer {
  const file = woff(spec)
  const count = file.readUInt16BE(12)
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20
    if (file.toString('latin1', at, at + 4) === 'name') file.writeUInt32BE(origLength, at + 12)
  }
  return file
}

/** A WOFF whose directory lists its `name` table `times` over, every entry
 *  pointing at the same compressed bytes — the shape that would make a reader
 *  inflate one table once per entry. */
export function woffRepeating(spec: FaceSpec, times: number): Buffer {
  const file = woff(spec)
  const count = file.readUInt16BE(12)
  const entries: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const entry = Buffer.from(file.subarray(44 + i * 20, 64 + i * 20))
    entries.push(entry)
    if (entry.toString('latin1', 0, 4) === 'name') for (let n = 1; n < times; n++) entries.push(Buffer.from(entry))
  }
  const grown = (entries.length - count) * 20
  for (const entry of entries) entry.writeUInt32BE(entry.readUInt32BE(4) + grown, 4)
  const header = Buffer.from(file.subarray(0, 44))
  header.writeUInt16BE(entries.length, 12)
  return Buffer.concat([header, ...entries, file.subarray(44 + count * 20)])
}
