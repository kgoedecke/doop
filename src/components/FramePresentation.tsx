import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { useStore } from '../lib/store'
import { presentationScale, presentationZoomLimits, zoomedScroll, type PresentationMode } from '../lib/presentationView'
import { Button } from './ui/button'
import { Modal, ModalTitle } from './ui/modal'

export function FramePresentation() {
  const frame = useStore((s) => s.canvas?.frames.find((f) => f.id === s.presentedFrameId))
  return frame ? (
    <Modal
      size="fullscreen"
      onClose={() => useStore.getState().presentFrame(null)}
      aria-describedby={undefined}
      onKeyDown={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
    >
      <Presentation key={frame.id} frame={frame} />
    </Modal>
  ) : null
}

function Presentation({ frame }: { frame: Frame }) {
  const presentFrame = useStore((s) => s.presentFrame)
  const surface = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const iframe = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<{ mode: PresentationMode; zoom: number }>({ mode: 'fit', zoom: 1 })
  const [pan, setPan] = useState(true)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null)
  const pendingScroll = useRef<{ left: number; top: number } | null>(null)
  const leavingFullscreen = useRef(false)
  const scale = presentationScale(view.mode, view.zoom, size, frame)
  const limits = presentationZoomLimits(size, frame)
  const [fullscreen, setFullscreen] = useState(false)
  const close = () => presentFrame(null)

  /* Measure the available stage, including when browser fullscreen or device
     rotation changes it. The iframe keeps its design viewport at every size. */
  useLayoutEffect(() => {
    const el = stage.current!
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (pendingScroll.current && stage.current) {
      stage.current.scrollTo(pendingScroll.current)
      pendingScroll.current = null
    }
  })

  useEffect(() => {
    // Moving the view must also keep keyboard focus out of embedded controls.
    iframe.current?.toggleAttribute('inert', pan)
  }, [pan])

  const chooseView = (mode: PresentationMode) => {
    pendingScroll.current = { left: 0, top: 0 }
    setView({ mode, zoom: 1 })
  }

  const zoomTo = useCallback(
    (next: number, anchor?: { x: number; y: number }) => {
      const el = stage.current
      if (!el || scale <= 0) return
      const zoom = Math.min(limits.max, Math.max(limits.min, next))
      pendingScroll.current = {
        left: zoomedScroll(el.scrollLeft, anchor?.x ?? el.clientWidth / 2, el.clientWidth, frame.width, scale, zoom),
        top: zoomedScroll(el.scrollTop, anchor?.y ?? el.clientHeight / 2, el.clientHeight, frame.height, scale, zoom),
      }
      setView({ mode: 'custom', zoom })
    },
    [scale, limits.min, limits.max, frame.width, frame.height],
  )

  useEffect(() => {
    const el = stage.current!
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1)
      zoomTo(scale * Math.exp(-delta * 0.01), {
        x: event.clientX - rect.left - el.clientLeft,
        y: event.clientY - rect.top,
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scale, zoomTo])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframe.current?.contentWindow) return
      if (event.data?.type === 'doop:frame-ready') setReady(true)
      /* Keyboard events in a sandboxed iframe do not bubble to the dialog. */
      if (event.data?.type === 'doop:frame-esc') presentFrame(null)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [presentFrame])

  useEffect(() => {
    if (ready) iframe.current?.contentWindow?.postMessage({ type: 'doop:html', html: frame.html }, '*')
  }, [ready, frame.html])

  useEffect(() => {
    const el = surface.current!
    let entered = false
    function onFullscreenChange() {
      const active = document.fullscreenElement === el
      setFullscreen(active)
      /* The browser consumes Escape in native fullscreen. Its exit event
         must close the presentation too, so one Escape always returns. */
      if (entered && !active && !leavingFullscreen.current) presentFrame(null)
      leavingFullscreen.current = false
      entered = active
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => {})
    }
  }, [presentFrame])

  return (
    <div
      ref={surface}
      className="flex h-full w-full flex-col bg-ink text-white"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        if (event.key === '+' || event.key === '=') {
          event.preventDefault()
          zoomTo(scale * 1.25)
        }
        if (event.key === '-') {
          event.preventDefault()
          zoomTo(scale / 1.25)
        }
        if (event.key === '0') {
          event.preventDefault()
          chooseView('fit')
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-3 px-4 py-3">
        <ModalTitle className="min-w-0 flex-1 truncate font-sans text-sm sm:text-sm">{frame.name}</ModalTitle>
        {document.fullscreenEnabled && (
          <Button
            variant="inverse"
            size="sm"
            onClick={() => {
              /* Embedded browsers may deny native fullscreen; the window-
                   filling presentation remains usable without permission. */
              if (fullscreen) {
                leavingFullscreen.current = true
                void document.exitFullscreen().catch(() => {
                  leavingFullscreen.current = false
                })
              } else {
                void surface.current?.requestFullscreen().catch(() => {})
              }
            }}
          >
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </Button>
        )}
        <Button variant="inverse" size="sm" onClick={close} aria-label="Close presentation">
          <span aria-hidden="true">✕</span> Close <span className="font-mono text-xs opacity-60">Esc</span>
        </Button>
      </div>
      <div
        className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-y border-white/15 px-3 py-2"
        role="group"
        aria-label="Presentation viewing controls"
      >
        <Button
          variant="inverse"
          size="sm"
          aria-pressed={view.mode === 'fit'}
          className={view.mode === 'fit' ? 'bg-white/15' : ''}
          onClick={() => chooseView('fit')}
          title="Fit entire frame (0)"
        >
          Fit
        </Button>
        <Button
          variant="inverse"
          size="sm"
          aria-pressed={view.mode === 'width'}
          className={view.mode === 'width' ? 'bg-white/15' : ''}
          onClick={() => chooseView('width')}
        >
          Fit width
        </Button>
        <Button
          variant="inverse"
          size="sm"
          aria-pressed={view.mode === 'custom' && scale === 1}
          className={view.mode === 'custom' && scale === 1 ? 'bg-white/15' : ''}
          onClick={() => chooseView('custom')}
          title="Actual size"
        >
          100%
        </Button>
        <span className="mx-1 h-4 w-px bg-white/20" aria-hidden="true" />
        <Button
          variant="inverse"
          size="icon-sm"
          aria-label="Zoom out"
          title="Zoom out (-)"
          disabled={scale <= limits.min}
          onClick={() => zoomTo(scale / 1.25)}
        >
          −
        </Button>
        <output className="w-14 text-center font-mono text-xs" aria-label="Zoom level">
          {Math.round(scale * 100)}%
        </output>
        <Button
          variant="inverse"
          size="icon-sm"
          aria-label="Zoom in"
          title="Zoom in (+)"
          disabled={scale >= limits.max}
          onClick={() => zoomTo(scale * 1.25)}
        >
          +
        </Button>
        <span className="mx-1 h-4 w-px bg-white/20" aria-hidden="true" />
        <Button
          variant="inverse"
          size="sm"
          aria-pressed={pan}
          className={pan ? 'bg-white/15' : ''}
          onClick={() => setPan(true)}
        >
          Move view
        </Button>
        <Button
          variant="inverse"
          size="sm"
          aria-pressed={!pan}
          className={!pan ? 'bg-white/15' : ''}
          onClick={() => setPan(false)}
        >
          Interact
        </Button>
      </div>
      <div className="min-h-0 flex-1 px-3 pt-3">
        <div
          ref={stage}
          role="region"
          aria-label="Frame viewport"
          aria-describedby="presentation-view-help"
          tabIndex={0}
          className="h-full w-full overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          style={{
            scrollbarGutter: 'stable both-edges',
            touchAction: pan ? 'none' : 'auto',
            cursor: pan ? (dragging ? 'grabbing' : 'grab') : undefined,
          }}
          onPointerDown={(event) => {
            if (!pan || event.button !== 0 || !event.isPrimary) return
            const el = event.currentTarget
            const rect = el.getBoundingClientRect()
            const x = event.clientX - rect.left - el.clientLeft
            const y = event.clientY - rect.top - el.clientTop
            // Leave native scrollbar dragging to the browser.
            if (x < 0 || x >= el.clientWidth || y < 0 || y >= el.clientHeight) return
            el.focus()
            el.setPointerCapture(event.pointerId)
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: el.scrollLeft,
              top: el.scrollTop,
            }
            setDragging(true)
            event.preventDefault()
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (!start || start.id !== event.pointerId) return
            event.currentTarget.scrollTo(start.left + start.x - event.clientX, start.top + start.y - event.clientY)
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onLostPointerCapture={() => {
            drag.current = null
            setDragging(false)
          }}
        >
          <div
            className="grid min-h-full min-w-full place-items-center"
            style={{ width: frame.width * scale, height: frame.height * scale }}
          >
            <div className="relative shrink-0" style={{ width: frame.width * scale, height: frame.height * scale }}>
              <iframe
                ref={iframe}
                title={`Presentation: ${frame.name}`}
                sandbox="allow-scripts"
                srcDoc={FRAME_BOOTSTRAP}
                tabIndex={pan ? -1 : 0}
                className="absolute left-0 top-0 origin-top-left border-0 bg-white"
                style={{
                  width: frame.width,
                  height: frame.height,
                  transform: `scale(${scale})`,
                  pointerEvents: pan ? 'none' : 'auto',
                }}
              />
            </div>
          </div>
        </div>
      </div>
      <p id="presentation-view-help" className="shrink-0 px-3 py-2 text-center text-xs text-white/60">
        {pan
          ? 'Drag or scroll to move · Ctrl/⌘ + scroll to zoom · + / − to zoom · 0 to fit'
          : 'Use the page’s links and controls · Switch to Move view to pan and zoom'}
      </p>
    </div>
  )
}
