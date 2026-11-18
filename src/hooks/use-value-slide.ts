import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/* A number field that is also a slider: the field is the track, its left edge
   `min` and its right edge `max`, and the value is drawn as a fill up to a thumb
   bar. Press anywhere and drag, and the value moves from where it was by how far
   the pointer travels (the field's width is the whole range), so a press never
   jumps it to the pointer. A press that does not travel is a click and leaves
   the field to its text input; Esc puts the value from before the press back.
   The range may be softer than the field's limits (corner radius slides 0-100
   but takes any typed value): a value past it pins the thumb to that edge and
   drags from where it is. */

const TRAVEL = 3

/** where a value sits along the track, 0-1 */
export function slidePosition(value: number, [min, max]: readonly [number, number]) {
  if (!(max > min) || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

/** where a drag of `fraction` of the track's width takes `start`, unsnapped; a value
 *  `origin` already held past the range is not pulled back into it */
export function slideRaw(start: number, fraction: number, [min, max]: readonly [number, number], origin = start) {
  const raw = start + fraction * (max - min)
  return Math.min(Math.max(max, origin), Math.max(Math.min(min, origin), raw))
}

/** `raw` on the step's grid, kept inside what `slideRaw` allows */
export function snapSlide(raw: number, step: number, [min, max]: readonly [number, number], origin: number) {
  const snapped = Math.round(raw / step) * step
  return Number(Math.min(Math.max(max, origin), Math.max(Math.min(min, origin), snapped)).toFixed(4))
}

/** the value a drag of `fraction` of the track's width lands on, from `start` */
export function slideValue(start: number, fraction: number, range: readonly [number, number], step: number) {
  return snapSlide(slideRaw(start, fraction, range), step, range, start)
}

/* Shift snaps to tens at the same speed; Alt slows the drag to a tenth and
   steps by 0.1, as the scrub handle does */
function modifier(e: PointerEvent) {
  if (e.shiftKey) return { step: 10, speed: 1 }
  if (e.altKey) return { step: 0.1, speed: 0.1 }
  return { step: 1, speed: 1 }
}

function swallowClick() {
  const stop = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  window.addEventListener('click', stop, { capture: true, once: true })
  /* no click follows a release off the field; never eat a later, real one */
  setTimeout(() => window.removeEventListener('click', stop, true), 0)
}

export function useValueSlide({
  value,
  range,
  enabled = true,
  onChange,
  onClick,
  onStart,
  onEnd,
}: {
  value: number
  range: readonly [number, number] | undefined
  enabled?: boolean
  onChange: (value: number) => void
  /** a press that never travelled: the field's text takes over */
  onClick?: () => void
  onStart?: () => void
  onEnd?: (cancel: boolean) => void
}) {
  const [sliding, setSliding] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])
  const canSlide = enabled && !!range && range[1] > range[0] && Number.isFinite(value)

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!canSlide || !range || event.button !== 0 || !event.isPrimary || cleanup.current) return
    /* fingers scroll the panel; the field's own controls keep their presses */
    if (event.pointerType === 'touch') return
    const target = event.currentTarget
    const hit = event.target as Element
    /* React bubbles presses out of portals: a popover the field opened is not the field */
    if (!target.contains(hit) || hit.closest('button, [data-scrub]')) return
    /* a field already being typed into keeps the pointer for selecting text */
    if (target.contains(document.activeElement) && document.activeElement !== document.body) return
    event.preventDefault()
    const rect = target.getBoundingClientRect()
    const pointerId = event.pointerId
    const startX = event.clientX
    const original = value
    let moved = false
    let last = value
    /* the unsnapped value, moved by each step of the pointer at the speed its
       modifier sets, so changing modifier mid-drag never jumps the value */
    let running = value
    let lastX = startX
    let cursor: HTMLStyleElement | null = null
    target.setPointerCapture(pointerId)

    function move(e: PointerEvent) {
      if (e.pointerId !== pointerId) return
      if (!moved && Math.abs(e.clientX - startX) < TRAVEL) return
      if (!moved) {
        moved = true
        cursor = document.createElement('style')
        cursor.textContent = '* { cursor: ew-resize !important; user-select: none !important; }'
        document.head.append(cursor)
        onStart?.()
        setSliding(true)
      }
      const { step, speed } = modifier(e)
      const fraction = rect.width > 0 ? ((e.clientX - lastX) / rect.width) * speed : 0
      lastX = e.clientX
      running = slideRaw(running, fraction, range!, original)
      const next = snapSlide(running, step, range!, original)
      if (next !== last) {
        last = next
        onChange(next)
      }
    }
    function dispose() {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      target.removeEventListener('lostpointercapture', end)
      window.removeEventListener('blur', blur)
      window.removeEventListener('keydown', keydown, true)
      cursor?.remove()
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      cleanup.current = null
    }
    function finish(cancel: boolean, released = false) {
      dispose()
      setSliding(false)
      if (moved) {
        onEnd?.(cancel)
        /* the release lands on the field's <label>, whose click would focus the text */
        if (released) swallowClick()
      } else if (released) onClick?.()
    }
    function end(e: PointerEvent) {
      if (e.pointerId === pointerId) finish(false, e.type === 'pointerup')
    }
    function keydown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      /* a panel with a gesture lifecycle restores its own snapshot on cancel */
      if (moved && !onEnd && last !== original) onChange(original)
      finish(true)
    }
    function blur() {
      finish(false)
    }
    cleanup.current = () => {
      dispose()
      if (moved) onEnd?.(false)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
    target.addEventListener('lostpointercapture', end)
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', keydown, true)
  }

  return { canSlide, sliding, onPointerDown }
}
