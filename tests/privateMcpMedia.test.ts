import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
import { createMaterializationRunner } from '../server/materializationJob.ts'
import { prepareMediaPreview } from '../server/privateMediaValidation.ts'
import { makeMediaPreview } from '../server/privateMediaPreview.ts'
import { MAX_INLINE_MCP_MEDIA_BYTES, PrivateMaterializationError, PrivateMediaBudget } from '../shared/privateMedia.ts'

afterEach(() => vi.restoreAllMocks())

function preview(bytes: Uint8Array) {
  const budget = new PrivateMediaBudget()
  return createMaterializationRunner()((job) =>
    prepareMediaPreview(job, bytes, (cost) => budget.chargeDecoded(cost.decodedBytes)),
  )
}

it.each(['png', 'jpeg'] as const)('small %s output preserves the actual full bytes', async (format) => {
  const source = await sharp({ create: { width: 16, height: 8, channels: 4, background: 'green' } })
    .toFormat(format)
    .toBuffer()
  const result = await preview(source)
  expect(Buffer.from(result.bytes)).toEqual(source)
  expect(result.mime).toBe(format === 'png' ? 'image/png' : 'image/jpeg')
  expect(result).toMatchObject({ width: 16, height: 8, fullWidth: 16, fullHeight: 8, fullResolution: true })
})

it('a dense real PNG becomes a nonblank bounded JPEG with truthful aspect and dimensions', async () => {
  const pixels = Buffer.alloc(768 * 384 * 3)
  let seed = 0x73579328
  for (let at = 0; at < pixels.length; at++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    pixels[at] = seed & 0xff
  }
  const source = await sharp(pixels, { raw: { width: 768, height: 384, channels: 3 } })
    .png()
    .toBuffer()
  expect(source.length).toBeGreaterThan(MAX_INLINE_MCP_MEDIA_BYTES)
  const result = await preview(source)
  expect(result.bytes.length).toBeLessThanOrEqual(MAX_INLINE_MCP_MEDIA_BYTES)
  expect(Buffer.from(result.bytes).toString('base64').length).toBeLessThanOrEqual(16_384)
  expect(result).toMatchObject({ mime: 'image/jpeg', fullWidth: 768, fullHeight: 384, fullResolution: false })
  expect(result.width).toBeLessThanOrEqual(512)
  expect(result.width / result.height).toBeCloseTo(2, 1)
  const decoded = sharp(result.bytes)
  expect(await decoded.metadata()).toMatchObject({ format: 'jpeg', width: result.width, height: result.height })
  expect((await decoded.stats()).channels.some((channel) => channel.stdev > 1)).toBe(true)
})

it('preview admission rejection prevents any raw decode or JPEG encode', async () => {
  const source = await sharp({ create: { width: 16, height: 8, channels: 4, background: 'green' } })
    .png()
    .toBuffer()
  const allocations = vi.spyOn(sharp.prototype, 'toBuffer')
  await expect(
    makeMediaPreview(source, async () => {
      throw new PrivateMaterializationError('limit')
    }),
  ).rejects.toBeInstanceOf(PrivateMaterializationError)
  expect(allocations).not.toHaveBeenCalled()
})

it('a compressed 100M-pixel source cannot enter the preview decoder despite its small encoding', async () => {
  const bytes = await readFile('tests/fixtures/compressed-100m-pixel.png')
  const allocations = vi.spyOn(sharp.prototype, 'toBuffer')
  const admit = vi.fn(async () => {})
  await expect(makeMediaPreview(bytes, admit)).rejects.toMatchObject({ kind: 'limit' })
  expect(admit).not.toHaveBeenCalled()
  expect(allocations).not.toHaveBeenCalled()
  await expect(preview(bytes)).rejects.toMatchObject({ kind: 'limit' })
})
