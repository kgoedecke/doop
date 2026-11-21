/**
 * Distances between the selection and what the pointer is over, the way
 * Figma shows them while ⌥ is held. Pure geometry: both boxes are in the
 * same px (a frame's design px, or the world's).
 */
export interface MeasureRect {
  x: number
  y: number
  width: number
  height: number
}

/** A straight run along one axis: `x` runs from x=`from` to x=`to` at y=`at`,
 *  `y` runs from y=`from` to y=`to` at x=`at`. `from` is never past `to`. */
export interface MeasureLine {
  axis: 'x' | 'y'
  from: number
  to: number
  at: number
}

export interface Measurement {
  /** the measured distances, each labelled with its length */
  lines: MeasureLine[]
  /** dashed extensions of the target's edge, where a distance is measured
   *  to an edge that does not reach the line */
  guides: MeasureLine[]
}

/* shorter than this is no distance: the edges meet */
const EPSILON = 0.005

interface Span {
  start: number
  end: number
}

function spanOf(rect: MeasureRect, axis: 'x' | 'y'): Span {
  return axis === 'x' ? { start: rect.x, end: rect.x + rect.width } : { start: rect.y, end: rect.y + rect.height }
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

function overlapCentre(a: Span, b: Span): number {
  return (Math.max(a.start, b.start) + Math.min(a.end, b.end)) / 2
}

function line(axis: 'x' | 'y', one: number, other: number, at: number): MeasureLine {
  return { axis, from: Math.min(one, other), to: Math.max(one, other), at }
}

export function lineLength(l: MeasureLine): number {
  return l.to - l.from
}

/** The distances from `selection` to `target`. Boxes that overlap (one
 *  inside the other included) are measured edge to matching edge, left to
 *  left and so on; boxes apart are measured across the gap between them, on
 *  each axis that has one. */
export function measureBetween(selection: MeasureRect, target: MeasureRect): Measurement {
  const lines: MeasureLine[] = []
  const guides: MeasureLine[] = []
  const axes = ['x', 'y'] as const
  const apart = axes.filter((axis) => !overlaps(spanOf(selection, axis), spanOf(target, axis)))

  for (const axis of axes) {
    const cross = axis === 'x' ? 'y' : 'x'
    const a = spanOf(selection, axis)
    const b = spanOf(target, axis)
    const aCross = spanOf(selection, cross)
    const bCross = spanOf(target, cross)

    if (apart.length === 0) {
      /* through the middle of what the two share, which for a box inside
         another is the inner box's own middle */
      const at = overlapCentre(aCross, bCross)
      lines.push(line(axis, a.start, b.start, at), line(axis, a.end, b.end, at))
      continue
    }
    if (!apart.includes(axis)) continue

    const before = a.end <= b.start
    const near = before ? b.start : b.end
    const crossApart = apart.includes(cross)
    const at = crossApart ? (aCross.start + aCross.end) / 2 : overlapCentre(aCross, bCross)
    lines.push(line(axis, before ? a.end : a.start, near, at))
    /* the target is off to one side: its edge is carried out to the line */
    if (crossApart) guides.push(line(cross, at, at < bCross.start ? bCross.start : bCross.end, near))
  }
  return { lines: lines.filter((l) => lineLength(l) > EPSILON), guides }
}

/** A distance as the label shows it: at most two decimals, none it does not need. */
export function formatDistance(px: number): string {
  return String(Math.round(px * 100) / 100)
}
