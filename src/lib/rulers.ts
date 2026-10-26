/**
 * Ruler math: which world positions get a labelled tick and which a minor
 * one at a given zoom. Steps are the "nice" numbers 1, 2 and 5 times a power
 * of ten, the smallest whose labels still sit `minPx` screen px apart. Pure,
 * so the canvas drawing in Rulers.tsx and the tests share it.
 */

/** Labelled ticks are at least this many screen px apart. */
export const RULER_LABEL_PX = 56
/** Minor ticks closer than this on screen are not drawn. */
const MINOR_MIN_PX = 5
const NICE = [1, 2, 5] as const

/** The world-px distance between labelled ticks at `zoom`. Never below 1:
 *  past the point where one world px is wider than `minPx`, every px is labelled. */
export function rulerStep(zoom: number, minPx = RULER_LABEL_PX): number {
  const raw = minPx / zoom
  if (!Number.isFinite(raw) || raw <= 1) return 1
  let power = 10 ** Math.floor(Math.log10(raw))
  for (;;) {
    for (const m of NICE) {
      const step = m * power
      if (step >= raw) return step
    }
    power *= 10
  }
}

/** The distance between minor ticks: tenths of a 1-step, quarters of a
 *  2-step, fifths of a 5-step; halves when those would crowd together, and
 *  undefined when even halves would (or would fall between whole px). */
export function minorStep(step: number, zoom: number): number | undefined {
  const mantissa = Math.round(step / 10 ** Math.floor(Math.log10(step)))
  const parts = mantissa === 1 ? 10 : mantissa === 2 ? 4 : 5
  for (const split of [parts, 2]) {
    const minor = step / split
    if (minor >= 1 && minor * zoom >= MINOR_MIN_PX) return minor
  }
  return undefined
}

export interface RulerTicks {
  step: number
  /** labelled positions, in ruler units (world px from the ruler's origin) */
  major: number[]
  /** the unlabelled positions between them */
  minor: number[]
}

/** Every tick between `start` and `end` (ruler units, start < end). */
export function rulerTicks(start: number, end: number, zoom: number, minPx = RULER_LABEL_PX): RulerTicks {
  const step = rulerStep(zoom, minPx)
  const major: number[] = []
  for (let k = Math.ceil(start / step); k * step <= end; k++) major.push(k * step)
  const minor: number[] = []
  const sub = minorStep(step, zoom)
  if (sub) {
    for (let k = Math.ceil(start / sub); k * sub <= end; k++) {
      const at = k * sub
      /* a multiple of the step is a major tick already */
      if (Math.abs(at / step - Math.round(at / step)) > 1e-9) minor.push(at)
    }
  }
  return { step, major, minor }
}

/** A ruler or guide position as the rulers print it: whole px, no "-0". */
export function formatRulerValue(value: number): string {
  const rounded = Math.round(value)
  return String(rounded === 0 ? 0 : rounded)
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The box every given frame fits in, or null for none. */
export function boundsOf(boxes: readonly Box[]): Box | null {
  const [first, ...rest] = boxes
  if (!first) return null
  let minX = first.x
  let minY = first.y
  let maxX = first.x + first.width
  let maxY = first.y + first.height
  for (const b of rest) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
