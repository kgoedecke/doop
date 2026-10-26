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
import {
  editElementGeometry,
  elementMoveTarget,
  requestFrame,
  styleGesture,
  type ElementInfo,
  type LayoutDrop,
} from '../lib/frameBridge'
import { gesture } from '../lib/gesture'
import { FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY, counterZoom } from '../lib/layoutZoom'
import { visibleGuides } from '../lib/guides'
import { snapFrame } from '../lib/snap'
import { dropLayer } from '../lib/layerEdits'
import { useStore } from '../lib/store'

interface Preview {
  rect: DrawingRect
  html: string
  target: Frame | null
  world: Element
}

type Press = ReactPointerEvent<HTMLDivElement>
type Fallback = (press: Press, move: PointerEvent | null, released: boolean) => void

export interface ElementMoveHit {
  selector: string
  tag: string
  text: string
  snippet: string
  rect: DrawingRect
  sizable?: boolean
  locked?: boolean
}

/** Hit testing happens inside the iframe. Buffer pointer events while it
 * answers so even a fast drag follows the visible element under the press. */
export function useElementMove(frame: Frame, layoutZoom: number) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [moving, setMoving] = useState(false)
  const [layoutDrop, setLayoutDrop] = useState<{
    drop: LayoutDrop
    world: Element
    origin: { x: number; y: number }
  } | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const finishing = useRef<Promise<void>>(Promise.resolve())
  const lastClick = useRef<{ selector: string; at: number; x: number; y: number } | null>(null)
  useEffect(() => () => cleanup.current?.(), [])

  function start(
    e: Press,
    fallback: Fallback,
    onDoubleClick: (selector: string) => void,
    onLayerHit: (hit: ElementMoveHit) => void,
  ): boolean {
    if (e.altKey || !e.isPrimary || !frame.html) return false
    const s = useStore.getState()
    if (!e.shiftKey && s.selectedIds.includes(frame.id) && s.selectedIds.length > 1) return false
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
    const contentBox = surface.querySelector('iframe')?.getBoundingClientRect()
    const contentOrigin = contentBox ? toWorld(contentBox.left, contentBox.top) : { x: frame.x, y: frame.y }
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
    let layer: ElementMoveHit | null = null
    let layerReady: Promise<ElementInfo | null> | null = null
    let layerPoint: { x: number; y: number; pointerX: number; pointerY: number } | null = null
    let layerWork: Promise<void> = Promise.resolve()
    let inFlight = false
    let picked = false

    function pickHit() {
      if (picked) return
      picked = true
      useStore.getState().select(frame.id)
      if (layer) {
        useStore.getState().pickElement({ frameId: frame.id, selector: layer.selector })
        onLayerHit(layer)
      } else if (hit && !standalone) useStore.getState().pickElement({ frameId: frame.id, selector: hit.selector })
    }

    function sourceUnchanged(next = useStore.getState()) {
      const live = next.canvas?.frames.find((f) => f.id === frame.id)
      return (
        next.canvas?.id === frame.canvasId &&
        next.activePageId === pageId &&
        next.tool === 'select' &&
        !next.panMode &&
        !!live &&
        !live.locked &&
        !live.hidden &&
        live.html === frame.html &&
        live.x === frame.x &&
        live.y === frame.y &&
        live.width === frame.width &&
        live.height === frame.height
      )
    }

    function updateLayer(info: ElementInfo | null) {
      const state = useStore.getState()
      const live = state.canvas?.frames.find((f) => f.id === frame.id)
      if (info && layer && live?.html === frame.html && state.selectedElement?.selector === layer.selector)
        onLayerHit({ ...layer, rect: info.rect })
    }
    function previewLayer() {
      if (closed || !layer || !layerPoint || inFlight) return
      if (!layerReady) {
        setMoving(true)
        const selector = layer.selector
        layerReady = finishing.current.then(() =>
          sourceUnchanged() ? styleGesture(frame.id, selector, 'begin') : null,
        )
      }
      inFlight = true
      const point = layerPoint
      layerWork = layerReady.then(async (info) => {
        if (closed) return
        if (!info) return cancel()
        const selector = layer!.selector
        updateLayer(await editElementGeometry(frame.id, selector, { kind: 'move', x: point.x, y: point.y }))
        if (closed) return
        const result = await elementMoveTarget(frame.id, selector, point.pointerX, point.pointerY)
        if (closed) return
        if (layerPoint === point)
          setLayoutDrop(result?.drop ? { drop: result.drop, world: world!, origin: contentOrigin } : null)
        inFlight = false
        if (layerPoint !== point) previewLayer()
      })
    }

    function cancel(commit = false) {
      if (closed) return
      closed = true
      unsubscribe()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      surface.removeEventListener('lostpointercapture', onLostCapture)
      if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId)
      cleanup.current = null
      setPreview(null)
      setLayoutDrop(null)
      setMoving(false)
      useStore.getState().setSnapGuides([])
      // Finish after the asynchronous begin, even if a flick or Escape beat it.
      if (layerReady && layer) {
        const selector = layer.selector
        const final = layerPoint
        finishing.current = layerReady.then(async (info) => {
          if (!info) return
          // Drain a preview before restoring styles or saving. A slow hit-test
          // must never repaint after Escape, or commit the previous pointer slot.
          await layerWork
          const result =
            commit && final && sourceUnchanged()
              ? await elementMoveTarget(frame.id, selector, final.pointerX, final.pointerY)
              : undefined
          if (commit && final && sourceUnchanged() && result?.free) {
            updateLayer(await editElementGeometry(frame.id, selector, { kind: 'move', x: final.x, y: final.y }))
            updateLayer(await styleGesture(frame.id, selector, sourceUnchanged() ? 'commit' : 'cancel'))
          } else {
            updateLayer(await styleGesture(frame.id, selector, 'cancel'))
            if (commit && result?.drop && sourceUnchanged())
              dropLayer(frame, selector, result.drop.target, result.drop.styles)
          }
        })
      }
    }
    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId || closed) return
      lastMove = ev
      if (gesture.pinching) return cancel()
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      moved = true
      if (!bounds) return
      pickHit()
      const point = toWorld(ev.clientX, ev.clientY)
      let locked: 'x' | 'y' | null = null
      if (ev.shiftKey) {
        locked = Math.abs(point.x - origin.x) >= Math.abs(point.y - origin.y) ? 'y' : 'x'
        point[locked] = origin[locked]
      }
      rect = { ...bounds, x: bounds.x + point.x - origin.x, y: bounds.y + point.y - origin.y }
      /* edges and center pull onto the ruler guides (⌥ moves freely); an
         axis Shift holds still stays held */
      const snapped = ev.altKey ? null : snapFrame('move', rect, [], useStore.getState().viewport.zoom, visibleGuides())
      if (snapped) {
        rect = { ...rect, x: locked === 'x' ? rect.x : snapped.x, y: locked === 'y' ? rect.y : snapped.y }
        useStore.getState().setSnapGuides(snapped.guides.filter((g) => (g.axis === 'v' ? 'x' : 'y') !== locked))
      } else useStore.getState().setSnapGuides([])
      if (layer) {
        layerPoint = {
          x: rect.x - frame.x,
          y: rect.y - frame.y,
          pointerX: point.x - contentOrigin.x,
          pointerY: point.y - contentOrigin.y,
        }
        previewLayer()
        return
      }
      target = drawingDropFrame(point, standalone ? frame.id : undefined)
      setPreview({ rect, html, target, world: world! })
    }
    function onUp(ev: PointerEvent) {
      if (ev.pointerId !== pointerId || closed) return
      released = ev
      onMove(ev)
      if (closed) return
      if (!hit && !layer) return
      const complete = moved && !gesture.pinching && !closed
      cancel(complete && !!layer)
      // A Shift press remains a selection toggle until it actually drags.
      if (!complete && press.shiftKey) {
        lastClick.current = null
        fallback(press, null, true)
        return
      }
      if (layer) {
        // Keep clicks and double-click text editing on the existing probe path.
        if (!complete) fallback(press, null, true)
        return
      }
      if (!hit) return
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
    function onBlur() {
      cancel()
    }
    const unsubscribe = useStore.subscribe((next) => {
      if (!sourceUnchanged(next)) cancel()
    })
    surface.setPointerCapture(pointerId)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    surface.addEventListener('lostpointercapture', onLostCapture)
    cleanup.current = cancel
    const selected = s.selectedElement?.frameId === frame.id ? s.selectedElement.selector : undefined
    const drawingHit = finishing.current.then(() =>
      frame.html.includes('data-doop-drawing')
        ? requestFrame(frame.id, 'doop:drawing-hit', {
            x: origin.x - frame.x,
            y: origin.y - frame.y,
            standalone,
            selected,
          })
        : null,
    )
    void drawingHit.then(async (reply) => {
      if (closed) return
      hit = (reply?.hit ?? null) as DrawingHit | null
      if (!hit) {
        const response = await requestFrame(frame.id, 'doop:move-hit', {
          x: origin.x - frame.x,
          y: origin.y - frame.y,
          selected,
        })
        if (closed) return
        layer = (response?.hit ?? null) as ElementMoveHit | null
        if (layer) {
          bounds = { ...layer.rect, x: frame.x + layer.rect.x, y: frame.y + layer.rect.y }
          if (!press.shiftKey) pickHit()
          if (lastMove) onMove(lastMove)
          if (released) onUp(released)
          return
        }
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
      if (!press.shiftKey) pickHit()
      if (lastMove) onMove(lastMove)
      if (released) onUp(released)
    })
    return true
  }

  return {
    start,
    moving,
    preview: (
      <>
        {layoutDrop &&
          createPortal(
            <div
              className="pointer-events-none absolute inset-0 z-40"
              style={{ left: layoutDrop.origin.x, top: layoutDrop.origin.y }}
            >
              <div
                data-element-drop-target
                className="absolute bg-brand/10 [box-shadow:0_0_0_calc(1px/var(--zoom,1))_var(--brand)]"
                style={{
                  left: layoutDrop.drop.container.x,
                  top: layoutDrop.drop.container.y,
                  width: layoutDrop.drop.container.width,
                  height: layoutDrop.drop.container.height,
                }}
              />
              <div
                data-element-drop-indicator
                className="absolute bg-brand"
                style={{
                  left: layoutDrop.drop.line.x,
                  top: layoutDrop.drop.line.y,
                  width: layoutDrop.drop.line.width || 'calc(2px / var(--zoom, 1))',
                  height: layoutDrop.drop.line.height || 'calc(2px / var(--zoom, 1))',
                }}
              />
            </div>,
            layoutDrop.world,
          )}
        {preview &&
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
          )}
      </>
    ),
  }
}
