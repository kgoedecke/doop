import { FONT_FILE_TYPES, fontFormatOf, sniffMime } from './mediaTypes.ts'
import { PRIVATE_MEDIA_LIMITS, PrivateMaterializationError } from './privateMedia.ts'

export interface InlineMedia {
  readonly bytes: Uint8Array
  readonly mime: string
  readonly syntax?: 'html' | 'stylesheet'
}

function percentBytes(source: string): Uint8Array {
  let length = 0
  for (const char of source) {
    const code = char.codePointAt(0)!
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (length > PRIVATE_MEDIA_LIMITS.encodedBytes) throw new PrivateMaterializationError('limit')
  }
  const encoded = new TextEncoder().encode(source)
  const bytes = new Uint8Array(encoded.length)
  let next = 0
  for (let at = 0; at < encoded.length; at++) {
    if (encoded[at] !== 0x25) bytes[next++] = encoded[at]!
    else {
      const hex = String.fromCharCode(encoded[at + 1] ?? 0, encoded[at + 2] ?? 0)
      if (!/^[\da-f]{2}$/i.test(hex)) throw new PrivateMaterializationError('invalid')
      bytes[next++] = Number.parseInt(hex, 16)
      at += 2
    }
  }
  return bytes.slice(0, next)
}

/** Data URLs are content too: validate their actual media signature even when
 * a text/plain declaration would otherwise hide a browser-sniffed image/font. */
export function inlineMedia(raw: string, kind: 'media' | 'stylesheet' | 'source' = 'source'): InlineMedia | undefined {
  if (!/^data:/i.test(raw)) return undefined
  const comma = raw.indexOf(',')
  if (comma < 0 || comma > 1024) throw new PrivateMaterializationError('invalid')
  const header = raw.slice(5, comma).split(';')
  const declared = header[0]?.toLowerCase() || 'text/plain'
  const hash = raw.indexOf('#', comma)
  const payload = raw.slice(comma + 1, hash < 0 ? undefined : hash)
  let bytes = percentBytes(payload)
  if (header.slice(1).some((value) => value.toLowerCase() === 'base64')) {
    const encoded = new TextDecoder().decode(bytes).replace(/[\t\n\r ]/g, '')
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      encoded.length % 4 === 1 ||
      (encoded.includes('=') && encoded.length % 4 !== 0)
    )
      throw new PrivateMaterializationError('invalid')
    if (Math.floor((encoded.length * 3) / 4) > PRIVATE_MEDIA_LIMITS.encodedBytes)
      throw new PrivateMaterializationError('limit')
    try {
      bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    } catch {
      throw new PrivateMaterializationError('invalid')
    }
  }
  const image = sniffMime(bytes)
  if (image) return { bytes, mime: image }
  const font = fontFormatOf(bytes)
  if (font === 'collection') throw new PrivateMaterializationError('unsupported')
  if (font) return { bytes, mime: FONT_FILE_TYPES[font].mime }
  if (kind === 'media' || (kind === 'stylesheet' && declared !== 'text/css'))
    throw new PrivateMaterializationError('unsupported')
  if (declared.startsWith('image/') || declared.startsWith('font/')) return { bytes, mime: declared }
  if (declared === 'text/html' || declared === 'text/css')
    return { bytes, mime: declared, syntax: declared === 'text/html' ? 'html' : 'stylesheet' }
  if (['text/plain', 'text/javascript', 'application/javascript'].includes(declared)) return undefined
  throw new PrivateMaterializationError('unsupported')
}
