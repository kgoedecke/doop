import type { ImageSize } from '../shared/canvasImage.ts'

/**
 * The pixel size of an uploaded image, read from its header: what a browser
 * reports as naturalWidth / naturalHeight, which is what a dropped image is
 * sized by. No image library: every format states its size in its first
 * bytes, and nothing here decodes pixels.
 */

/** What a browser gives an image whose size it cannot tell, as the paste
 *  path does. */
export const UNKNOWN_IMAGE_SIZE: ImageSize = { width: 512, height: 512 }

function sized(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined
}

function pngSize(buf: Buffer): ImageSize | undefined {
  if (buf.length < 24) return undefined
  return sized(buf.readUInt32BE(16), buf.readUInt32BE(20))
}

function gifSize(buf: Buffer): ImageSize | undefined {
  if (buf.length < 10) return undefined
  return sized(buf.readUInt16LE(6), buf.readUInt16LE(8))
}

function webpSize(buf: Buffer): ImageSize | undefined {
  if (buf.length < 30) return undefined
  const chunk = buf.toString('latin1', 12, 16)
  if (chunk === 'VP8X') return sized(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1)
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21)
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8 ') return sized(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff)
  return undefined
}

const EXIF_ORIENTATION_TAG = 0x0112

/** The EXIF orientation in an APP1 segment's payload, 1 (upright) when it
 *  states none. */
function exifOrientation(segment: Buffer): number {
  if (segment.toString('latin1', 0, 6) !== 'Exif\0\0') return 1
  const tiff = segment.subarray(6)
  if (tiff.length < 8) return 1
  const little = tiff.toString('latin1', 0, 2) === 'II'
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at))
  const directory = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4)
  if (directory + 2 > tiff.length) return 1
  const entries = u16(directory)
  for (let i = 0; i < entries; i++) {
    const entry = directory + 2 + i * 12
    if (entry + 12 > tiff.length) return 1
    if (u16(entry) === EXIF_ORIENTATION_TAG) return u16(entry + 8)
  }
  return 1
}

/** Start-of-frame markers carry the size; C4, C8 and CC share the range but
 *  are tables. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegSize(buf: Buffer): ImageSize | undefined {
  let orientation = 1
  let at = 2
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return undefined
    const marker = buf[at + 1] ?? 0
    /* fill bytes and markers without a payload */
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    const length = buf.readUInt16BE(at + 2)
    if (length < 2) return undefined
    if (isStartOfFrame(marker)) {
      if (at + 9 > buf.length) return undefined
      const height = buf.readUInt16BE(at + 5)
      const width = buf.readUInt16BE(at + 7)
      /* orientations 5-8 turn the picture a quarter, as a phone's portrait
         photo is stored: the browser shows it turned, so its size swaps */
      return orientation >= 5 && orientation <= 8 ? sized(height, width) : sized(width, height)
    }
    if (marker === 0xe1) orientation = exifOrientation(buf.subarray(at + 4, at + 2 + length))
    at += 2 + length
  }
  return undefined
}

/** A length attribute in CSS px; a percentage or a unit that needs a context
 *  says nothing about the size. */
function svgLength(value: string | undefined): number | undefined {
  const match = /^\s*(\d*\.?\d+)\s*(px)?\s*$/i.exec(value ?? '')
  const size = match ? Number(match[1]) : NaN
  return size > 0 ? size : undefined
}

function svgSize(buf: Buffer): ImageSize | undefined {
  const tag = /<svg\b[^>]*>/i.exec(buf.toString('utf8', 0, Math.min(buf.length, 4096)))?.[0]
  if (!tag) return undefined
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]
  const box = (attribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  /* a size stated on one side only takes the other from the viewBox's
     proportions, as the browser lays it out */
  const ratio = box.length === 4 && box[2]! > 0 && box[3]! > 0 ? box[2]! / box[3]! : undefined
  const statedWidth = svgLength(attribute('width'))
  const statedHeight = svgLength(attribute('height'))
  const width = statedWidth ?? (ratio && (statedHeight ? statedHeight * ratio : box[2]))
  const height = statedHeight ?? (ratio && (statedWidth ? statedWidth / ratio : box[3]))
  if (!width || !height) return undefined
  return sized(Math.round(width), Math.round(height))
}

const READERS: Record<string, (buf: Buffer) => ImageSize | undefined> = {
  'image/png': pngSize,
  'image/jpeg': jpegSize,
  'image/gif': gifSize,
  'image/webp': webpSize,
  'image/svg+xml': svgSize,
}

/** The size of an image of the given sniffed type, or UNKNOWN_IMAGE_SIZE for
 *  a header that does not state one. */
export function imageSize(buf: Buffer, mime: string): ImageSize {
  try {
    return READERS[mime]?.(buf) ?? UNKNOWN_IMAGE_SIZE
  } catch {
    /* a truncated header reads past the end */
    return UNKNOWN_IMAGE_SIZE
  }
}
