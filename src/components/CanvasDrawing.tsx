import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { useStore } from '../lib/store'
import { isDrawingTool, resolvePointerAction, type DrawingTool } from '../lib/tools'
import { gesture } from '../lib/gesture'
import { visibleGuides } from '../lib/guides'
import { snapPointToGuides } from '../lib/snap'
import { isTypingTarget } from '../lib/keys'
import {
  defaultDrawing,
  drawingBounds,
  drawingTarget,
  nearestPathAnchor,
  pathData,
  pathDrawing,
  saveDrawing,
  DRAWING_FILL,
  DRAWING_INK,
  type Drawing,
  type DrawingTarget,
  type Point,
} from '../lib/drawing'

interface Draft {
  drawing: Drawing
  target: DrawingTarget
  typing?: boolean
}

/** Stage owns the pointer capture, including presses over a frame's shield.
 *  The preview lives in world space, so pan/zoom use the same transform as frames. */
export function useCanvasDrawing(stage: RefObject<HTMLDivElement>) {
  const [draft, renderDraft] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const lastPathPress = useRef(0)
  const [hover, setHover] = useState<(Point & { unsnapped?: boolean }) | null>(null)
  const setDraft = useCallback((value: Draft | null) => {
    draftRef.current = value
    renderDraft(value)
  }, [])
  const cancel = useCallback(() => {
    cleanup.current?.()
    cleanup.current = null
    lastPathPress.current = 0
    setDraft(null)
    setHover(null)
  }, [setDraft])
  const finish = useCallback(
    (closed = false) => {
      const current = draftRef.current
      if (!current) return
      let drawing = current.drawing
      if (drawing.tool === 'path') {
        if (!drawing.points || drawing.points.length < 2) return
        drawing = pathDrawing(drawing.points, closed)
      }
      cancel()
      useStore.getState().setTool('select')
      if (drawing.tool === 'text' && !drawing.text?.trim()) return
      void saveDrawing(drawing, current.target)
    },
    [cancel],
  )

  useEffect(() => {
    const unsub = useStore.subscribe((s, prev) => {
      if (s.tool !== prev.tool || s.activePageId !== prev.activePageId || s.canvas?.id !== prev.canvas?.id) cancel()
    })
    function onKey(e: KeyboardEvent) {
      const current = draftRef.current
      if (!current) return
      if (e.isComposing || (isTypingTarget(e.target) && !e.target.matches('textarea[data-drawing-input]'))) return
      if (e.key === 'Alt') {
        setHover((at) => (at ? { ...at, unsnapped: true } : null))
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        cancel()
        useStore.getState().setTool('select')
      } else if (
        e.key === 'Enter' &&
        (current.drawing.tool === 'path' || (current.typing && (e.metaKey || e.ctrlKey)))
      ) {
        e.preventDefault()
        e.stopImmediatePropagation()
        finish()
      } else if (!current.typing && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const points = current.drawing.points
        if (points && points.length > 1) setDraft({ ...current, drawing: pathDrawing(points.slice(0, -1)) })
        else cancel()
      }
    }
    function onBlur() {
      // Keep a text draft if focus moved to another application.
      if (!draftRef.current?.typing) cancel()
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Alt') setHover((at) => (at ? { ...at, unsnapped: false } : null))
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      unsub()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      cleanup.current?.()
    }
  }, [cancel, finish, setDraft])

  function toWorld(clientX: number, clientY: number): Point {
    const rect = stage.current!.getBoundingClientRect()
    const vp = useStore.getState().viewport
    return { x: (clientX - rect.left - vp.x) / vp.zoom, y: (clientY - rect.top - vp.y) / vp.zoom }
  }
  /** The world point under the pointer, pulled onto the ruler guides unless
   *  Alt is held — the same bypass as the pen's anchor snapping. */
  function snappedWorld(ev: { clientX: number; clientY: number; altKey: boolean }): Point {
    const at = toWorld(ev.clientX, ev.clientY)
    return ev.altKey ? at : snapPointToGuides(at, visibleGuides(), useStore.getState().viewport.zoom)
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if ((e.target as Element).closest('[data-comment-ui]')) {
      cancel()
      return
    }
    if ((e.target as Element).closest('[data-drawing-input], [data-ruler]')) return
    if (!e.isPrimary || gesture.pinching) {
      if (!draftRef.current?.typing) cancel()
      return
    }
    const s = useStore.getState()
    const tool = s.tool
    if (
      !isDrawingTool(tool) ||
      resolvePointerAction({
        tool,
        target: 'background',
        button: e.button,
        pointerType: e.pointerType,
        spaceHeld: s.panMode,
      }) !== 'draw'
    )
      return
    e.preventDefault()
    e.stopPropagation()
    if (draftRef.current?.typing) {
      finish()
      return
    }
    const start = snappedWorld(e)
    const target = draftRef.current?.target ?? drawingTarget(start, tool)
    if (!target) return
    s.setFollowing(null)
    if (tool === 'path') {
      const points = draftRef.current?.drawing.points ?? []
      const zoom = s.viewport.zoom
      /* the path's own anchors pull harder than the guides do */
      const snapped = e.altKey ? null : nearestPathAnchor(points, toWorld(e.clientX, e.clientY), zoom)
      const placed = snapped === null ? start : { x: points[snapped]!.x, y: points[snapped]!.y }
      const closing = points.length >= 2 && snapped === 0
      const last = points.at(-1)
      const repeated = last && Math.hypot(placed.x - last.x, placed.y - last.y) * zoom <= 2
      // Preventing pointerdown's default suppresses native dblclick in some
      // browsers. Recognize the second press here, including a double tap.
      if (repeated && points.length >= 2 && e.timeStamp - lastPathPress.current < 400) {
        finish()
        return
      }
      lastPathPress.current = e.timeStamp
      if (repeated && !closing) return
      const anchors = closing ? points : [...points, placed]
      const index = closing ? 0 : anchors.length - 1
      const anchor = anchors[index]!
      setDraft({ target, drawing: pathDrawing(anchors, closing) })
      setHover(null)
      const el = e.currentTarget
      const pointerId = e.pointerId
      el.setPointerCapture(pointerId)
      function moveHandle(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return
        if (gesture.pinching) return cancel()
        const at = toWorld(ev.clientX, ev.clientY)
        let dx = at.x - start.x
        let dy = at.y - start.y
        if (Math.hypot(dx, dy) * useStore.getState().viewport.zoom < 3) return
        if (ev.shiftKey) {
          const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
          const length = Math.hypot(dx, dy)
          dx = Math.cos(angle) * length
          dy = Math.sin(angle) * length
        }
        lastPathPress.current = 0
        const next = anchors.map((p, i) => (i === index ? { ...anchor, handle: { x: dx, y: dy } } : p))
        setDraft({ target: target!, drawing: pathDrawing(next, closing) })
      }
      function upHandle(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return
        cleanup.current?.()
        cleanup.current = null
        if (gesture.pinching) return cancel()
        if (closing) finish(true)
      }
      function cancelHandle(ev: PointerEvent) {
        if (ev.pointerId === pointerId) cancel()
      }
      cleanup.current = () => {
        window.removeEventListener('pointermove', moveHandle)
        window.removeEventListener('pointerup', upHandle)
        window.removeEventListener('pointercancel', cancelHandle)
        el.removeEventListener('lostpointercapture', cancelHandle)
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
      }
      window.addEventListener('pointermove', moveHandle)
      window.addEventListener('pointerup', upHandle)
      window.addEventListener('pointercancel', cancelHandle)
      el.addEventListener('lostpointercapture', cancelHandle)
      return
    }
    cancel()
    const drawTool: DrawingTool = tool
    setDraft({ target, drawing: drawingBounds(tool, start, start) })
    const el = e.currentTarget
    const pointerId = e.pointerId
    el.setPointerCapture(pointerId)
    function move(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      if (gesture.pinching) return cancel()
      setDraft({
        target: target!,
        drawing: drawingBounds(drawTool, start, snappedWorld(ev), ev.shiftKey),
      })
    }
    function up(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      if (gesture.pinching) return cancel()
      const end = snappedWorld(ev)
      const clicked = Math.hypot(end.x - start.x, end.y - start.y) * useStore.getState().viewport.zoom < 3
      const drawing = clicked ? defaultDrawing(drawTool, start) : drawingBounds(drawTool, start, end, ev.shiftKey)
      cleanup.current?.()
      cleanup.current = null
      if (drawing.width < 1 || drawing.height < 1) return cancel()
      setDraft({ target: target!, drawing, typing: tool === 'text' })
      if (tool !== 'text') finish()
    }
    function cancelled(ev: PointerEvent) {
      if (ev.pointerId === pointerId) cancel()
    }
    cleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancelled)
      el.removeEventListener('lostpointercapture', cancelled)
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancelled)
    el.addEventListener('lostpointercapture', cancelled)
  }

  const preview = draft && (
    <DrawingPreview
      draft={draft}
      hover={hover}
      onText={(text, height) => setDraft({ ...draft, drawing: { ...draft.drawing, text, height } })}
      onFinish={() => finish()}
    />
  )
  return {
    preview,
    pathActive: draft?.drawing.tool === 'path',
    canFinishPath: (draft?.drawing.points?.length ?? 0) >= 2,
    finish: () => finish(),
    cancel,
    onPointerDown,
    onPointerMove: (e: ReactPointerEvent) => {
      if (draftRef.current?.drawing.tool === 'path' && !cleanup.current && !useStore.getState().panMode)
        setHover({ ...toWorld(e.clientX, e.clientY), unsnapped: e.altKey })
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if (draftRef.current?.drawing.tool !== 'path') return
      e.preventDefault()
      e.stopPropagation()
      finish()
    },
    onTouchStart: (e: React.TouchEvent) => {
      if (e.touches.length >= 2 && !draftRef.current?.typing) cancel()
    },
  }
}

