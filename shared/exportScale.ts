/** Image export density, shared by the browser's render and the server's
 *  `/i/<id>.png?scale=` so both read and limit a multiplier the same way. */

/** The picker's presets, as Figma offers them. */
export const EXPORT_SCALE_PRESETS = [0.5, 1, 2, 3, 4] as const

export const MIN_EXPORT_SCALE = 0.1
export const MAX_EXPORT_SCALE = 4
/** Every export before the picker was 2x, and it stays the default. */
export const DEFAULT_EXPORT_SCALE = 2

/* What one render may cost: a canvas side engines still draw, and a pixel
   budget (about 200 MB of RGBA) that keeps the public image route from
   rendering anything vast. The server's renderer cuts a screenshot at the
   same budget (`renderedHeight`), so an export fitted here is never cut.
   4x of a 1080 x 1350 poster is 23 MP, of a 1920 x 1080 slide 33 MP. */
export const MAX_EXPORT_SIDE = 16_384
export const MAX_EXPORT_PIXELS = 50_000_000
/* the floor a vast frame comes down to; its render is cut below that */
const MIN_FITTED_SCALE = 0.01

/** A multiplier as typed or sent: `2`, `"2"`, `"1.5x"`, `"3×"`, and a
 *  decimal comma as Portuguese writes it (`"0,5"`). Kept to two decimals
 *  (so the server's image cache sees a bounded set of keys), or null when
 *  it is not a number within the range. */
export function parseExportScale(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim().replace(',', '.') : ''
  const match = /^(\d*\.?\d+)\s*[x×]?$/i.exec(text)
  if (!match) return null
  const scale = Math.round(Number(match[1]) * 100) / 100
  if (!Number.isFinite(scale) || scale < MIN_EXPORT_SCALE || scale > MAX_EXPORT_SCALE) return null
  return scale
}

/** The scale a box of this size actually renders at: what was asked, or
 *  less until the image fits `MAX_EXPORT_SIDE` and `MAX_EXPORT_PIXELS`, so
 *  the whole frame is in it rather than a top cut off at the budget. */
export function fitExportScale(size: { width: number; height: number }, wanted: number): number {
  /* rounded as the renderers round, so a fitted scale stays within their budget */
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  const largest = Math.min(MAX_EXPORT_SIDE / Math.max(width, height), Math.sqrt(MAX_EXPORT_PIXELS / (width * height)))
  if (wanted <= largest) return wanted
  return Math.max(MIN_FITTED_SCALE, Math.floor(largest * 100) / 100)
}

/** `2x`, `1.5x`: how the picker, the toast and the hints name a scale. */
export function formatExportScale(scale: number): string {
  return `${scale}x`
}

/** The file name's density suffix, as Figma writes it: none at 1x, `@2x`. */
export function exportScaleSuffix(scale: number): string {
  return scale === 1 ? '' : `@${scale}x`
}

/** Output pixels of a box exported at `scale`, rounded as the renderers round. */
export function exportPixelSize(size: { width: number; height: number }, scale: number) {
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}
