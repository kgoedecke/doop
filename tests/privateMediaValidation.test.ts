import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createMaterializationRunner } from '../server/materializationJob.ts'
import { validateMediaInputs } from '../server/privateMediaValidation.ts'
import { assertSelfContainedSvg, validateMedia, type MediaInput } from '../server/privateMediaFiles.ts'
import { PrivateMediaBudget, PrivateMaterializationError } from '../shared/privateMedia.ts'
import { inspectFontFile } from '../server/fontFile.ts'
import { woff, woff2 } from './fontFiles.ts'

afterEach(() => vi.restoreAllMocks())

it.each(['woff', 'woff2'] as const)(
  '%s directory cost is reserved before its real decompressor is allowed to run',
  async (format) => {
    const valid = (format === 'woff' ? woff : woff2)({ family: 'Pre-inflate admission '.repeat(15) })
    const expected = inspectFontFile(valid)
    expect(expected.read().decodedBytes).toBe(expected.decodedBytes)
    const corrupt = Buffer.from(valid)
    if (format === 'woff2') {
      corrupt.fill(0, corrupt.length - corrupt.readUInt32BE(20))
    } else {
      const offset = corrupt.readUInt32BE(48)
      const length = corrupt.readUInt32BE(52)
      expect(length).toBeLessThan(corrupt.readUInt32BE(56))
      corrupt.fill(0, offset, offset + length)
    }
    const layout = inspectFontFile(corrupt)
    expect(layout.decodedBytes).toBe(expected.decodedBytes)
    expect(() => layout.read()).toThrow()
    const input = { bytes: corrupt, mime: `font/${format}` }
    const deny = () => {
      throw new PrivateMaterializationError('limit')
    }
    await expect(validateMedia(input, async () => deny())).rejects.toMatchObject({ kind: 'limit' })
    await expect(createMaterializationRunner()((job) => validateMediaInputs(job, [input], deny))).rejects.toMatchObject(
      { kind: 'limit' },
    )
  },
)

async function validate(items: readonly MediaInput[]) {
  const budget = new PrivateMediaBudget()
  return createMaterializationRunner()((job) =>
    validateMediaInputs(job, items, (cost) => budget.chargeDecoded(cost.decodedBytes)),
  )
}

it('the actual decoder worker validates a real PNG and private WOFF2 before browser use', async () => {
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: 'green' } })
    .png()
    .toBuffer()
  const font = await readFile('tests/fixtures/fonts/nunito-sans-bold-italic.woff2')
  const result = await validate([
    { bytes: png, mime: 'image/png' },
    { bytes: font, mime: 'font/woff2' },
  ])
  expect(result[0]).toEqual({ decodedBytes: 16 * 16 * 4, width: 16, height: 16, pages: 1 })
  expect(result[1]!.decodedBytes).toBeGreaterThan(font.length)
})

it('a compressed-small 100M-pixel PNG is rejected before any forbidden raw decoder allocation', async () => {
  const bytes = await readFile('tests/fixtures/compressed-100m-pixel.png')
  expect(bytes.length).toBeLessThan(100_000)
  const raw = vi.spyOn(sharp.prototype, 'toBuffer')
  const admitted = vi.fn(async () => {})
  await expect(validateMedia({ bytes, mime: 'image/png' }, admitted)).rejects.toBeInstanceOf(
    PrivateMaterializationError,
  )
  expect(admitted).not.toHaveBeenCalled()
  expect(raw).not.toHaveBeenCalled()
  await expect(validate([{ bytes, mime: 'image/png' }])).rejects.toBeInstanceOf(PrivateMaterializationError)
})

it('individually valid compressed images cannot exceed the shared intrinsic decoded aggregate', async () => {
  const items = await Promise.all(
    Array.from({ length: 5 }, async (_, index) => ({
      bytes: await sharp({
        create: { width: 2_000, height: 2_000, channels: 4, background: { r: index + 10, g: 30, b: 50, alpha: 1 } },
      })
        .png()
        .toBuffer(),
      mime: 'image/png',
    })),
  )
  expect(items.reduce((sum, item) => sum + item.bytes.length, 0)).toBeLessThan(1_000_000)
  let admitted = 0
  const budget = new PrivateMediaBudget()
  await expect(
    createMaterializationRunner()((job) =>
      validateMediaInputs(job, items, (cost) => {
        budget.chargeDecoded(cost.decodedBytes)
        admitted++
      }),
    ),
  ).rejects.toBeInstanceOf(PrivateMaterializationError)
  expect(admitted).toBe(4)
})

it('actual animated GIF admission charges both frames without multiplying stacked height twice', async () => {
  const pixels = Buffer.alloc(2 * 4 * 4)
  for (let at = 0; at < 8; at++) {
    pixels[at * 4 + (at < 4 ? 0 : 1)] = 255
    pixels[at * 4 + 3] = 255
  }
  const gif = await sharp(pixels, { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } })
    .gif({ delay: [40, 40] })
    .toBuffer()
  expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2)
  await expect(validate([{ bytes: gif, mime: 'image/gif' }])).resolves.toEqual([
    { decodedBytes: 2 * 2 * 2 * 4, width: 2, height: 2, pages: 2 },
  ])
})

it('a denied shared reservation prevents the actual raster decoder from allocating its output', async () => {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: 'red' } })
    .png()
    .toBuffer()
  const raw = vi.spyOn(sharp.prototype, 'toBuffer')
  await expect(
    validateMedia({ bytes, mime: 'image/png' }, async () => {
      throw new PrivateMaterializationError('limit')
    }),
  ).rejects.toBeInstanceOf(PrivateMaterializationError)
  expect(raw).not.toHaveBeenCalled()
})

it('SVG file policy rejects hidden network and dynamic URL carriers while allowing local fragments', async () => {
  const wrap = (content: string) =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">${content}</svg>`)
  expect(() => assertSelfContainedSvg(wrap('<defs><path id="p" d="M0 0h8v8z"/></defs><use href="#p"/>'))).not.toThrow()
  for (const content of [
    '<image href="/a/foreign.png"/>',
    '<image href="https://foreign.invalid/image.png"/>',
    '<style>@import "https://foreign.invalid/style.css";</style>',
    '<g xml:base="https://foreign.invalid/"><use href="#p"/></g>',
    '<use xmlns:a="http://www.w3.org/1999/xlink" a:href="https://foreign.invalid/x.svg"/>',
    '<set attributeName="href" to="https://foreign.invalid/image.png"/>',
    '<style><![CDATA[rect{fill:url(https://foreign.invalid/image.png)}]]></style>',
    '<script>fetch("https://foreign.invalid")</script>',
  ])
    expect(() => assertSelfContainedSvg(wrap(content))).toThrow(PrivateMaterializationError)
  const admitted = await validate([
    { bytes: wrap('<rect width="16" height="16" fill="green"/>'), mime: 'image/svg+xml' },
  ])
  expect(admitted[0]).toMatchObject({ decodedBytes: 1024, width: 16, height: 16, pages: 1 })
  expect(admitted[0]!.parserWork).toBeGreaterThan(0)
})
