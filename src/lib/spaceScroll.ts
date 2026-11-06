/* Whether the space bar would scroll something if its keydown were let
   through. WebKit on macOS hides the pointer after every key event the page
   handles, and a cancelled keydown counts as handled, so the space-to-pan
   keydown (and every one of its auto-repeats) used to blank the pointer in
   Safari and the desktop app. The pan only cancels the key when this says a
   scroll would follow.

   It mirrors WebKit's default space handler with nothing focused: starting
   from the last element pressed, a page step goes to the first box up
   the chain that has a scrollbar and room to move that way, then to the
   document itself. Walking DOM ancestors rather than containing blocks only
   finds more candidates, which errs towards cancelling. */
export function spaceWouldScroll(start: Element | null, backward: boolean): boolean {
  for (let el = start; el; el = el.parentElement) {
    if (el === document.body || el === document.documentElement) break
    const { overflowY } = getComputedStyle(el)
    if ((overflowY === 'auto' || overflowY === 'scroll') && hasRoom(el, backward)) return true
  }
  const root = document.scrollingElement
  return !!root && viewportOverflow() !== 'hidden' && hasRoom(root, backward)
}

/* the viewport takes `<html>`'s overflow, or `<body>`'s when `<html>` leaves it visible */
function viewportOverflow(): string {
  const own = getComputedStyle(document.documentElement).overflowY
  return own === 'visible' ? getComputedStyle(document.body).overflowY : own
}

function hasRoom(el: Element, backward: boolean): boolean {
  if (el.scrollHeight <= el.clientHeight) return false
  return backward ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight
}