function DrawingPreview({
  draft,
  hover,
  onText,
  onFinish,
}: {
  draft: Draft
  hover: (Point & { unsnapped?: boolean }) | null
  onText: (text: string, height: number) => void
  onFinish: () => void
}) {
  const zoom = useStore((s) => s.viewport.zoom)
  const d = draft.drawing
  if (draft.typing)
    return (
      <textarea
        data-drawing-input
        aria-label="Text to add to canvas"
        autoFocus
        placeholder="Type something…"
        value={d.text ?? ''}
        onChange={(e) => onText(e.target.value, Math.max(d.height, e.target.scrollHeight))}
        onBlur={onFinish}
        className="absolute z-30 resize-none border-0 bg-white/90 p-0 text-[#202124] outline-2 outline-brand"
        style={{
          left: d.x,
          top: d.y,
          width: d.width,
          height: Math.max(34, d.height),
          font: '24px/1.4 Arial,sans-serif',
          overflowWrap: 'anywhere',
        }}
      />
    )
  if (d.tool === 'path') {
    const points = d.points ?? []
    const snapped = hover && !hover.unsnapped ? nearestPathAnchor(points, hover, zoom) : null
    const closing = snapped === 0 && points.length >= 2
    const at = snapped === null ? hover : { x: points[snapped]!.x, y: points[snapped]!.y }
    const preview = pathDrawing(at && !d.closed && !closing ? [...points, at] : points, d.closed || closing)
    return (
      <svg
        data-path-preview
        className="pointer-events-none absolute z-20 overflow-visible"
        style={{ left: preview.x, top: preview.y }}
        width={preview.width}
        height={preview.height}
      >
        <path d={pathData(preview)} fill="none" stroke={DRAWING_INK} strokeWidth={2} strokeLinejoin="round" />
        {points
          .filter((p) => p.handle)
          .map((p, i) => (
            <g key={`handle-${i}`} stroke="var(--brand)" strokeWidth="calc(0.75px / var(--zoom, 1))">
              <line
                x1={p.x - p.handle!.x - preview.x}
                y1={p.y - p.handle!.y - preview.y}
                x2={p.x + p.handle!.x - preview.x}
                y2={p.y + p.handle!.y - preview.y}
              />
              {[-1, 1].map((side) => (
                <circle
                  key={side}
                  cx={p.x + side * p.handle!.x - preview.x}
                  cy={p.y + side * p.handle!.y - preview.y}
                  r="calc(2px / var(--zoom, 1))"
                  fill="var(--brand)"
                />
              ))}
            </g>
          ))}
        {points.map((p, i) => (
          <circle
            key={i}
            data-path-anchor={i}
            data-snapped={snapped === i ? 'true' : undefined}
            cx={p.x - preview.x}
            cy={p.y - preview.y}
            r="calc(2.5px / var(--zoom, 1))"
            fill={snapped === i ? 'var(--brand)' : 'white'}
            stroke="var(--brand)"
            strokeWidth="calc(0.75px / var(--zoom, 1))"
          />
        ))}
        {snapped !== null && (
          <circle
            data-path-snap={closing ? 'close' : 'anchor'}
            cx={points[snapped]!.x - preview.x}
            cy={points[snapped]!.y - preview.y}
            r="calc(7px / var(--zoom, 1))"
            fill="none"
            stroke="var(--brand)"
            strokeWidth="calc(0.75px / var(--zoom, 1))"
          />
        )}
      </svg>
    )
  }
  return (
    <div
      className="pointer-events-none absolute z-20 [box-shadow:0_0_0_calc(1px/var(--zoom,1))_var(--brand)]"
      style={{
        left: d.x,
        top: d.y,
        width: d.width,
        height: d.height,
        background: d.tool === 'frame' ? '#fff' : d.tool === 'text' ? 'transparent' : DRAWING_FILL,
        borderRadius: d.tool === 'circle' ? '50%' : 0,
      }}
    />
  )
}
