import { bleed } from './bleed'
import { apply, getter, isTrusted, readNodeType, runtimePort, sendToEditor } from './channel'
import { editing } from './edit'
import { protoOn } from './proto'

/* ⌘/Ctrl+wheel (a trackpad pinch, or a held modifier and a mouse wheel)
   reaches this document only while it is being edited, when the canvas
   lifts its shield off the frame. Left alone it zooms the whole page; it
   is the canvas's zoom instead, so it travels over the port at the
   pointer's spot in design px. It is caught on the window in the capture
   phase, ahead of any design script, and only while editing: a playing
   prototype, or a runtime without the canvas's port (the prototype
   player), leaves the browser its own.
   A plain wheel pans the canvas the same way, but the design has it
   first: it is heard on the window once the event has bubbled, and left
   alone when a design script claimed it (a carousel) or a box under the
   pointer can still scroll that way. Fields are read through getters
   pinned before any design script runs (channel.ts). */

const readDeltaX = getter(WheelEvent.prototype, 'deltaX')!
const readDeltaY = getter(WheelEvent.prototype, 'deltaY')!
const readDeltaMode = getter(WheelEvent.prototype, 'deltaMode')!
const readClientX = getter(MouseEvent.prototype, 'clientX')!
const readClientY = getter(MouseEvent.prototype, 'clientY')!
const readCtrlKey = getter(MouseEvent.prototype, 'ctrlKey')!
const readMetaKey = getter(MouseEvent.prototype, 'metaKey')!
const readShiftKey = getter(MouseEvent.prototype, 'shiftKey')!
const readDefaultPrevented = getter(Event.prototype, 'defaultPrevented')!
const composedPath = Event.prototype.composedPath
const preventDefault = Event.prototype.preventDefault
const readComputedStyle = window.getComputedStyle

function wheelListening(ev: WheelEvent): boolean {
  return !!runtimePort && editing && !protoOn && isTrusted(ev)
}

/* the canvas counts in px; a line or page wheel (Firefox's mouse) does not */
function wheelPx(delta: number, mode: number, page: number): number {
  return mode === 1 ? delta * 16 : mode === 2 ? delta * page : delta
}

function sendWheel(ev: WheelEvent, ctrlKey: boolean, metaKey: boolean): void {
  apply(preventDefault, ev, [])
  const mode = apply(readDeltaMode, ev, []) as number
  sendToEditor({
    event: 'wheel',
    x: (apply(readClientX, ev, []) as number) - bleed,
    y: (apply(readClientY, ev, []) as number) - bleed,
    deltaX: wheelPx(apply(readDeltaX, ev, []) as number, mode, innerWidth),
    deltaY: wheelPx(apply(readDeltaY, ev, []) as number, mode, innerHeight),
    ctrlKey,
    metaKey,
    shiftKey: apply(readShiftKey, ev, []) as boolean,
  })
}

/* how far a box can still scroll one way, in px. A box whose content
   starts at its far end (right-to-left, or a reversed flex box such as a
   chat log) counts its scroll offset from 0 there down to minus its range */
function scrollRoom(el: Element, cs: CSSStyleDeclaration, dx: number, dy: number): number {
  const flex = cs.display === 'flex' || cs.display === 'inline-flex'
  const vertical = !!dy
  const range = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
  const reversed = vertical
    ? flex && cs.flexDirection === 'column-reverse'
    : (cs.direction === 'rtl') !== (flex && cs.flexDirection === 'row-reverse')
  const offset = vertical ? el.scrollTop : el.scrollLeft
  const before = reversed ? range + offset : offset
  return (vertical ? dy : dx) < 0 ? before : range - before
}

/* does a box on the event's path (shadow roots included) take the wheel?
   The page scrolls unless told not to; any other box only when it says so.
   An html left visible hands body's overflow to the page instead. */
function wheelScrolls(ev: WheelEvent, dx: number, dy: number): boolean {
  const root = document.scrollingElement || document.documentElement
  const body = document.body
  const rootStyle = apply(readComputedStyle, window, [document.documentElement]) as CSSStyleDeclaration
  const bodyRules = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible' && body
  const path = apply(composedPath, ev, []) as EventTarget[]
  /* indexed, not for…of: the array iterator is the design's to patch */
  for (let i = 0; i < path.length; i++) {
    const el = path[i]
    if (!el || el === window || apply(readNodeType, el, []) !== 1) continue
    if (bodyRules && el === body && el !== root) continue
    const box = el as Element
    const cs = apply(readComputedStyle, window, [box]) as CSSStyleDeclaration
    const isRoot = box === root
    const rules = isRoot && bodyRules ? (apply(readComputedStyle, window, [body]) as CSSStyleDeclaration) : cs
    const overflow = dy ? rules.overflowY : rules.overflowX
    if (isRoot ? overflow === 'hidden' || overflow === 'clip' : !/^(auto|scroll|overlay)$/.test(overflow)) continue
    if (scrollRoom(box, cs, dx, dy) >= 1) return true
  }
  return false
}

export function installWheelRelay(): void {
  window.addEventListener(
    'wheel',
    (ev) => {
      if (!wheelListening(ev)) return
      const ctrlKey = apply(readCtrlKey, ev, []) as boolean
      const metaKey = apply(readMetaKey, ev, []) as boolean
      if (ctrlKey || metaKey) sendWheel(ev, ctrlKey, metaKey)
    },
    { capture: true, passive: false },
  )
  window.addEventListener(
    'wheel',
    (ev) => {
      if (!wheelListening(ev) || apply(readDefaultPrevented, ev, [])) return
      if (apply(readCtrlKey, ev, []) || apply(readMetaKey, ev, [])) return
      let dx = apply(readDeltaX, ev, []) as number
      let dy = apply(readDeltaY, ev, []) as number
      /* Shift turns a vertical wheel sideways */
      if (apply(readShiftKey, ev, []) && !dx) {
        dx = dy
        dy = 0
      }
      if ((dy && wheelScrolls(ev, 0, dy)) || (dx && wheelScrolls(ev, dx, 0))) return
      sendWheel(ev, false, false)
    },
    { passive: false },
  )
}
