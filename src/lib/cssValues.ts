/**
 * Value helpers for the element properties panel: what the runtime reports
 * (computed styles) turned into what a field shows, and what a person types
 * turned into a CSS value the element can carry inline.
 */

/** `rgb(…)` / `rgba(…)` as `#rrggbb`; null for a fully transparent colour
 *  or anything that is not an rgb triplet. */
export function rgbToHex(color: string, includeTransparent = false): string | null {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color.trim())
  if (!m) return /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : null
  if (!includeTransparent && m[4] !== undefined && Number(m[4]) === 0) return null
  const hex = (v: string) => Number(v).toString(16).padStart(2, '0')
  return `#${hex(m[1] ?? '0')}${hex(m[2] ?? '0')}${hex(m[3] ?? '0')}`
}

/** Alpha is independent of element opacity; keep the RGB channels at zero alpha. */
export function colorAlpha(color: string): number {
  if (color === 'transparent') return 0
  const alpha =
    /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(color)?.[1] ?? /\/\s*([\d.]+%?)\s*\)$/.exec(color)?.[1]
  return alpha === undefined ? 1 : parseFloat(alpha) / (alpha.endsWith('%') ? 100 : 1)
}

export function colorWithAlpha(color: string, alpha: number): string {
  const clamped = Math.min(1, Math.max(0, alpha))
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const channels = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16))
    return `rgba(${channels.join(', ')}, ${clamped})`
  }
  // Keep modern CSS colors (e.g. Tailwind's oklch palette) when only alpha changes.
  return `rgb(from ${color} r g b / ${clamped})`
}

/** Bare numbers get `px`; anything else (auto, 100%, 1.5rem) passes through.
 *  Empty input means "no value" so the property is removed. */
export function lengthValue(input: string): string | null {
  const v = input.trim()
  if (!v) return null
  return /^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v
}

/** A shorthand of one to four lengths ("20 14", "0 auto"), each bare
 *  number in px. Null when empty or when any part is not a length. */
export function shorthandValue(input: string): string | null {
  const parts = input.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts.length > 4) return null
  const out = parts.map(lengthValue)
  return out.every((p): p is string => p !== null && /^(-?\d+(\.\d+)?(px|%|em|rem|vh|vw)|auto|0)$/.test(p))
    ? out.join(' ')
    : null
}

/** Round-trip a computed length list ("20px 14px 20px 14px") to its shortest
 *  shorthand, in bare px, the way the panel shows padding. */
export function compactBox(values: [number | null, number | null, number | null, number | null]): string {
  const [t, r, b, l] = values.map((v) => v ?? 0) as [number, number, number, number]
  if (t === r && r === b && b === l) return String(t)
  if (t === b && r === l) return `${t} ${r}`
  if (r === l) return `${t} ${r} ${b}`
  return `${t} ${r} ${b} ${l}`
}

/** Preserve auto as distinct from explicitly hugging the content. */
export type SizeMode = 'fixed' | 'fill' | 'hug' | 'auto'
export function sizeMode(value: string | undefined): SizeMode {
  if (!value || value === 'auto') return 'auto'
  if (value === 'fit-content' || value === 'max-content' || value === 'min-content') return 'hug'
  return value.trim() === '100%' || /^calc\(100% - [\d.]+px\)$/.test(value.trim()) ? 'fill' : 'fixed'
}

/** With `auto`, a loaded image/video's natural ratio takes precedence over
 *  the explicit fallback. Plain `auto` does not represent an explicit link. */
export function aspectRatio(value: string, naturalRatio: number | null = null): number | null {
  const parts = value
    .replace(/\bauto\b/g, '')
    .trim()
    .split('/')
    .map(Number)
  const [width, height = 1] = parts
  if (parts.length > 2 || !width || width <= 0 || height <= 0) return null
  const ratio = width / height
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  return /\bauto\b/.test(value) && naturalRatio !== null && Number.isFinite(naturalRatio) && naturalRatio > 0
    ? naturalRatio
    : ratio
}

/** How a border reads in one field: its width and, when it is not on every
 *  side, which sides carry it ("1px" / "1px right" / "2px top bottom"). */
export function borderSummary(widths: [number | null, number | null, number | null, number | null]): {
  width: number
  sides: string
} {
  const names = ['top', 'right', 'bottom', 'left']
  const on = names.filter((_, i) => (widths[i] ?? 0) > 0)
  const width = Math.max(...widths.map((w) => w ?? 0))
  return { width, sides: on.length === 0 || on.length === 4 ? '' : on.join(' ') }
}
