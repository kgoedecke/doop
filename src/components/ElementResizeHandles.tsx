import { useEffect, useRef } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import { gesture } from '../lib/gesture'
import { visibleGuides } from '../lib/guides'
import { guideDelta } from '../lib/snap'
import { flexSizeAxis } from '../lib/flexLayout'
import { styleElement, styleGesture, type ElementInfo, type StylePatch } from '../lib/frameBridge'
import {
  RESIZE_CORNERS,
  RESIZE_EDGES,
  handleAnchor,
  handleCursor,
  handleLabel,
  movesHeight,
  movesWidth,
  resizePatch,
  resizedSize,
  sizeLabel,
  type ResizeHandle,
  type Size,
} from '../lib/elementResize'

export interface ElementRect {
  x: number
  y: number
  width: number
  height: number
}

/* on-screen pixels, divided by the Stage's `--zoom` so a grip stays the
   same size at every zoom, like the outline's hairline */
const GRIP_PX = 6
const EDGE_PX = 6
const GRIP_SIZE = `calc(${GRIP_PX}px / var(--zoom, 1))`
const EDGE_SIZE = `calc(${EDGE_PX}px / var(--zoom, 1))`
/* a corner grip: a white square on a one-pixel ring of the selection blue,
   the outline's own rgb(60,130,246) (FrameView). Tailwind only emits classes
   it finds spelled out, so these stay literal strings. */
const CORNER_CLASS =
  'pointer-events-auto absolute touch-none bg-white shadow-[0_0_0_calc(1px/var(--zoom,1))_rgb(60,130,246)]'
/* the size badge under the element: centred, counter-scaled, never in the way */
const BADGE_CLASS =
  'pointer-events-none absolute top-full left-1/2 origin-top whitespace-nowrap rounded-tag bg-[rgb(60,130,246)] px-2 py-1 text-label font-medium text-white tabular-nums'
const BADGE_TRANSFORM = 'translate(-50%, calc(10px / var(--zoom, 1))) scale(calc(1 / var(--zoom, 1)))'
/* a press that travels less than this is a click, not a resize */
const MOVE_THRESHOLD_PX = 2

/** The selection furniture of an element inside a frame, the way Paper draws
 *  it: a square grip in each corner, grabbable (unmarked) edges, and the box's
 *  size on a badge underneath. A drag previews inline `width` / `height` in
 *  the live frame on every move and commits once on release, so a gesture is
 *  one discrete undo step. Shift keeps the aspect ratio; Esc puts the
 *  element back. */
