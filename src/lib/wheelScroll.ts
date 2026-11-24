/** What a wheel turn over the canvas meets on its way up to the stage:
 *  - `scrolls`: a box that can still scroll that way (a long comment thread, a
 *    menu, a textarea), which the browser scrolls;
 *  - `stops`: only boxes already at their end that way, so the turn is spent
 *    there, as `overscroll-behavior: contain` would, and the canvas stays put;
 *  - `none`: nothing that scrolls on that axis, so the canvas pans. */
export type WheelScroll = 'scrolls' | 'stops' | 'none'

type WheelTurn = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'shiftKey'>

const SCROLLS = new Set(['auto', 'scroll', 'overlay'])

interface Axis {
  horizontal: boolean
  delta: number
}

/** The axes a turn scrolls along, with their signed amounts. A trackpad turn is
 *  often diagonal, so both count; Shift turns a plain wheel sideways, as the
 *  browser (and the canvas's pan) does. */
function axesOf({ deltaX, deltaY, shiftKey }: WheelTurn): Axis[] {
  if (shiftKey && deltaX === 0) return [{ horizontal: true, delta: deltaY }]
  const axes: Axis[] = [
    { horizontal: true, delta: deltaX },
    { horizontal: false, delta: deltaY },
  ]
  return axes.filter((axis) => axis.delta !== 0)
}

function overflows(el: Element, horizontal: boolean): boolean {
  const style = getComputedStyle(el)
  return horizontal
    ? el.scrollWidth > el.clientWidth && SCROLLS.has(style.overflowX)
    : el.scrollHeight > el.clientHeight && SCROLLS.has(style.overflowY)
}

/* one pixel of slack: scroll positions are fractional at some zooms */
function canMove(el: Element, horizontal: boolean, delta: number): boolean {
  const [pos, view, size] = horizontal
    ? [el.scrollLeft, el.clientWidth, el.scrollWidth]
    : [el.scrollTop, el.clientHeight, el.scrollHeight]
  return delta > 0 ? pos + view < size - 1 : pos > 1
}

/** Reads the scrolling boxes from `target` up to, not including, `stage`, on
 *  every axis the turn moves along. */
export function wheelScrollUnder(target: EventTarget | null, stage: Element, turn: WheelTurn): WheelScroll {
  const axes = axesOf(turn)
  let found: WheelScroll = 'none'
  for (let el = target instanceof Element ? target : null; el && el !== stage; el = el.parentElement) {
    for (const { horizontal, delta } of axes) {
      if (!overflows(el, horizontal)) continue
      if (canMove(el, horizontal, delta)) return 'scrolls'
      found = 'stops'
    }
  }
  return found
}
