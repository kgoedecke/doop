import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { isIco, readImage } from '../server/icoImage.ts'
import { bitfieldsIcon, dibIcon, icon } from './icoFixture.ts'

async function rgba(buf: Buffer) {
  const { data, info } = await readImage(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)]
  return { width: info.width, height: info.height, at }
}

describe('readImage', () => {
  it('decodes a 32-bit icon top row first, keeping its alpha', async () => {
    const buf = dibIcon(4, 32, (x, y) => (y === 0 ? [255, 0, 0, 255] : x === 3 ? [0, 0, 0, 0] : [0, 0, 255, 128]))
    expect(isIco(buf)).toBe(true)
    const image = await rgba(buf)
    expect([image.width, image.height]).toEqual([4, 4])
    expect(image.at(0, 0)).toEqual([255, 0, 0, 255])
    expect(image.at(1, 2)).toEqual([0, 0, 255, 128])
    expect(image.at(3, 3)[3]).toBe(0)
  })

  it('reads a palette icon with its transparency mask', async () => {
    const image = await rgba(dibIcon(9, 8, (x) => (x < 4 ? [0, 128, 0, 255] : [0, 0, 0, 0])))
    expect(image.at(1, 5)).toEqual([0, 128, 0, 255])
    expect(image.at(8, 5)[3]).toBe(0)
  })

  const BGRA = { r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff, a: 0xff000000 }
  const RGBA = { r: 0x000000ff, g: 0x0000ff00, b: 0x00ff0000, a: 0xff000000 }
  const pixel = (x: number, y: number): [number, number, number, number] =>
    y === 0 ? [255, 0, 0, 255] : x === 3 ? [0, 0, 0, 0] : [10, 200, 30, 128]

  it.each([40, 108, 124] as const)('reads a BI_BITFIELDS icon with a %i-byte header', async (headerSize) => {
    const image = await rgba(bitfieldsIcon(4, headerSize, BGRA, pixel))
    expect(image.at(0, 0)).toEqual([255, 0, 0, 255])
    expect(image.at(1, 2)).toEqual([10, 200, 30, 128])
    expect(image.at(3, 3)[3]).toBe(0)
  })

  it('reads channels by their masks rather than as BGRA', async () => {
    const image = await rgba(bitfieldsIcon(4, 124, RGBA, pixel))
    expect(image.at(0, 0)).toEqual([255, 0, 0, 255])
    expect(image.at(1, 2)).toEqual([10, 200, 30, 128])
  })

  it('picks the largest entry, PNG entries included', async () => {
    const png = await sharp({ create: { width: 48, height: 48, channels: 4, background: '#123456' } })
      .png()
      .toBuffer()
    const small = dibIcon(16, 32, () => [255, 255, 255, 255]).subarray(22)
    const image = await rgba(icon([small, png], [16, 48]))
    expect([image.width, image.height]).toEqual([48, 48])
    expect(image.at(10, 10)).toEqual([0x12, 0x34, 0x56, 255])
  })

  it('leaves every other format to sharp', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })
      .png()
      .toBuffer()
    expect(isIco(png)).toBe(false)
    expect((await rgba(png)).width).toBe(2)
  })

  it('rejects a truncated icon instead of reading past it', () => {
    const buf = dibIcon(4, 32, () => [0, 0, 0, 255])
    expect(() => readImage(buf.subarray(0, 40))).toThrow()
  })
})
