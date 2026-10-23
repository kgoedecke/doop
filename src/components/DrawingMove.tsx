import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Frame } from '../../shared/types'
import { isCanvasElement } from '../lib/drawing'
import {
  drawingDropFrame,
  movableDrawing,
  moveDrawing,
  placeDrawing,
  type DrawingHit,
  type DrawingRect,
} from '../lib/drawingMove'
import { requestFrame } from '../lib/frameBridge'
import { gesture } from '../lib/gesture'
import { FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY, counterZoom } from '../lib/layoutZoom'
import { useStore } from '../lib/store'

interface Preview {
  rect: DrawingRect
  html: string
  target: Frame | null
  world: Element
}

type Press = ReactPointerEvent<HTMLDivElement>
type Fallback = (press: Press, move: PointerEvent | null, released: boolean) => void

/** Hit testing happens inside the iframe. Buffer pointer events while it
 * answers so even a fast drag follows the visible element under the press. */
export function useDrawingMove(frame: Frame, layoutZoom: number) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const lastClick = useRef<{ selector: string; at: number; x: number; y: number } | null>(null)
  useEffect(() => () => cleanup.current?.(), [])

  function start(e: Press, fallback: Fallback, onDoubleClick?: (selector: string) => void): boolean {
    if (e.shiftKey || e.altKey || !e.isPrimary || !frame.html.includes('data-doop-drawing')) return false
    const s = useStore.getState()
    if (s.selectedIds.includes(frame.id) && s.selectedIds.length > 1) return false
    const standalone = isCanvasElement(frame.html)
    const surface = e.currentTarget
    const stage = surface.closest('.stage')
    const world = stage?.querySelector('.world')
    if (!stage || !world) return false
    const toWorld = (clientX: number, clientY: number) => {
      const box = stage.getBoundingClientRect()
      const vp = useStore.getState().viewport
      return { x: (clientX - box.left - vp.x) / vp.zoom, y: (clientY - box.top - vp.y) / vp.zoom }
    }
    const origin = toWorld(e.clientX, e.clientY)
    const press: Press = {
      ...e,
      currentTarget: surface,
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
    }
    e.preventDefault()
    e.stopPropagation()
    cleanup.current?.()
    const pageId = s.activePageId
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    let closed = false
    let moved = false
    let lastMove: PointerEvent | null = null
    let released: PointerEvent | null = null
    let hit: DrawingHit | null = null
    let bounds: DrawingRect | null = null
    let rect: DrawingRect | null = null
    let html = ''
    let target: Frame | null = null

    function cancel() {
      if (closed) return
      closed = true
      unsubscribe()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', cancel)
      surface.removeEventListener('lostpointercapture', onLostCapture)
      if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId)
      cleanup.current = null
      setPreview(null)
    }
    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId || closed) return
      lastMove = ev
      if (gesture.pinching) return cancel()
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      moved = true
      if (!bounds) return
      const point = toWorld(ev.clientX, ev.clientY)
      rect = { ...bounds, x: bounds.x + point.x - origin.x, y: bounds.y + point.y - origin.y }
      target = drawingDropFrame(point, standalone ? frame.id : undefined)
      setPreview({ rect, html, target, world: world! })
    }
    function onUp(ev: PointerEvent) {
      if (ev.pointerId !== pointerId || closed) return
      released = ev
      onMove(ev)
      if (!hit) return
      const complete = moved && !gesture.pinching && !closed
      cancel()
      if (complete && rect) void moveDrawing(frame, standalone ? undefined : hit.selector, rect, target?.id, hit)
      const previous = lastClick.current
      lastClick.current = complete ? null : { selector: hit.selector, at: ev.timeStamp, x: ev.clientX, y: ev.clientY }
      if (
        !complete &&
        !gesture.pinching &&
        previous?.selector === hit.selector &&
        ev.timeStamp - previous.at < 400 &&
        Math.hypot(ev.clientX - previous.x, ev.clientY - previous.y) < 4
      ) {
        lastClick.current = null
        onDoubleClick?.(hit.selector)
      }
    }
    function onCancel(ev: PointerEvent) {
      if (ev.pointerId === pointerId) cancel()
    }
    function onLostCapture(ev: PointerEvent) {
      if (!released) onCancel(ev)
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      cancel()
    }
    const unsubscribe = useStore.subscribe((next) => {
      if (next.canvas?.id !== frame.canvasId || next.activePageId !== pageId || next.tool !== 'select') cancel()
    })
    surface.setPointerCapture(pointerId)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', cancel)
    surface.addEventListener('lostpointercapture', onLostCapture)
    cleanup.current = cancel
    void requestFrame(frame.id, 'doop:drawing-hit', { x: origin.x - frame.x, y: origin.y - frame.y, standalone }).then(
      (reply) => {
        if (closed) return
        hit = (reply?.hit ?? null) as DrawingHit | null
        if (!hit) {
          cancel()
          fallback(press, lastMove, !!released)
          return
        }
        const live = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
        const el = live?.html === frame.html ? movableDrawing(live, standalone ? undefined : hit.selector) : null
        if (!el) return cancel()
        bounds = { ...hit.rect, x: frame.x + hit.rect.x, y: frame.y + hit.rect.y }
        rect = bounds
        placeDrawing(el, bounds, undefined, hit.geometry)
        html = `<!doctype html><html><body style="margin:0">${el.outerHTML}</body></html>`
        useStore.getState().select(frame.id)
        if (!standalone) useStore.getState().pickElement({ frameId: frame.id, selector: hit.selector })
        if (lastMove) onMove(lastMove)
        if (released) onUp(released)
      },
    )
    return true
  }

  return {
    start,
    preview:
      preview &&
      createPortal(
        <div className="pointer-events-none absolute inset-0 z-40">
          {preview.target && (
            <div
              data-drawing-drop-target={preview.target.id}
              className="absolute bg-brand/10 [box-shadow:0_0_0_calc(2px/var(--zoom,1))_var(--brand)]"
              style={{
                left: preview.target.x,
                top: preview.target.y,
                width: preview.target.width,
                height: preview.target.height,
              }}
            />
          )}
          <div
            className="absolute opacity-80 [box-shadow:0_0_0_calc(1px/var(--zoom,1))_var(--brand)]"
            style={{
              left: preview.rect.x,
              top: preview.rect.y,
              width: preview.rect.width,
              height: preview.rect.height,
            }}
          >
            {/* treats the world's layout zoom as FrameView's iframe does (pixel
                density in Chromium, undone elsewhere), so the drawing lays out
                at the width it has in its frame and stays as sharp */}
            <iframe
              title="Moving drawing"
              sandbox=""
              srcDoc={preview.html}
              className="block border-0 bg-transparent"
              style={{
                width: preview.rect.width,
                height: preview.rect.height,
                ...(FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY
                  ? null
                  : { zoom: counterZoom(layoutZoom), transform: `scale(${layoutZoom})` }),
                transformOrigin: '0 0',
              }}
            />
          </div>
        </div>,
        preview.world,
      ),
  }
}
