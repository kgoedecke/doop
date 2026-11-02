import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

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
  onChange,
  min = -Infinity,
  max = Infinity,
  enabled = true,
  onStart,
  onEnd,
}: {
  value: string
  onChange: (value: string) => void
  min?: number
  max?: number
  enabled?: boolean
  onStart?: () => void
  onEnd?: (cancel: boolean) => void
}) {
  const [scrubbing, setScrubbing] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])
  const canScrub = enabled && parse(value) !== null

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!canScrub || event.button !== 0 || !event.isPrimary || cleanup.current) return
    const parts = parse(value)
    if (!parts) return
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget
    const pointerId = event.pointerId
    let lastX = event.clientX
    let moved = false
    let lastValue = value
    const cursor = document.createElement('style')
    cursor.textContent = '* { cursor: ew-resize !important; user-select: none !important; }'
    document.head.append(cursor)
    target.setPointerCapture(pointerId)

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
      const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
      for (const part of parts!) {
        part.number = Math.min(max, Math.max(min, Number((part.number + dx * step).toFixed(4))))
      }
      const next = parts!.map((part) => `${part.number}${part.unit}`).join(' ')
      if (next !== lastValue) {
        lastValue = next
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
      cursor.remove()
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
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
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
    target.addEventListener('lostpointercapture', end)
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', keydown, true)
  }

  return { canScrub, scrubbing, onPointerDown }
}
