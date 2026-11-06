import type { CanvasPageInfo } from './types.ts'

/** A page's own canvas colour: a lowercase `#rrggbb`. Unset, the page shows
 *  the viewer's theme paper. */
export const PAGE_BACKGROUND_RE = /^#[0-9a-f]{6}$/

/** The stored form of a typed colour (`#FFF`, `fff`, `#ffffff` all become
 *  `#ffffff`), or null for anything that is not a hex colour. */
export function normalizePageBackground(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  if (PAGE_BACKGROUND_RE.test(hex)) return hex
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex)
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null
}

export function pageBackground(page: Pick<CanvasPageInfo, 'background'> | undefined): string | null {
  return page?.background ?? null
}

/** WCAG relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const channel = (at: number) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** Whether light or dark ink reads on the colour: the luminance at which
 *  black and white text contrast equally. */
export function backgroundTone(hex: string): 'light' | 'dark' {
  return relativeLuminance(hex) > 0.179 ? 'light' : 'dark'
}
