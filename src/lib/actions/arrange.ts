/* The Arrange menu as geometry: align, distribute, tidy up and pack a set
   of boxes. Pure — every function takes the boxes in their current order and
   returns where each one's top-left goes, in the same order, so the caller
   decides whether they are frames on the canvas or layers in a frame. */

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Spot {
  x: number
  y: number
}

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
export type Axis = 'x' | 'y'
export type DistributeEdge = 'start' | 'center' | 'end'

/** The box around every box. */
export function boundsOf(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Each box lined up on one edge (or centre line) of the boxes' bounds. */
export function alignBoxes(boxes: readonly Box[], edge: AlignEdge, within: Box = boundsOf(boxes)): Spot[] {
  return boxes.map((b) => {
    switch (edge) {
      case 'left':
        return { x: within.x, y: b.y }
      case 'hcenter':
        return { x: within.x + (within.width - b.width) / 2, y: b.y }
      case 'right':
        return { x: within.x + within.width - b.width, y: b.y }
      case 'top':
        return { x: b.x, y: within.y }
      case 'vcenter':
        return { x: b.x, y: within.y + (within.height - b.height) / 2 }
      case 'bottom':
        return { x: b.x, y: within.y + within.height - b.height }
    }
  })
}

const start = (b: Box, axis: Axis) => (axis === 'x' ? b.x : b.y)
const size = (b: Box, axis: Axis) => (axis === 'x' ? b.width : b.height)
const moved = (b: Box, axis: Axis, at: number): Spot => (axis === 'x' ? { x: at, y: b.y } : { x: b.x, y: at })

/** The indexes of the boxes from first to last along the axis. */
function orderAlong(boxes: readonly Box[], axis: Axis): number[] {
  return boxes.map((_, i) => i).sort((a, b) => start(boxes[a]!, axis) - start(boxes[b]!, axis) || a - b)
}

/** Equal gaps between neighbours along the axis; the first and last stay put. */
export function distributeSpacing(boxes: readonly Box[], axis: Axis): Spot[] {
  const out: Spot[] = boxes.map((b) => ({ x: b.x, y: b.y }))
  if (boxes.length < 3) return out
  const order = orderAlong(boxes, axis)
  const bounds = boundsOf(boxes)
  const used = boxes.reduce((sum, b) => sum + size(b, axis), 0)
  const gap = (size(bounds, axis) - used) / (boxes.length - 1)
  let at = start(bounds, axis)
  for (const i of order) {
    const b = boxes[i]!
    out[i] = moved(b, axis, at)
    at += size(b, axis) + gap
  }
  return out
}

/** The boxes' left edges (or centres, or right edges) evenly spaced along
 *  the axis; the first and last stay put. */
export function distributeEdges(boxes: readonly Box[], axis: Axis, edge: DistributeEdge): Spot[] {
  const out: Spot[] = boxes.map((b) => ({ x: b.x, y: b.y }))
  if (boxes.length < 3) return out
  const order = orderAlong(boxes, axis)
  const anchor = (b: Box) =>
    start(b, axis) + (edge === 'start' ? 0 : edge === 'center' ? size(b, axis) / 2 : size(b, axis))
  const first = anchor(boxes[order[0]!]!)
  const last = anchor(boxes[order[order.length - 1]!]!)
  const step = (last - first) / (boxes.length - 1)
  order.forEach((i, n) => {
    const b = boxes[i]!
    out[i] = moved(b, axis, start(b, axis) + first + step * n - anchor(b))
  })
  return out
}

/** The boxes side by side with no gap, in their order along the axis,
 *  starting where the first one is. */
export function packBoxes(boxes: readonly Box[], axis: Axis): Spot[] {
  const out: Spot[] = boxes.map((b) => ({ x: b.x, y: b.y }))
  const order = orderAlong(boxes, axis)
  if (!order.length) return out
  let at = start(boxes[order[0]!]!, axis)
  for (const i of order) {
    const b = boxes[i]!
    out[i] = moved(b, axis, at)
    at += size(b, axis)
  }
  return out
}

/** Rows as a person reads them: boxes whose vertical middles fall inside a
 *  row's band join it, rows top to bottom, each row left to right. */
function rowsOf(boxes: readonly Box[]): number[][] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.y - boxes[b]!.y || boxes[a]!.x - boxes[b]!.x)
  const rows: { top: number; bottom: number; items: number[] }[] = []
  for (const i of order) {
    const b = boxes[i]!
    const middle = b.y + b.height / 2
    const row = rows.find((r) => middle >= r.top && middle <= r.bottom)
    if (row) {
      row.items.push(i)
      row.bottom = Math.max(row.bottom, b.y + b.height)
    } else rows.push({ top: b.y, bottom: b.y + b.height, items: [i] })
  }
  return rows.map((r) => r.items.sort((a, b) => boxes[a]!.x - boxes[b]!.x))
}

/** The gap a tidy-up keeps: the average space between neighbours as they
 *  are (rounded), or `fallback` when they overlap. */
function averageGap(boxes: readonly Box[], rows: number[][], fallback: number): number {
  const gaps: number[] = []
  for (const row of rows) {
    for (let n = 1; n < row.length; n++) {
      const a = boxes[row[n - 1]!]!
      const b = boxes[row[n]!]!
      gaps.push(b.x - (a.x + a.width))
    }
  }
  for (let n = 1; n < rows.length; n++) {
    const above = Math.max(...rows[n - 1]!.map((i) => boxes[i]!.y + boxes[i]!.height))
    const below = Math.min(...rows[n]!.map((i) => boxes[i]!.y))
    gaps.push(below - above)
  }
  const mean = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : fallback
  return mean > 0 ? Math.round(mean) : fallback
}

/** Tidy up: the boxes on a grid of as many columns as their widest
 *  row has, every column as wide as its widest box and every row as tall as
 *  its tallest, an even gap between, from the boxes' top-left corner. */
export function tidyUp(boxes: readonly Box[], fallbackGap = 40): Spot[] {
  const out: Spot[] = boxes.map((b) => ({ x: b.x, y: b.y }))
  if (boxes.length < 2) return out
  const rows = rowsOf(boxes)
  const gap = averageGap(boxes, rows, fallbackGap)
  const columns = Math.max(...rows.map((r) => r.length))
  const order = rows.flat()
  const cell = (n: number) => boxes[order[n]!]!
  const colWidth = Array.from({ length: columns }, (_, c) =>
    Math.max(0, ...order.map((_, n) => (n % columns === c ? cell(n).width : 0))),
  )
  const rowCount = Math.ceil(order.length / columns)
  const rowHeight = Array.from({ length: rowCount }, (_, r) =>
    Math.max(0, ...order.map((_, n) => (Math.floor(n / columns) === r ? cell(n).height : 0))),
  )
  const origin = boundsOf(boxes)
  order.forEach((i, n) => {
    const c = n % columns
    const r = Math.floor(n / columns)
    out[i] = {
      x: origin.x + colWidth.slice(0, c).reduce((s, w) => s + w + gap, 0),
      y: origin.y + rowHeight.slice(0, r).reduce((s, h) => s + h + gap, 0),
    }
  })
  return out
}
