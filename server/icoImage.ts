import sharp from 'sharp'

/** Windows icon (.ico): what favicon services such as DuckDuckGo's serve, and the one web image format
 *  libvips cannot read. An entry is either a whole PNG or a headerless BMP (a DIB) with a 1-bit mask. */

const PNG_SIGNATURE = 0x474e5089
const MAX_SIDE = 256

interface Entry {
  width: number
  height: number
  bitCount: number
  offset: number
  size: number
}

export function isIco(buf: Buffer): boolean {
  return buf.length >= 6 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) > 0
}

function entries(buf: Buffer): Entry[] {
  const count = buf.readUInt16LE(4)
  if (buf.length < 6 + count * 16) throw new Error('Truncated icon')
  const list: Entry[] = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const entry = {
      width: buf[at] || 256,
      height: buf[at + 1] || 256,
      bitCount: buf.readUInt16LE(at + 6),
      size: buf.readUInt32LE(at + 8),
      offset: buf.readUInt32LE(at + 12),
    }
    if (entry.size > 0 && entry.offset + entry.size <= buf.length) list.push(entry)
  }
  if (!list.length) throw new Error('Icon has no readable images')
  return list
}

/** RGBA pixels of a DIB entry, top row first. */
function decodeDib(dib: Buffer): { data: Buffer; width: number; height: number } {
  if (dib.length < 40) throw new Error('Truncated icon image')
  const headerSize = dib.readUInt32LE(0)
  const width = dib.readInt32LE(4)
  const height = Math.abs(dib.readInt32LE(8)) / 2 // the XOR image and the AND mask, stacked
  const bitCount = dib.readUInt16LE(14)
  const compression = dib.readUInt32LE(16)
  const colorsUsed = dib.readUInt32LE(32)
  if (width < 1 || width > MAX_SIDE || height < 1 || height > MAX_SIDE || !Number.isInteger(height))
    throw new Error('Unsupported icon size')
  if (![1, 4, 8, 24, 32].includes(bitCount) || (compression !== 0 && !(compression === 3 && bitCount === 32)))
    throw new Error('Unsupported icon encoding')

  const paletteAt = headerSize + (compression === 3 ? 12 : 0)
  const paletteSize = bitCount <= 8 ? colorsUsed || 1 << bitCount : 0
  const pixelsAt = paletteAt + paletteSize * 4
  const stride = Math.ceil((width * bitCount) / 32) * 4
  const maskAt = pixelsAt + stride * height
  const maskStride = Math.ceil(width / 32) * 4
  const hasMask = dib.length >= maskAt + maskStride * height
  if (dib.length < maskAt) throw new Error('Truncated icon image')

  const data = Buffer.alloc(width * height * 4)
  let anyAlpha = false
  for (let y = 0; y < height; y++) {
    const row = pixelsAt + (height - 1 - y) * stride // rows are stored bottom-up
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4
      let b: number, g: number, r: number, a: number
      if (bitCount === 32 || bitCount === 24) {
        const at = row + x * (bitCount / 8)
        b = dib[at]!
        g = dib[at + 1]!
        r = dib[at + 2]!
        a = bitCount === 32 ? dib[at + 3]! : 255
      } else {
        const bit = x * bitCount
        const index = (dib[row + (bit >> 3)]! >> (8 - bitCount - (bit & 7))) & ((1 << bitCount) - 1)
        if (index >= paletteSize) throw new Error('Corrupt icon palette')
        const at = paletteAt + index * 4
        b = dib[at]!
        g = dib[at + 1]!
        r = dib[at + 2]!
        a = 255
      }
      if (bitCount === 32 && a) anyAlpha = true
      data[out] = r
      data[out + 1] = g
      data[out + 2] = b
      data[out + 3] = a
    }
  }
  // Transparency comes from the AND mask unless a 32-bit image carries its own alpha.
  if (hasMask && !(bitCount === 32 && anyAlpha)) {
    for (let y = 0; y < height; y++) {
      const row = maskAt + (height - 1 - y) * maskStride
      for (let x = 0; x < width; x++) {
        const transparent = (dib[row + (x >> 3)]! >> (7 - (x & 7))) & 1
        data[(y * width + x) * 4 + 3] = transparent ? 0 : 255
      }
    }
  } else if (bitCount === 32 && !anyAlpha) {
    for (let i = 3; i < data.length; i += 4) data[i] = 255
  }
  return { data, width, height }
}

/** sharp over any web image, ICO included: the icon's largest, deepest entry. */
export function readImage(buf: Buffer, options?: sharp.SharpOptions): sharp.Sharp {
  if (!isIco(buf)) return sharp(buf, options)
  const [best] = entries(buf).sort((a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount)
  const bytes = buf.subarray(best!.offset, best!.offset + best!.size)
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === PNG_SIGNATURE) return sharp(bytes, options)
  const { data, width, height } = decodeDib(bytes)
  return sharp(data, { ...options, raw: { width, height, channels: 4 } })
}
