/* How ⌘G and ⇧A lay out layers placed by hand. A drawn shape sits absolute
   at its left and top, so wrapping it in a plain box changes nothing about
   how it moves or lines up. Instead the group becomes what a design tool
   makes of it: one box placed where the layers were, laying them out as a
   flex row or column when they run one after another (the space between
   them becomes the gap), and holding them at their spots only when they
   overlap and no flow could keep them. */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type FlexAlign = 'start' | 'center' | 'end'

export interface FlexPlan {
  kind: 'flex'
  direction: 'row' | 'column'
  gap: number
  align: FlexAlign
  /** the layers' indexes in the order the flow places them */
  order: number[]
  /** the group's corner, in the same space as the rects */
  x: number
  y: number
}

export interface PinnedPlan {
  kind: 'pinned'
  x: number
  y: number
  width: number
  height: number
}

export type GroupPlan = FlexPlan | PinnedPlan

/* a pixel of slack for edges that touch or nearly line up */
const SLACK = 1

const round = (n: number) => Math.round(n * 100) / 100

function bounds(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

/* the order along the axis and the spaces between neighbours, or null when
   two of them overlap along it (a flow would push one off the other) */
function run(rects: Rect[], direction: 'row' | 'column'): { order: number[]; spaces: number[] } | null {
  const start = (r: Rect) => (direction === 'row' ? r.x : r.y)
  const size = (r: Rect) => (direction === 'row' ? r.width : r.height)
  const order = rects.map((_, i) => i).sort((a, b) => start(rects[a]!) - start(rects[b]!))
  const spaces: number[] = []
  for (let i = 1; i < order.length; i++) {
    const prev = rects[order[i - 1]!]!
    const next = rects[order[i]!]!
    const space = start(next) - (start(prev) + size(prev))
    if (space < -SLACK) return null
    spaces.push(Math.max(0, space))
  }
  return { order, spaces }
}

/* layers that overlap along the axis, ordered by where they start */
function overlapping(rects: Rect[], direction: 'row' | 'column'): { order: number[]; spaces: number[] } {
  const start = (r: Rect) => (direction === 'row' ? r.x : r.y)
  return { order: rects.map((_, i) => i).sort((a, b) => start(rects[a]!) - start(rects[b]!)), spaces: [] }
}

/* the cross-axis alignment the layers already share most closely */
function alignmentOf(rects: Rect[], direction: 'row' | 'column'): FlexAlign {
  const start = (r: Rect) => (direction === 'row' ? r.y : r.x)
  const size = (r: Rect) => (direction === 'row' ? r.height : r.width)
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values)
  const candidates: [FlexAlign, number][] = [
    ['start', spread(rects.map(start))],
    ['center', spread(rects.map((r) => start(r) + size(r) / 2))],
    ['end', spread(rects.map((r) => start(r) + size(r)))],
  ]
  /* start wins ties: it is what a fresh auto layout uses */
  return candidates.reduce((best, next) => (next[1] < best[1] - 0.5 ? next : best))[0]
}

/** The layout for a group of layers at `rects` (their rendered boxes). Flex
 *  when they run as a row or a column without overlapping, the way the
 *  wider spread goes when both would; pinned in place otherwise, unless
 *  `flex` asks for auto layout whatever it moves (⇧A), which then stacks
 *  them along the wider spread with no gap. `pinned` keeps them where they
 *  are whatever their arrangement. */
export function planGroup(
  rects: Rect[],
  { flex = false, pinned = false }: { flex?: boolean; pinned?: boolean } = {},
): GroupPlan {
  const box = bounds(rects)
  if (pinned) return { kind: 'pinned', ...box }
  const rows = run(rects, 'row')
  const columns = run(rects, 'column')
  const wider = box.width >= box.height ? 'row' : 'column'
  const direction: 'row' | 'column' | null =
    rows && columns ? wider : rows ? 'row' : columns ? 'column' : flex ? wider : null
  if (!direction) return { kind: 'pinned', ...box }
  const flow = (direction === 'row' ? rows : columns) ?? overlapping(rects, direction)
  const gap = flow.spaces.length ? flow.spaces.reduce((sum, s) => sum + s, 0) / flow.spaces.length : 0
  return {
    kind: 'flex',
    direction,
    gap: Math.max(0, Math.round(gap)),
    align: alignmentOf(rects, direction),
    order: flow.order,
    x: round(box.x),
    y: round(box.y),
  }
}

/** The group box's inline styles, placed at `left`/`top` in the space its
 *  layers were positioned in. */
export function groupStyle(plan: GroupPlan, left: number, top: number): string {
  const at = `position: absolute; left: ${round(left)}px; top: ${round(top)}px`
  if (plan.kind === 'pinned') return `${at}; width: ${round(plan.width)}px; height: ${round(plan.height)}px`
  return [
    'display: flex',
    `flex-direction: ${plan.direction}`,
    `align-items: ${plan.align}`,
    `gap: ${plan.gap}px`,
    at,
    'width: max-content',
  ].join('; ')
}

/** What a layer sheds to become an item of a flex group: its placement, so
 *  the flow places it, and the room to shrink, so it keeps its size. */
export const FLEX_ITEM_STYLE: Record<string, string | null> = {
  position: null,
  left: null,
  top: null,
  right: null,
  bottom: null,
  translate: null,
  'flex-shrink': '0',
}

/** Whether the element holds layers placed absolute by their own styles,
 *  which need it to stay their containing block. */
export function holdsPlaced(el: Element): boolean {
  return [...el.querySelectorAll('[style]')].some((node) =>
    /^(absolute|fixed)$/.test((node as HTMLElement).style.position),
  )
}

/** What one absolute layer sheds to become a flex item. Placed by a
 *  stylesheet, it is overridden, since removing an inline style would leave
 *  it out of the flow; holding layers of its own placed absolute, it stays
 *  positioned, so they keep their corner. */
export function flexItemStyle(el: Element): Record<string, string | null> {
  if (!(el as HTMLElement).style?.getPropertyValue('position')) {
    return {
      ...FLEX_ITEM_STYLE,
      position: 'relative !important',
      left: 'auto !important',
      top: 'auto !important',
      right: 'auto !important',
      bottom: 'auto !important',
    }
  }
  return holdsPlaced(el) ? { ...FLEX_ITEM_STYLE, position: 'relative' } : FLEX_ITEM_STYLE
}
