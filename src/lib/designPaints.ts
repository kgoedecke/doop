import { splitCssList } from './designProperties'

export interface ShadowPaint {
  x: string
  y: string
  blur: string
  spread: string
  color: string
  inset: boolean
}
export function readShadow(value: string): ShadowPaint | null {
  // Functions are single tokens, even when modern color syntax contains spaces.
  const tokens: string[] = value.match(/(?:[^\s(]+\([^)]*\)|[^\s]+)/g) ?? []
  const lengths = tokens.filter((token) => /^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(token))
  const colors = tokens.filter((token) => token !== 'inset' && !lengths.includes(token))
  if (lengths.length < 2 || lengths.length > 4 || colors.length > 1) return null
  return {
    x: lengths[0],
    y: lengths[1],
    blur: lengths[2] || '0px',
    spread: lengths[3] || '0px',
    color: colors[0] || 'currentColor',
    inset: tokens.includes('inset'),
  }
}
export function writeShadow(paint: ShadowPaint): string {
  const length = (value: string) => (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()) ? `${value.trim()}px` : value)
  return `${paint.inset ? 'inset ' : ''}${[paint.x, paint.y, paint.blur, paint.spread].map(length).join(' ')} ${paint.color}`
}

export interface GradientPaint {
  type: 'linear' | 'radial' | 'conic'
  direction: string
  stops: { color: string; position: string }[]
}
export function readGradient(value: string): GradientPaint | null {
  const match = value.match(/^(linear|radial|conic)-gradient\((.*)\)$/s)
  if (!match) return null
  const type = match[1] as GradientPaint['type']
  const parts = splitCssList(match[2])
  const direction = /^(?:-?[\d.]+(?:deg|turn|rad)|to\s|circle\b|ellipse\b|at\s|from\s)/.test(parts[0])
    ? parts.shift()!
    : ''
  if (parts.length < 2) return null
  const stops = parts.map((part) => {
    const stop = part.match(/^(.*)\s+(-?(?:\d+\.?\d*|\.\d+)(?:%|deg))$/)
    return stop ? { color: stop[1], position: stop[2] } : { color: part, position: '' }
  })
  // Mixed implicit/explicit stops and interpolation hints remain editable CSS.
  if (stops.some((stop) => stop.position) && stops.some((stop) => !stop.position)) return null
  if (stops.some((stop) => /^[-\d.]/.test(stop.color))) return null
  return {
    type,
    direction: direction || (type === 'linear' ? '180deg' : type === 'radial' ? 'circle at center' : 'from 0deg'),
    stops: stops.map((stop, index) => ({
      ...stop,
      position: stop.position || `${Math.round((index * 100) / (stops.length - 1))}%`,
    })),
  }
}
export function writeGradient(paint: GradientPaint): string {
  return `${paint.type}-gradient(${paint.direction}, ${paint.stops.map((stop) => `${stop.color} ${stop.position}`).join(', ')})`
}
