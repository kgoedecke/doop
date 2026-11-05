import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/** Only scrub numeric lengths, never keywords or expressions such as calc(). */
function parse(value: string) {
  const parts = value.trim().split(/\s+/)
  if (parts.length > 4) return null
  const lengths = parts.map((part) => /^(-?(?:\d+\.?\d*|\.\d+))(px|%|em|rem|vh|vw|vmin|vmax|ch|ex)?$/.exec(part))
  if (lengths.some((part) => !part || !Number.isFinite(Number(part[1])))) return null
  return lengths.map((part) => ({ number: Number(part![1]), unit: part![2] ?? '' }))
}

/** Capture the pointer on the unit so scrubbing continues outside the field,
 * including over the canvas iframe. A drag keeps its own values: asynchronous
 * inspection replies must not reset the starting point halfway through. */
export function useValueScrub({
  value,
  unit,
  onChange,
  min = -Infinity,
  max = Infinity,
  enabled = true,
  onStart,
  onEnd,
}: {
  value: string
  unit?: string
  onChange: (value: string) => void
  min?: number
  max?: number
  enabled?: boolean
  onStart?: () => void
  onEnd?: (cancel: boolean) => void
}) {
  const [scrubbing, setScrubbing] = useState(false)
  const [target, attachHandle] = useState<HTMLElement | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const canScrub = enabled && parse(value) !== null

  const latest = useRef({ value, unit, min, max, canScrub, onStart, onEnd, onChange })
  useEffect(() => {
    latest.current = { value, unit, min, max, canScrub, onStart, onEnd, onChange }
  })

  useEffect(() => () => cleanup.current?.(), [])

  const onWheel = useCallback((e: WheelEvent) => {
    // Ignore wheel when inactive, during an in-flight drag, or on horizontal-only scroll
    if (!latest.current.canScrub || cleanup.current || e.deltaY === 0) return
    const { value, unit, min, max, onStart, onEnd, onChange } = latest.current
    const parts = parse(value)
    if (!parts) return
    e.preventDefault()
    e.stopPropagation()
    const isPixel = unit === 'px' || parts.some((p) => p.unit === 'px')
    const rate = e.shiftKey ? 10 : e.altKey ? 0.1 : isPixel ? 2 : 1
    const grid = e.shiftKey ? 10 : e.altKey ? 0.1 : isPixel ? 2 : 1
    const dir = e.deltaY < 0 ? 1 : -1
    onStart?.()
    const next = parts
      .map((part) => {
        const targetVal = Math.min(max, Math.max(min, part.number + dir * rate))
        const snapped = Math.min(max, Math.max(min, Math.round(targetVal / grid) * grid))
        return `${Number(snapped.toFixed(4))}${part.unit}`
      })
      .join(' ')
    onChange(next)
    onEnd?.(false)
  }, [])

  useEffect(() => {
    if (!target) return
    target.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      target.removeEventListener('wheel', onWheel)
    }
  }, [target, onWheel])

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!canScrub || event.button !== 0 || !event.isPrimary || cleanup.current) return
    const parts = parse(value)
    if (!parts) return
    event.preventDefault()
    event.stopPropagation()
    const targetEl = event.currentTarget
    const pointerId = event.pointerId
    let lastX = event.clientX
    let moved = false
    let lastValue = value
    const cursor = document.createElement('style')
    cursor.textContent = '* { cursor: ew-resize !important; user-select: none !important; }'
    document.head.append(cursor)
    targetEl.setPointerCapture(pointerId)

    function move(e: PointerEvent) {
      if (e.pointerId !== pointerId) return
      const dx = e.clientX - lastX
      // Clicking the label or a tiny hand tremor must not change the value.
      if (!moved && Math.abs(dx) < 3) return
      if (!moved) {
        onStart?.()
        setScrubbing(true)
      }
      moved = true
      lastX = e.clientX
      const isPixel = unit === 'px' || parts!.some((p) => p.unit === 'px')
      const rate = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
      const grid = e.shiftKey ? 10 : e.altKey ? 0.1 : isPixel ? 2 : 1
      // Each part keeps an unsnapped running value, so fractional pointer
      // positions (a zoomed browser) add up instead of being rounded away; only
      // the emitted value lands on the step's grid, so a field that starts at a
      // measured fraction (9.94) scrubs through whole values, not 10.94, 11.94.
      // Pixel slider scroll values land on even pixel values (2px).
      const next = parts!
        .map((part) => {
          part.number = Math.min(max, Math.max(min, part.number + dx * rate))
          const snapped = Math.min(max, Math.max(min, Math.round(part.number / grid) * grid))
          return `${Number(snapped.toFixed(4))}${part.unit}`
        })
        .join(' ')
      if (next !== lastValue) {
        lastValue = next
        onChange(next)
      }
    }

    function dispose() {
      targetEl.removeEventListener('pointermove', move)
      targetEl.removeEventListener('pointerup', end)
      targetEl.removeEventListener('pointercancel', end)
      targetEl.removeEventListener('lostpointercapture', end)
      window.removeEventListener('blur', blur)
      window.removeEventListener('keydown', keydown, true)
      cursor.remove()
      if (targetEl.hasPointerCapture(pointerId)) targetEl.releasePointerCapture(pointerId)
      cleanup.current = null
    }
    function finish(cancel = false) {
      dispose()
      if (moved) onEnd?.(cancel)
      setScrubbing(false)
    }
    function end(e: PointerEvent) {
      if (e.pointerId === pointerId) finish()
    }
    function keydown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (!onEnd && lastValue !== value) onChange(value)
      finish(true)
    }
    function blur() {
      finish()
    }
    cleanup.current = () => {
      dispose()
      if (moved) onEnd?.(false)
    }
    targetEl.addEventListener('pointermove', move)
    targetEl.addEventListener('pointerup', end)
    targetEl.addEventListener('pointercancel', end)
    targetEl.addEventListener('lostpointercapture', end)
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', keydown, true)
  }

  return { attachHandle, canScrub, scrubbing, onPointerDown }
}
