/** Windows icons built byte by byte, the shape favicon services such as DuckDuckGo's serve. */

/** One-entry .ico around a DIB: BGRA (32-bit) or palette indexes (8-bit), bottom-up, plus an AND mask. */
export function dibIcon(
  size: number,
  bitCount: 32 | 8,
  pixel: (x: number, y: number) => [number, number, number, number],
) {
  const palette: number[][] = []
  const stride = Math.ceil((size * bitCount) / 32) * 4
  const maskStride = Math.ceil(size / 32) * 4
  const pixels = Buffer.alloc(stride * size)
  const mask = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      if (bitCount === 32) pixels.set([b, g, r, a], row * stride + x * 4)
      else {
        let index = palette.findIndex((c) => c[0] === r && c[1] === g && c[2] === b)
        if (index < 0) index = palette.push([r, g, b]) - 1
        pixels[row * stride + x] = index
        if (!a) mask[row * maskStride + (x >> 3)]! |= 0x80 >> (x & 7)
      }
    }
  }
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(bitCount, 14)
  header.writeUInt32LE(bitCount === 8 ? palette.length : 0, 32)
  const colors = Buffer.from(palette.flatMap(([r, g, b]) => [b!, g!, r!, 0]))
  return icon([Buffer.concat([header, colors, pixels, mask])], [size])
}

/** One-entry .ico around a 32-bit BI_BITFIELDS DIB: the RGBA masks trail a 40-byte header or sit inside
 *  a V4 (108) or V5 (124) one, whose alpha mask a 40-byte header has no room for. */
export function bitfieldsIcon(
  size: number,
  headerSize: 40 | 108 | 124,
  masks: { r: number; g: number; b: number; a: number },
  pixel: (x: number, y: number) => [number, number, number, number],
) {
  const pack = (value: number, mask: number) => {
    if (!mask) return 0
    const shift = 31 - Math.clz32(mask & -mask)
    return ((Math.round((value * (mask >>> shift)) / 255) << shift) & mask) >>> 0
  }
  const pixels = Buffer.alloc(size * 4 * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      const value = pack(r, masks.r) | pack(g, masks.g) | pack(b, masks.b) | pack(a, masks.a)
      pixels.writeUInt32LE(value >>> 0, ((size - 1 - y) * size + x) * 4)
    }
  }
  const header = Buffer.alloc(headerSize === 40 ? 52 : headerSize)
  header.writeUInt32LE(headerSize, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(3, 16)
  header.writeUInt32LE(masks.r, 40)
  header.writeUInt32LE(masks.g, 44)
  header.writeUInt32LE(masks.b, 48)
  if (headerSize !== 40) header.writeUInt32LE(masks.a, 52)
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  return icon([Buffer.concat([header, pixels, mask])], [size])
}

export function icon(images: Buffer[], sizes: number[]) {
  const dir = Buffer.alloc(6 + images.length * 16)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(images.length, 4)
  let offset = dir.length
  images.forEach((image, i) => {
    const at = 6 + i * 16
    dir[at] = sizes[i]! % 256
    dir[at + 1] = sizes[i]! % 256
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(image.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += image.length
  })
  return Buffer.concat([dir, ...images])
}
