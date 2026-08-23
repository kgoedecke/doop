import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { sendWs } from '../lib/ws'
import { throttle } from '../lib/throttle'
import { FrameView } from './FrameView'
import { GhostFrames } from './GhostFrames'
import { Cursors } from './Cursors'
import { SnapGuides } from './SnapGuides'
import { ContextMenu, MOD_KEY } from './ContextMenu'
import { hasFrameClip, pasteFrameAtScreen } from '../lib/frameClipboard'

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
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null)
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
  const focusFrame = useCallback(
    (f: { id: string; x: number; y: number; width: number; height: number }) => {
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
    },
    [select, setViewport],
  )

  const fit = useCallback(() => {
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
  }, [setViewport])

  /* zoom-to-fit once the canvas arrives — unless the URL deep-links a frame */
  useEffect(() => {
    if (!canvas || fitted.current) return
    fitted.current = true
    const focusId = new URLSearchParams(location.search).get('frame')
    const target = focusId ? canvas.frames.find((f) => f.id === focusId) : null
    if (target) focusFrame(target)
    else fit()
  }, [canvas, fit, focusFrame])

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
      const dx = ev.clientX - last.x
      const dy = ev.clientY - last.y
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
      last = { x: ev.clientX, y: ev.clientY }
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
      <div
        ref={ref}
        className={`stage ${panning ? 'panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onContextMenu={(e) => {
          /* frames handle their own menu; this one is for the empty canvas */
          const isBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('world')
          if (!isBackground) return
          e.preventDefault()
          setBgMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {/* dot grid on its own composited layer: panning is transform-only
            (zero paint), zooming repaints just this layer's tiny tile */}
        <div className="grid-layer" ref={gridRef} />
        <div className="world" ref={worldRef}>
          {canvas?.frames.map((f) => (
            <FrameView key={f.id} frame={f} raster={raster} />
          ))}
          <GhostFrames />
          <SnapGuides />
          <Cursors />
        </div>
      </div>

      <div className="toolbar">
        <button onClick={onAddFrame}>+ Frame</button>
        <div className="divider" />
        <button
          onClick={() => {
            const vp = useStore.getState().viewport
            const el = ref.current!
            zoomAround(el, vp, 1 / 1.25)
          }}
        >
          −
        </button>
        <span className="zoom-label" ref={zoomLabelRef}>
          100%
        </span>
        <button
          onClick={() => {
            const vp = useStore.getState().viewport
            const el = ref.current!
            zoomAround(el, vp, 1.25)
          }}
        >
          +
        </button>
        <div className="divider" />
        <button onClick={fit}>Fit</button>
      </div>

      {bgMenu && canvas && (
        <ContextMenu at={bgMenu} onClose={() => setBgMenu(null)}>
          <button
            disabled={!hasFrameClip()}
            onClick={() => {
              setBgMenu(null)
              pasteFrameAtScreen(canvas.id, bgMenu.x, bgMenu.y)
            }}
          >
            Paste
            <span className="ctx-hint">{MOD_KEY}V</span>
          </button>
          <button
            onClick={() => {
              setBgMenu(null)
              onAddFrame()
            }}
          >
            New frame
          </button>
        </ContextMenu>
      )}
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