export function ElementResizeHandles({
  frame,
  selector,
  rect,
  onRect,
  onResizing,
}: {
  frame: Frame
  selector: string
  /** the element's box in frame px, where the grips are drawn */
  rect: ElementRect
  /** the box after each applied move, so the outline follows the element */
  onRect: (rect: ElementRect) => void
  onResizing: (resizing: boolean) => void
}) {
  /* an unmount mid-drag (the frame deselected, the tool switched, the
     element gone) must not leave window listeners behind, nor an unsaved
     size in the live document */
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  function start(e: React.PointerEvent, handle: ResizeHandle) {
    if (e.button !== 0) return
    /* the frame under the grip would otherwise start moving */
    e.stopPropagation()
    e.preventDefault()
    onResizing(true)
    /* the drag's baseline: finger position and element size the deltas are
       measured from. Re-anchored while a pinch owns the finger, so the drag
       resumes from where the finger is (at the zoom it is now) rather than
       jumping by the pinch's displacement, the way a frame drag does */
    let origin = { x: e.clientX, y: e.clientY }
    /* the rendered box's far edges in world px, where a drag starts: flow
       layout grows the box right and down whichever side is pulled */
    let edges = { right: frame.x + rect.x + rect.width, bottom: frame.y + rect.y + rect.height }
    const pointerId = e.pointerId
    /* the computed size is what the inline value has to express: a
       content-box element's width excludes its padding, its rect does not */
    let base: Size | null = null
    /* the size the live document shows after the last applied move */
    let current: Size | null = null
    let original: StylePatch | null = null
    let flexAxis: 'width' | 'height' | null = null
    /* a scaled element renders larger than its layout box: the pointer's
       travel is divided by that scale so the box follows the pointer */
    let scale = { x: 1, y: 1 }
    /* the runtime opens a style gesture: every style it gets until the
       gesture ends is a preview, committed as one discrete save on release
       or cancelled back to the element's own CSS */
    const ready = styleGesture(frame.id, selector, 'begin').then((info) => {
      if (!info) return false
      base = { width: info.width ?? info.rect.width, height: info.height ?? info.rect.height }
      original = Object.fromEntries(
        ['width', 'height', 'flex-grow', 'flex-shrink', 'flex-basis'].map((key) => [key, info.inline[key] ?? null]),
      )
      flexAxis = flexSizeAxis(info)
      scale = info.scale
      return true
    })
    /* where the pointer is now: a flick that outruns the gesture's opening
       is applied the moment the base size lands */
    let last: { x: number; y: number; shift: boolean; alt: boolean } | null = null
    let latest: StylePatch | null = null
    let inFlight = false
    let moved = false
    let done = false
    /* Shift was held at some point: letting go must also put the axis the
       ratio moved back where it was */
    let ratioUsed = false

    function send(patch: StylePatch) {
      inFlight = true
      styleElement(frame.id, selector, patch)
        .then((info: ElementInfo | null) => {
          inFlight = false
          if (info) {
            current = { width: info.width ?? info.rect.width, height: info.height ?? info.rect.height }
            onRect(info.rect)
          }
          /* the move that arrived while this one was out */
          if (!done) flush()
        })
        .catch(console.error)
    }
    function flush() {
      if (!latest || inFlight) return
      const patch = latest
      latest = null
      send(patch)
    }
    /** the styles the pointer's current place asks for; null before the
     *  gesture has travelled far enough to count as a drag */
    function patchFor(pos: { x: number; y: number; shift: boolean; alt: boolean }): StylePatch | null {
      if (!base || !moved) return null
      const zoom = useStore.getState().viewport.zoom
      const world = snapToGuides({ dx: (pos.x - origin.x) / zoom, dy: (pos.y - origin.y) / zoom }, zoom, pos.alt)
      const delta = { dx: world.dx / scale.x, dy: world.dy / scale.y }
      const keepRatio = pos.shift
      if (keepRatio) ratioUsed = true
      const patch = resizePatch(handle, resizedSize(handle, base, delta, { keepRatio }), { keepRatio, flexAxis })
      if (ratioUsed && !keepRatio && original) {
        if (!movesWidth(handle)) patch.width = original.width ?? null
        if (!movesHeight(handle)) patch.height = original.height ?? null
        if ((flexAxis === 'width' && !movesWidth(handle)) || (flexAxis === 'height' && !movesHeight(handle))) {
          for (const key of ['flex-grow', 'flex-shrink', 'flex-basis']) patch[key] = original[key] ?? null
        }
      }
      return patch
    }
    /** The pointer's travel (world px) adjusted so a growing edge lands on
     *  a ruler guide it comes close to; ⌥ resizes freely. A pull on a west
     *  or north side grows the box the other way, so its sign flips. */
    function snapToGuides(world: { dx: number; dy: number }, zoom: number, free: boolean) {
      if (free) return world
      const guides = visibleGuides()
      const sx = handle.includes('w') ? -1 : 1
      const sy = handle.includes('n') ? -1 : 1
      return {
        dx: movesWidth(handle) ? world.dx + sx * guideDelta(edges.right + sx * world.dx, guides, 'v', zoom) : world.dx,
        dy: movesHeight(handle)
          ? world.dy + sy * guideDelta(edges.bottom + sy * world.dy, guides, 'h', zoom)
          : world.dy,
      }
    }
    function preview() {
      if (done || !last) return
      const patch = patchFor(last)
      if (!patch) return
      latest = patch
      flush()
    }
    void ready.then(preview)

    /* Pointer travel counts even while the runtime is still opening the gesture. */
    function trackPointer(ev: PointerEvent) {
      last = { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey, alt: ev.altKey }
      if (Math.abs(ev.clientX - origin.x) + Math.abs(ev.clientY - origin.y) >= MOVE_THRESHOLD_PX) moved = true
    }
    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      if (gesture.pinching) {
        origin = { x: ev.clientX, y: ev.clientY }
        if (current && base) {
          edges = {
            right: edges.right + (current.width - base.width) * scale.x,
            bottom: edges.bottom + (current.height - base.height) * scale.y,
          }
          base = current
        }
        last = null
        return
      }
      trackPointer(ev)
      preview()
    }
    function finish() {
      done = true
      stop.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey)
      onResizing(false)
    }
    /* messages reach the runtime in order, so the final size sent just
       before the commit is part of what it files */
    function end(phase: 'commit' | 'cancel') {
      void ready.then((open) => {
        if (!open) return
        if (phase === 'commit') {
          const final = last ? patchFor(last) : null
          if (final) send(final)
        }
        styleGesture(frame.id, selector, phase)
          .then((info) => {
            if (info) onRect(info.rect)
          })
          .catch(console.error)
      })
    }
    function onUp(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      if (ev.type === 'pointercancel') {
        cancel()
        return
      }
      // Release can carry a position/modifier change newer than the last move.
      if (!gesture.pinching) trackPointer(ev)
      finish()
      end(moved ? 'commit' : 'cancel')
    }
    /* Esc, or the grips leaving mid-drag: the element goes back to the size
       it had, nothing is saved */
    function cancel() {
      finish()
      end('cancel')
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      cancel()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey)
    stop.current = cancel
  }

  return (
    <div
      data-resize-handles=""
      className="pointer-events-none absolute z-[4]"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      {RESIZE_EDGES.map((handle) => {
        const anchor = handleAnchor(handle)
        const horizontal = !movesWidth(handle)
        return (
          <div
            key={handle}
            data-resize-handle={handle}
            aria-label={handleLabel(handle)}
            className="pointer-events-auto absolute touch-none"
            style={{
              left: `${anchor.x * 100}%`,
              top: `${anchor.y * 100}%`,
              /* an edge zone spans its whole side, a few screen px thick */
              width: horizontal ? '100%' : EDGE_SIZE,
              height: horizontal ? EDGE_SIZE : '100%',
              transform: 'translate(-50%, -50%)',
              cursor: handleCursor(handle),
            }}
            onPointerDown={(e) => start(e, handle)}
          />
        )
      })}
      {RESIZE_CORNERS.map((handle) => {
        const anchor = handleAnchor(handle)
        return (
          <div
            key={handle}
            data-resize-handle={handle}
            aria-label={handleLabel(handle)}
            className={CORNER_CLASS}
            style={{
              left: `${anchor.x * 100}%`,
              top: `${anchor.y * 100}%`,
              width: GRIP_SIZE,
              height: GRIP_SIZE,
              transform: 'translate(-50%, -50%)',
              cursor: handleCursor(handle),
            }}
            onPointerDown={(e) => start(e, handle)}
          />
        )
      })}
      <div data-element-size="" className={BADGE_CLASS} style={{ transform: BADGE_TRANSFORM }}>
        {sizeLabel(rect)}
      </div>
    </div>
  )
}
