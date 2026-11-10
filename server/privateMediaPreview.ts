import sharp from 'sharp'
import {
  MAX_INLINE_MCP_MEDIA_BYTES,
  PRIVATE_MEDIA_LIMITS,
  PrivateMaterializationError,
  rasterDecodedBytes,
} from '../shared/privateMedia.ts'
import type { MediaAdmission } from './privateMediaFiles.ts'

export interface McpMediaPreview {
  readonly bytes: Uint8Array
  readonly mime: 'image/png' | 'image/jpeg'
  readonly width: number
  readonly height: number
  readonly fullWidth: number
  readonly fullHeight: number
  readonly fullResolution: boolean
}

/** Worker-only: decode/downsample once, then try a fixed, bounded set of encodes. */
export async function makeMediaPreview(
  input: Uint8Array,
  admit: (cost: MediaAdmission) => Promise<void>,
): Promise<McpMediaPreview> {
  try {
    if (!input.length || input.length > PRIVATE_MEDIA_LIMITS.encodedBytes)
      throw new PrivateMaterializationError('limit')
    const bytes = Buffer.from(input)
    const image = sharp(bytes, { limitInputPixels: PRIVATE_MEDIA_LIMITS.pixels })
    const metadata = await image.metadata()
    if (!['png', 'jpeg'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
      throw new PrivateMaterializationError('invalid')
    const fullWidth = metadata.width ?? 0
    const fullHeight = metadata.height ?? 0
    await admit({
      decodedBytes: rasterDecodedBytes(fullWidth, fullHeight),
      width: fullWidth,
      height: fullHeight,
      pages: 1,
    })
    const raw = await image
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (bytes.length <= MAX_INLINE_MCP_MEDIA_BYTES)
      return {
        bytes,
        mime: metadata.format === 'png' ? 'image/png' : 'image/jpeg',
        width: fullWidth,
        height: fullHeight,
        fullWidth,
        fullHeight,
        fullResolution: true,
      }
    for (const side of [512, 384, 256, 192, 128, 96, 64]) {
      for (const quality of [75, 55, 35]) {
        const encoded = await sharp(raw.data, { raw: raw.info })
          .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#fff' })
          .jpeg({ quality })
          .toBuffer({ resolveWithObject: true })
        if (encoded.data.length <= MAX_INLINE_MCP_MEDIA_BYTES)
          return {
            bytes: encoded.data,
            mime: 'image/jpeg',
            width: encoded.info.width,
            height: encoded.info.height,
            fullWidth,
            fullHeight,
            fullResolution: false,
          }
      }
    }
    throw new PrivateMaterializationError('limit')
  } catch (error) {
    if (error instanceof PrivateMaterializationError) throw error
    throw new PrivateMaterializationError(
      error instanceof Error && error.message === 'Input image exceeds pixel limit' ? 'limit' : 'invalid',
    )
  }
}
