/**
 * ⌥ held on the canvas, and where the pointer is: what the distance overlay
 * (MeasureOverlay) needs before it has seen a pointer move of its own. One
 * set of window listeners, there only while something subscribes.
 */
import { useSyncExternalStore } from 'react'

export interface MeasurePointer {
  x: number
  y: number
  /** a button is down: a drag owns ⌥ (no snapping, a free handle) */
  pressed: boolean
  /** over the canvas's world: a frame, or the furniture drawn on one */
  onCanvas: boolean
}

let held = false
let pointer: MeasurePointer | null = null
let stop: (() => void) | null = null
const listeners = new Set<() => void>()

function setHeld(next: boolean) {
  if (next === held) return
  held = next
  listeners.forEach((cb) => cb())
}

/* ⌥ in a field types a character */
function typing(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
}

/* ⌥ alone: with ⌘ or Ctrl it is a chord (⌥⌘C, ⌥⌘G), not a look at distances */
function measuring(e: KeyboardEvent | PointerEvent): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey && !typing()
}

function start(): () => void {
  const onKey = (e: KeyboardEvent) => {
    /* letting ⌥ go after a look at distances must not hand the keyboard to
       the browser's menu bar, as Windows and Linux browsers do on a bare Alt */
    if (e.type === 'keyup' && e.key === 'Alt' && held && pointer?.onCanvas) e.preventDefault()
    setHeld(measuring(e))
  }
  const onBlur = () => setHeld(false)
  const onPointer = (e: PointerEvent) => {
    pointer = {
      x: e.clientX,
      y: e.clientY,
      pressed: e.buttons !== 0,
      onCanvas: e.target instanceof Element && e.target.closest('.world') !== null,
    }
    /* a key-up the window never saw (⌥ let go in another app) is caught here */
    setHeld(measuring(e))
  }
  /* the pointer left the window: it is over nothing on the canvas */
  const onLeave = () => {
    if (pointer) pointer = { ...pointer, onCanvas: false }
  }
  const pointerEvents = ['pointermove', 'pointerdown', 'pointerup'] as const
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
  window.addEventListener('blur', onBlur)
  /* in the capture phase: a frame keeps its presses from bubbling this far */
  for (const type of pointerEvents) window.addEventListener(type, onPointer, { passive: true, capture: true })
  document.documentElement.addEventListener('pointerleave', onLeave)
  return () => {
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('keyup', onKey)
    window.removeEventListener('blur', onBlur)
    for (const type of pointerEvents) window.removeEventListener(type, onPointer, { capture: true })
    document.documentElement.removeEventListener('pointerleave', onLeave)
    held = false
    pointer = null
  }
}

function subscribe(cb: () => void) {
  stop ??= start()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
    if (listeners.size > 0) return
    stop?.()
    stop = null
  }
}

/** True while ⌥ is held outside a text field. */
export function useMeasureKey(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => held,
    () => false,
  )
}

/** Where the pointer last was, or null before it has moved. */
export function measurePointer(): MeasurePointer | null {
  return pointer
}
