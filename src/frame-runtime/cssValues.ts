/* Reading computed CSS values: pure string work, kept apart from the DOM so
   it can be tested on its own (tests/frameRuntimeCss.test.ts). */

/** a computed length or number to two decimals; null when it is none */
export function px(v: string): number | null {
  const n = parseFloat(v)
  return isNaN(n) ? null : Math.round(n * 100) / 100
}

/** the six numbers of a computed `matrix(…)` transform, or null for any other */
export function matrixOf(transform: string): number[] | null {
  const m = /^matrix\(([^)]+)\)$/.exec(transform)
  return m ? m[1]!.split(',').map(parseFloat) : null
}

/* the alpha of a computed colour: rgb()/rgba(), and the slash form of
   every other colour function (oklch(… / 0), color(srgb … / 0.5)) */
export function colorAlphaOf(color: string): number {
  if (!color || color === 'transparent') return 0
  const slash = /\/\s*([\d.]+)(%?)\s*\)\s*$/.exec(color)
  if (slash) return parseFloat(slash[1]!) / (slash[2] ? 100 : 1)
  const legacy = /^rgba\(([^)]*)\)$/.exec(color)
  if (legacy) {
    const parts = legacy[1]!.split(',')
    if (parts.length > 3) return parseFloat(parts[3]!)
  }
  return 1
}

/** the logical properties that can name the same box side as a physical one:
 *  which one does depends on the writing mode, so every candidate counts */
export function logicalNames(name: string): string[] {
  let m: RegExpExecArray | null
  if ((m = /^(min-|max-)?(width|height)$/.exec(name)))
    return [(m[1] || '') + 'inline-size', (m[1] || '') + 'block-size']
  if ((m = /^(margin|padding)-(top|right|bottom|left)$/.exec(name))) {
    return [m[1] + '-block-start', m[1] + '-block-end', m[1] + '-inline-start', m[1] + '-inline-end']
  }
  if ((m = /^border-(top|right|bottom|left)-(width|style|color)$/.exec(name))) {
    return [
      'border-block-start-' + m[2],
      'border-block-end-' + m[2],
      'border-inline-start-' + m[2],
      'border-inline-end-' + m[2],
    ]
  }
  if (/^(top|right|bottom|left)$/.test(name))
    return ['inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end']
  if (/^border-(top|bottom)-(left|right)-radius$/.test(name)) {
    return ['border-start-start-radius', 'border-start-end-radius', 'border-end-start-radius', 'border-end-end-radius']
  }
  return []
}
