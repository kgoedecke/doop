import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { sendWs } from '../lib/ws'
import { throttle } from '../lib/throttle'
import { FrameView } from './FrameView'
import { FlowOverlay } from './FlowOverlay'
import { GhostFrames } from './GhostFrames'
import { Cursors } from './Cursors'
import { SnapGuides } from './SnapGuides'
import { MOD_KEY } from '../lib/keys'
import { cn } from '../lib/utils'
import { gesture } from '../lib/gesture'
import { hasFrameClip, pasteFrameAtScreen } from '../lib/frameClipboard'
import { MenuHint } from './ui/menu'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { Toolbar, ToolbarButton, ToolbarDivider, ToolbarValue } from './ui/toolbar'

const MIN_ZOOM = 0.08
const MAX_ZOOM = 3

const sendCursor = throttle((x: number, y: number) => sendWs({ type: 'cursor', x, y }), 50)

export function Stage({ onAddFrame }: { onAddFrame: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const zoomLabelRef = useRef<HTMLSpanElement>(null)
  const setViewport = useStore((s) => s.setViewport)
  const canvas = useStore((s) => s.canvas)
  const select = useStore((s) => s.select)
  const [panning, setPanning] = useState(false)
  /* where the background menu opened, so Paste drops the frame there */
  const bgAt = useRef({ x: 0, y: 0 })
  /* iframe oversampling factor — bumped only once the zoom settles */
  const [raster, setRaster] = useState(1)
  const fitted = useRef(false)

  /* Viewport → DOM without React: no component subscribes to the viewport, so
     pan/zoom never renders anything. A store subscription writes the world
     transform, the grid layer, the --zoom variable (which counter-scales
     labels/pins/cursors from CSS), and the toolbar % directly. */
  useLayoutEffect(() => {
    function apply(vp: { x: number; y: number; zoom: number }) {
      const world = worldRef.current
      const grid = gridRef.current
      const stage = ref.current
      if (!world || !grid || !stage) return
      world.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`
      stage.style.setProperty('--zoom', String(vp.zoom))
      const period = 26 * vp.zoom
      grid.style.backgroundSize = `${period}px ${period}px`
      const gx = (((vp.x % period) + period) % period) - period
      const gy = (((vp.y % period) + period) % period) - period
      grid.style.transform = `translate(${gx}px, ${gy}px)`
      if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(vp.zoom * 100)}%`
    }
    apply(useStore.getState().viewport)
    let settle = 0
    const unsub = useStore.subscribe((s, prev) => {
      if (s.viewport === prev.viewport) return
      apply(s.viewport)
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        const z = useStore.getState().viewport.zoom
        setRaster(z <= 1 ? 1 : Math.min(3, Math.ceil(z * 2) / 2))
      }, 250)
    })
    return () => {
      unsub()
      window.clearTimeout(settle)
    }
  }, [])

  /* zoom-to-fit once the canvas arrives — unless the URL deep-links a frame */
  useEffect(() => {
    if (!canvas || fitted.current) return
    fitted.current = true
    const focusId = new URLSearchParams(location.search).get('frame')
    const target = focusId ? canvas.frames.find((f) => f.id === focusId) : null
    if (target) focusFrame(target)
    else fit()
  }, [canvas])

  /* a fly-to request (prompt bar): glide the camera to the frame instead of
     snapping, so the new design streams in on-screen with a bit of drama.
     The request object stays in the store; only a NEW request re-runs this. */
  const flyTo = useStore((s) => s.flyTo)
  useEffect(() => {
    if (!flyTo) return
    const el = ref.current
    const f = useStore.getState().canvas?.frames.find((x) => x.id === flyTo.frameId)
    if (!el || !f) return
    const pad = 80
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((el.clientWidth - pad * 2) / f.width, (el.clientHeight - pad * 2) / f.height, 1)),
    )
    const target = {
      x: (el.clientWidth - f.width * zoom) / 2 - f.x * zoom,
      y: (el.clientHeight - f.height * zoom) / 2 - f.y * zoom,
      zoom,
    }
    const from = useStore.getState().viewport
    const start = performance.now()
    const DURATION = 700
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    let raf = requestAnimationFrame(function step(now: number) {
      const k = ease(Math.min(1, (now - start) / DURATION))
      setViewport({
        x: from.x + (target.x - from.x) * k,
        y: from.y + (target.y - from.y) * k,
        zoom: from.zoom + (target.zoom - from.zoom) * k,
      })
      if (now - start < DURATION) raf = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(raf)
  }, [flyTo]) // eslint-disable-line react-hooks/exhaustive-deps

  /* center one frame in the viewport and select it (shared frame links) */
  function focusFrame(f: { id: string; x: number; y: number; width: number; height: number }) {
    const el = ref.current
    if (!el) return
    const pad = 80
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((el.clientWidth - pad * 2) / f.width, (el.clientHeight - pad * 2) / f.height, 1)),
    )
    setViewport({
      x: (el.clientWidth - f.width * zoom) / 2 - f.x * zoom,
      y: (el.clientHeight - f.height * zoom) / 2 - f.y * zoom,
      zoom,
    })
    select(f.id)
    /* a shared frame link asks for this exact frame — show its details too */
    useStore.getState().setInspectorOpen(true)
  }

  function fit() {
    const el = ref.current
    const c = useStore.getState().canvas
    if (!el || !c) return
    const boxes = c.frames.map((f) => ({ x: f.x, y: f.y - 30, w: f.width, h: f.height + 30 }))
    if (!boxes.length) {
      setViewport({ x: 80, y: 80, zoom: 1 })
      return
    }
    const minX = Math.min(...boxes.map((b) => b.x))
    const minY = Math.min(...boxes.map((b) => b.y))
    const maxX = Math.max(...boxes.map((b) => b.x + b.w))
    const maxY = Math.max(...boxes.map((b) => b.y + b.h))
    const pad = 80
    const w = el.clientWidth
    const h = el.clientHeight
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY), 1.25)),
    )
    setViewport({
      x: (w - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: (h - (maxY - minY) * zoom) / 2 - minY * zoom,
      zoom,
    })
  }

  /* wheel: pan / pinch-zoom — needs a non-passive listener. Trackpads fire
     wheel events faster than the display refreshes, so deltas accumulate and
     flush once per animation frame: one store update (→ one React render)
     per painted frame instead of one per input event. */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    let panX = 0
    let panY = 0
    let zoomDelta = 0
    let pivotX = 0
    let pivotY = 0

    function flush() {
      raf = 0
      const vp = useStore.getState().viewport
      let { x, y, zoom } = vp
      if (zoomDelta !== 0) {
        /* exp(-deltaY/100) is the browser's own pinch↔wheel mapping, so the
           zoom tracks the finger spread 1:1 like Figma; per-event clamping
           (below) keeps discrete mouse-wheel notches from over-jumping */
        const factor = Math.exp(-zoomDelta * 0.01)
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))
        const scale = next / zoom
        x = pivotX - (pivotX - x) * scale
        y = pivotY - (pivotY - y) * scale
        zoom = next
        zoomDelta = 0
      }
      x -= panX
      y -= panY
      panX = panY = 0
      useStore.getState().setViewport({ x, y, zoom })
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = el!.getBoundingClientRect()
        pivotX = e.clientX - rect.left
        pivotY = e.clientY - rect.top
        zoomDelta += Math.max(-40, Math.min(40, e.deltaY))
      } else {
        panX += e.deltaX
        panY += e.deltaY
      }
      if (!raf) raf = requestAnimationFrame(flush)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  /* touch: a two-finger pinch zooms around the fingers' midpoint and pans
     with it. iOS never maps a pinch onto ctrl+wheel the way desktop browsers
     do, so it needs its own listener — on touch events rather than pointers,
     because frames swallow pointerdown to start their own drag and a pinch
     must win regardless of what the fingers landed on. */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let prev: { dist: number; x: number; y: number } | null = null

    function pinchOf(touches: TouchList) {
      const rect = el!.getBoundingClientRect()
      const [a, b] = [touches[0], touches[1]]
      return {
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        x: (a.clientX + b.clientX) / 2 - rect.left,
        y: (a.clientY + b.clientY) / 2 - rect.top,
      }
    }
    function onStart(e: TouchEvent) {
      if (e.touches.length < 2) return
      e.preventDefault()
      prev = pinchOf(e.touches)
      gesture.pinching = true
    }
    function onMove(e: TouchEvent) {
      if (!prev || e.touches.length < 2) return
      e.preventDefault()
      const cur = pinchOf(e.touches)
      const vp = useStore.getState().viewport
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * (cur.dist / Math.max(1, prev.dist))))
      const scale = zoom / vp.zoom
      /* the world point under the previous midpoint stays under the new one */
      useStore.getState().setViewport({
        x: cur.x - (prev.x - vp.x) * scale,
        y: cur.y - (prev.y - vp.y) * scale,
        zoom,
      })
      prev = cur
    }
    function onEnd(e: TouchEvent) {
      /* three fingers down and one lifts: the pair that remains may not be
         the pair being tracked, so measure it afresh instead of comparing
         it against the old pair's spread */
      if (e.touches.length >= 2) {
        prev = pinchOf(e.touches)
        return
      }
      prev = null
      gesture.pinching = false
    }
    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      gesture.pinching = false
    }
  }, [])

  /* ⌘0 → 100%, ⌘+ / ⌘− → step zoom, all pivoting on the view center —
     preventDefault keeps the browser's own page zoom out of it */
  useEffect(() => {
    function zoomTo(next: number) {
      const el = ref.current
      if (!el) return
      const cx = el.clientWidth / 2
      const cy = el.clientHeight / 2
      const vp = useStore.getState().viewport
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
      const scale = zoom / vp.zoom
      useStore.getState().setViewport({
        x: cx - (cx - vp.x) * scale,
        y: cy - (cy - vp.y) * scale,
        zoom,
      })
    }
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (e.key !== '0' && e.key !== '=' && e.key !== '+' && e.key !== '-') return
      /* '+' arrives as ⇧= on most layouts; any other shifted combo isn't ours */
      if (e.shiftKey && e.key !== '+') return
      e.preventDefault()
      const zoom = useStore.getState().viewport.zoom
      if (e.key === '0') zoomTo(1)
      else if (e.key === '-') zoomTo(zoom / 1.25)
      else zoomTo(zoom * 1.25)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function toWorld(clientX: number, clientY: number) {
    const rect = ref.current!.getBoundingClientRect()
    const vp = useStore.getState().viewport
    return {
      x: (clientX - rect.left - vp.x) / vp.zoom,
      y: (clientY - rect.top - vp.y) / vp.zoom,
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    /* pan on background drag or middle mouse anywhere */
    const isBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('world')
    if (!isBackground && e.button !== 1) return
    if (e.button !== 0 && e.button !== 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setPanning(true)
    let last = { x: e.clientX, y: e.clientY }
    let moved = false

    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== e.pointerId) return
      const dx = ev.clientX - last.x
      const dy = ev.clientY - last.y
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
      last = { x: ev.clientX, y: ev.clientY }
      /* a pinch owns the viewport while it lasts; keep tracking the finger
         so the pan resumes from where it is, not from where the pinch began */
      if (gesture.pinching) return
      const vp = useStore.getState().viewport
      useStore.getState().setViewport({ ...vp, x: vp.x + dx, y: vp.y + dy })
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setPanning(false)
      if (!moved) select(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function onPointerMove(e: React.PointerEvent) {
    const { x, y } = toWorld(e.clientX, e.clientY)
    sendCursor(Math.round(x), Math.round(y))
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            /* `stage` is a behaviour hook, not a style: frameClipboard.ts queries
           `.stage` to map screen coordinates into the canvas. No CSS is
           attached to it — everything visual is in the utilities beside it. */
            className={cn('stage absolute inset-0 touch-none', panning ? 'cursor-grabbing' : 'cursor-default')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onContextMenu={(e) => {
              /* frames stop the event on their own trigger, so anything arriving
                 here is the empty canvas — except a right-click on a frame's
                 chrome overlay, which is not a menu target at all */
              const isBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('world')
              if (!isBackground) return e.preventDefault()
              /* Paste drops the frame where the click landed. The menu's own
                 box is not that point: Radix positions it after mount, and
                 flips it away from a viewport edge. */
              bgAt.current = { x: e.clientX, y: e.clientY }
            }}
          >
            {/* dot grid on its own composited layer: panning is transform-only
            (zero paint), zooming repaints just this layer's tiny tile */}
            <div
              className="pointer-events-none absolute left-0 top-0 h-[calc(100%+160px)] w-[calc(100%+160px)] origin-top-left will-change-transform [background-image:radial-gradient(circle,var(--dot)_1.2px,transparent_1.2px)]"
              ref={gridRef}
            />
            {/* `world` is likewise a behaviour hook: pan hit-testing checks
            classList.contains('world') to tell background from frame */}
            <div className="world absolute left-0 top-0 origin-top-left will-change-transform" ref={worldRef}>
              {canvas?.frames.map((f) => (
                <FrameView key={f.id} frame={f} raster={raster} />
              ))}
              <GhostFrames />
              <FlowOverlay />
              <SnapGuides />
              <Cursors />
            </div>
          </div>
        </ContextMenuTrigger>

        <Toolbar className="absolute bottom-[calc(8px+env(safe-area-inset-bottom))] left-1/2 z-[35] -translate-x-1/2 sm:bottom-4">
          <ToolbarButton onClick={onAddFrame}>+ Frame</ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton
            aria-label="Zoom out"
            onClick={() => {
              const vp = useStore.getState().viewport
              const el = ref.current!
              zoomAround(el, vp, 1 / 1.25)
            }}
          >
            −
          </ToolbarButton>
          <ToolbarValue ref={zoomLabelRef}>100%</ToolbarValue>
          <ToolbarButton
            aria-label="Zoom in"
            onClick={() => {
              const vp = useStore.getState().viewport
              const el = ref.current!
              zoomAround(el, vp, 1.25)
            }}
          >
            +
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton onClick={fit}>Fit</ToolbarButton>
        </Toolbar>

        {canvas && (
          <ContextMenuContent>
            <ContextMenuItem
              disabled={!hasFrameClip()}
              onSelect={() => pasteFrameAtScreen(canvas.id, bgAt.current.x, bgAt.current.y)}
            >
              Paste
              <MenuHint>{MOD_KEY}V</MenuHint>
            </ContextMenuItem>
            <ContextMenuItem onSelect={onAddFrame}>New frame</ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
    </>
  )

  function zoomAround(el: HTMLDivElement, vp: { x: number; y: number; zoom: number }, factor: number) {
    const px = el.clientWidth / 2
    const py = el.clientHeight / 2
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * factor))
    const scale = zoom / vp.zoom
    setViewport({ x: px - (px - vp.x) * scale, y: py - (py - vp.y) * scale, zoom })
  }
}
