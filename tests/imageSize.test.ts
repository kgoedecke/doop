import { describe, expect, it } from 'vitest'
import { imageSize, UNKNOWN_IMAGE_SIZE } from '../server/imageSize.ts'

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10)
  buf.write('GIF89a', 0, 'latin1')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}

/** An APP1 segment whose only tag is the orientation. */
function exif(orientation: number, little: boolean): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12)
  tiff.write(little ? 'II' : 'MM', 0, 'latin1')
  const u16 = (value: number, at: number) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at))
  const u32 = (value: number, at: number) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at))
  u16(42, 2)
  u32(8, 4)
  u16(1, 8)
  u16(0x0112, 10)
  u16(3, 12)
  u32(1, 14)
  u16(orientation, 18)
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]))
}

function jpeg(width: number, height: number, ...before: Buffer[]): Buffer {
  const frame = Buffer.alloc(6)
  frame[0] = 8
  frame.writeUInt16BE(height, 1)
  frame.writeUInt16BE(width, 3)
  /* a huffman table shares the start-of-frame range and must be skipped */
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...before, segment(0xc4, Buffer.alloc(4)), segment(0xc2, frame)])
}

function webp(chunk: string, write: (buf: Buffer) => void): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'latin1')
  buf.write('WEBP', 8, 'latin1')
  buf.write(chunk, 12, 'latin1')
  write(buf)
  return buf
}

describe('image sizes read from the header', () => {
  it('reads PNG and GIF', () => {
    expect(imageSize(png(1200, 630), 'image/png')).toEqual({ width: 1200, height: 630 })
    expect(imageSize(gif(320, 240), 'image/gif')).toEqual({ width: 320, height: 240 })
  })

  it('reads a JPEG past its tables', () => {
    expect(imageSize(jpeg(4000, 3000), 'image/jpeg')).toEqual({ width: 4000, height: 3000 })
  })

  it('swaps a JPEG the camera stored on its side, in either byte order', () => {
    expect(imageSize(jpeg(4000, 3000, exif(6, true)), 'image/jpeg')).toEqual({ width: 3000, height: 4000 })
    expect(imageSize(jpeg(4000, 3000, exif(8, false)), 'image/jpeg')).toEqual({ width: 3000, height: 4000 })
    expect(imageSize(jpeg(4000, 3000, exif(3, false)), 'image/jpeg')).toEqual({ width: 4000, height: 3000 })
  })

  it('reads every WebP flavour', () => {
    const extended = webp('VP8X', (buf) => {
      buf.writeUIntLE(799, 24, 3)
      buf.writeUIntLE(599, 27, 3)
    })
    const lossless = webp('VP8L', (buf) => {
      buf[20] = 0x2f
      buf.writeUInt32LE((800 - 1) | ((600 - 1) << 14), 21)
    })
    const lossy = webp('VP8 ', (buf) => {
      buf.writeUInt16LE(800, 26)
      buf.writeUInt16LE(600, 28)
    })
    for (const file of [extended, lossless, lossy])
      expect(imageSize(file, 'image/webp')).toEqual({ width: 800, height: 600 })
  })

  it('reads an SVG from its size, else its viewBox', () => {
    const svg = (attributes: string) => Buffer.from(`<?xml version="1.0"?><svg xmlns="x" ${attributes}><path/></svg>`)
    expect(imageSize(svg('width="24" height="32px"'), 'image/svg+xml')).toEqual({ width: 24, height: 32 })
    expect(imageSize(svg('viewBox="0 0 640 480"'), 'image/svg+xml')).toEqual({ width: 640, height: 480 })
    expect(imageSize(svg('width="100%" height="100%" viewBox="0,0,48,24"'), 'image/svg+xml')).toEqual({
      width: 48,
      height: 24,
    })
    /* one side stated: the other follows the viewBox's proportions */
    expect(imageSize(svg('width="600" viewBox="0 0 100 50"'), 'image/svg+xml')).toEqual({ width: 600, height: 300 })
    expect(imageSize(svg('height="10" viewBox="0 0 100 50"'), 'image/svg+xml')).toEqual({ width: 20, height: 10 })
    expect(imageSize(svg('width="600"'), 'image/svg+xml')).toEqual(UNKNOWN_IMAGE_SIZE)
    expect(imageSize(svg(''), 'image/svg+xml')).toEqual(UNKNOWN_IMAGE_SIZE)
  })

  it('falls back on a header cut short or stating nothing', () => {
    expect(imageSize(png(1200, 630).subarray(0, 18), 'image/png')).toEqual(UNKNOWN_IMAGE_SIZE)
    expect(imageSize(png(0, 630), 'image/png')).toEqual(UNKNOWN_IMAGE_SIZE)
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0]), 'image/jpeg')).toEqual(UNKNOWN_IMAGE_SIZE)
  })
})
