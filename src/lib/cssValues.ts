/**
 * Value helpers for the element properties panel: what the runtime reports
 * (computed styles) turned into what a field shows, and what a person types
 * turned into a CSS value the element can carry inline.
 */

/** `rgb(…)` / `rgba(…)` as `#rrggbb`; null for a fully transparent colour
 *  or anything that is not an rgb triplet. */
export function rgbToHex(color: string): string | null {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color.trim())
  if (!m) return /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : null
  if (m[4] !== undefined && Number(m[4]) === 0) return null
  const hex = (v: string) => Number(v).toString(16).padStart(2, '0')
  return `#${hex(m[1] ?? '0')}${hex(m[2] ?? '0')}${hex(m[3] ?? '0')}`
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

/** Which of the panel's size modes an inline length expresses. */
export type SizeMode = 'fixed' | 'fill' | 'hug'
export function sizeMode(inline: string | undefined): SizeMode {
  if (!inline || inline === 'auto') return 'hug'
  return inline.trim().endsWith('%') ? 'fill' : 'fixed'
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
