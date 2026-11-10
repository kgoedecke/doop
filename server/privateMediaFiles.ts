import sharp from 'sharp'
import { inspectFontFile } from './fontFile.ts'
import { visitPrivateReferences } from '../shared/privateReferences.ts'
import { PRIVATE_MEDIA_LIMITS, PrivateMaterializationError, rasterDecodedBytes } from '../shared/privateMedia.ts'

export interface MediaInput {
  readonly bytes: Uint8Array
  readonly mime: string
}

export interface MediaAdmission {
  readonly decodedBytes: number
  readonly parserWork?: number
  readonly width?: number
  readonly height?: number
  readonly pages?: number
}

const rasterFormats = new Set(['png', 'jpeg', 'webp', 'gif'])
const fontMimes = new Set(['font/woff2', 'font/woff', 'font/ttf', 'font/otf'])

/** SVG files are independent images. They may not hide another resource graph.
 * XML features whose parsing differs from the HTML carrier walker are rejected. */
export function assertSelfContainedSvg(bytes: Uint8Array, work?: (count: number) => void): void {
  const source = Buffer.from(bytes).toString('utf8')
  const body = source.replace(
    /^\s*<\?xml\s+version\s*=\s*["']1\.[01]["'](?:\s+encoding\s*=\s*["']utf-8["'])?\s*\?>/i,
    '',
  )
  if (/<\?|<!\s*(?:DOCTYPE|ENTITY|\[CDATA\[)/i.test(body)) throw new PrivateMaterializationError('unsupported')
  let sawSvg = false
  visitPrivateReferences(
    body,
    'https://private-media.invalid',
    () => {
      throw new PrivateMaterializationError('unsupported')
    },
    'html',
    {
      work,
      url(raw) {
        if (raw && !raw.startsWith('#')) throw new PrivateMaterializationError('unsupported')
      },
      element(tag, attributes) {
        const lower = tag.toLowerCase()
        if (lower === 'svg') sawSvg = true
        if (
          lower.includes(':') ||
          [
            'script',
            'foreignobject',
            'iframe',
            'object',
            'embed',
            'audio',
            'video',
            'set',
            'animate',
            'animatemotion',
            'animatetransform',
            'discard',
          ].includes(lower)
        )
          throw new PrivateMaterializationError('unsupported')
        for (const [name, value] of Object.entries(attributes)) {
          if (
            name.startsWith('on') ||
            name === 'xml:base' ||
            (name.includes(':') && !['xlink:href', 'xmlns:xlink', 'xml:space', 'xml:lang'].includes(name))
          )
            throw new PrivateMaterializationError('unsupported')
          if (
            (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg') ||
            (name === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink')
          )
            throw new PrivateMaterializationError('unsupported')
        }
      },
    },
  )
  if (!sawSvg) throw new PrivateMaterializationError('invalid')
}

/** Runs in the job's one decoder worker. `admit` reserves the shared cost
 * before a full raster decode and before bytes are ever handed to Chromium. */
export async function validateMedia(
  input: MediaInput,
  admit: (cost: MediaAdmission) => Promise<void>,
  work?: (count: number) => void,
): Promise<MediaAdmission> {
  try {
    const bytes = Buffer.from(input.bytes)
    if (!bytes.length || bytes.length > PRIVATE_MEDIA_LIMITS.encodedBytes)
      throw new PrivateMaterializationError('limit')
    if (fontMimes.has(input.mime)) {
      const inspection = inspectFontFile(bytes)
      if (inspection.mime !== input.mime) throw new PrivateMaterializationError('invalid')
      const cost = { decodedBytes: inspection.decodedBytes }
      await admit(cost)
      const font = inspection.read()
      if (font.decodedBytes !== cost.decodedBytes) throw new PrivateMaterializationError('invalid')
      return cost
    }
    const svg = input.mime === 'image/svg+xml'
    let parserWork = 0
    if (svg)
      assertSelfContainedSvg(bytes, (count) => {
        parserWork += count
        work?.(count)
      })
    const image = sharp(bytes, { animated: true, limitInputPixels: PRIVATE_MEDIA_LIMITS.pixels })
    const metadata = await image.metadata()
    if (svg ? metadata.format !== 'svg' : !metadata.format || !rasterFormats.has(metadata.format))
      throw new PrivateMaterializationError('unsupported')
    const mime =
      metadata.format === 'jpeg'
        ? 'image/jpeg'
        : metadata.format === 'svg'
          ? 'image/svg+xml'
          : `image/${metadata.format}`
    if (mime !== input.mime) throw new PrivateMaterializationError('invalid')
    const pages = metadata.pages ?? 1
    const width = metadata.width ?? 0
    const height = metadata.pageHeight ?? metadata.height ?? 0
    if (pages > 1 && (!metadata.pageHeight || metadata.height !== height * pages))
      throw new PrivateMaterializationError('invalid')
    const cost = {
      decodedBytes: rasterDecodedBytes(width, height, pages),
      width,
      height,
      pages,
      ...(svg ? { parserWork } : {}),
    }
    await admit(cost)
    const decoded = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    if (
      decoded.info.width !== width ||
      decoded.info.height !== height * pages ||
      decoded.info.channels !== 4 ||
      decoded.data.length !== cost.decodedBytes
    )
      throw new PrivateMaterializationError('invalid')
    return cost
  } catch (error) {
    if (error instanceof PrivateMaterializationError) throw error
    // Sharp enforces its input-pixel ceiling even for metadata inspection.
    if (error instanceof Error && error.message === 'Input image exceeds pixel limit')
      throw new PrivateMaterializationError('limit')
    throw new PrivateMaterializationError('invalid')
  }
}
