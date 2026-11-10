import type { FontFormat } from './fonts.ts'

export const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
} as const

export const FONT_FILE_TYPES = {
  woff2: { mime: 'font/woff2', ext: 'woff2' },
  woff: { mime: 'font/woff', ext: 'woff' },
  truetype: { mime: 'font/ttf', ext: 'ttf' },
  opentype: { mime: 'font/otf', ext: 'otf' },
} as const satisfies Record<FontFormat, { mime: string; ext: string }>

export function sniffMime(bytes: Uint8Array): keyof typeof IMAGE_MIME_EXT | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const signature = String.fromCharCode(...bytes.subarray(0, 12))
  if (bytes.length >= 6 && signature.startsWith('GIF8')) return 'image/gif'
  if (bytes.length >= 12 && signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP') return 'image/webp'
  const head = new TextDecoder().decode(bytes.subarray(0, 1500)).trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return undefined
}

export function fontFormatOf(bytes: Uint8Array): FontFormat | 'collection' | undefined {
  if (bytes.length < 12) return undefined
  const signature = String.fromCharCode(...bytes.subarray(0, 4))
  if (signature === 'wOF2') return 'woff2'
  if (signature === 'wOFF') return 'woff'
  if (signature === 'OTTO') return 'opentype'
  if (signature === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'truetype'
  if (signature === 'ttcf') return 'collection'
  return undefined
}
