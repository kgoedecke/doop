import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { roleOf, toolAllowed, useStore, type Viewport } from '../lib/store'
import { roleAllows } from '../../shared/canvasRole'
import { onViewCommand } from '../lib/viewMenu'
import type { Frame } from '../../shared/types'
import { usePageCanvas, currentPageCanvas } from '../lib/pages'
import { sendWs } from '../lib/ws'
import { throttle } from '../lib/throttle'
import { FrameView, HiddenFrameView } from './FrameView'
import { CanvasComments, type CanvasComposeAt } from './CanvasComments'
import { placeComposer } from '../lib/composerPlacement'
import { isCanvasComment, type CanvasComment } from '../../shared/comments'
import { canvasPages } from '../../shared/pages'
import { FlowOverlay } from './FlowOverlay'
import { PrototypeOverlay } from './PrototypeOverlay'
import { GhostFrames } from './GhostFrames'
import { Cursors } from './Cursors'
import { FollowFrame } from './FollowFrame'
import { cameraOnCursor, cameraToFollow } from '../lib/follow'
import { SnapGuides } from './SnapGuides'
import { GuideLines, Rulers } from './Rulers'
import { useIsMobile } from '../hooks/use-mobile'
import { isTypingTarget, MOD_KEY } from '../lib/keys'
import { cn } from '../lib/utils'
import { gesture } from '../lib/gesture'
import { hasFrameClip, pasteFrameAtScreen } from '../lib/frameClipboard'
import { MenuHint } from './ui/menu'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu'
import { Toolbar, ToolbarButton, ToolbarHighlight } from './ui/toolbar'
import { ZoomControls } from './ZoomControls'
import { Tooltip } from './ui/tooltip'
import { BoxIcon, CircleIcon, CommentIcon, CursorIcon, FrameIcon, HandIcon, TextIcon, VectorIcon } from './ui/icons'
import { TOOLS, isDrawingTool, resolvePointerAction, toolForKey, type Tool } from '../lib/tools'
import { useCanvasDrawing } from './CanvasDrawing'
import { FrameLabelLayer } from './FrameLabelLayer'
import { layoutZoomFor } from '../lib/layoutZoom'

const MIN_ZOOM = 0.08
/* The settled world is laid out at up to this zoom too (layoutZoomFor), so
   the desktop app stays sharp all the way in. That costs little: WebKit and
   Chromium both tile what is on screen, so backing memory follows the
   viewport rather than the zoom, and frame documents never re-lay out (each
   iframe undoes the zoom). Mirrored by FOLLOW_MAX_ZOOM. */
const MAX_ZOOM = 16

/* The Comment tool's cursor wins over everything under the stage — frames
   included, like the Hand tool's grab — except inside the comment UI itself
   (pins, composer, threads: `data-comment-ui`), which keeps its own cursors. */
const COMMENT_CURSOR = 'cursor-comment! [&_:not([data-comment-ui]_*)]:cursor-comment!'

/* The world is laid out at CSS zoom k, the settled camera zoom, and its
   transform carries only what the camera has moved since. WebKit rasterizes a
   composited layer at its CSS size and stretches it under a scale transform,
   so a world scaled by its transform alone went soft in the desktop app past
   100%. The element's own zoom also scales its translate, hence the /k. */
function worldTransform(vp: Viewport, k: number): string {
  return `translate(${vp.x / k}px, ${vp.y / k}px) scale(${vp.zoom / k})`
}

/* The pixel grid, as Figma draws it zoomed in: a hairline on every design-px
   boundary. Below PIXEL_GRID_FROM the cells are too small to read as anything
   but a tint, so it fades in from there and is fully on at PIXEL_GRID_FULL. */
const PIXEL_GRID_FROM = 3
const PIXEL_GRID_FULL = 5

function pixelGridOpacity(zoom: number): number {
  return Math.min(1, Math.max(0, (zoom - PIXEL_GRID_FROM) / (PIXEL_GRID_FULL - PIXEL_GRID_FROM)))
}

/** The canvas-pinned root comment a ?comment= link names, if it is loaded. */
function linkedCanvasComment(id: string | null): CanvasComment | null {
  if (!id) return null
  const c = useStore.getState().comments.find((x) => x.id === id)
  return c && isCanvasComment(c) && !c.parentId ? c : null
}

/* zoom to an absolute level pivoting on the view center — the world point in
   the middle of the stage stays in the middle */
function zoomCentered(el: HTMLElement, next: number) {
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

const TOOL_ICONS: Record<Tool, React.ReactNode> = {
  select: <CursorIcon />,
  hand: <HandIcon />,
  comment: <CommentIcon />,
  rectangle: <BoxIcon />,
  circle: <CircleIcon />,
  path: <VectorIcon />,
  text: <TextIcon />,
  frame: <FrameIcon />,
}

const sendCursor = throttle((x: number, y: number) => sendWs({ type: 'cursor', x, y }), 50)
/* the camera is shared so others can follow it — same cadence as the cursor */
const sendViewport = throttle(
  (vp: { x: number; y: number; zoom: number }, el: HTMLElement) =>
    sendWs({
      type: 'viewport',
      viewport: {
        ...vp,
        pageId: useStore.getState().activePageId ?? undefined,
        width: el.clientWidth,
        height: el.clientHeight,
      },
    }),
  50,
)

export function Stage({
  onAddFrame,
  rightInset,
}: {
  onAddFrame: () => void
  /** px the floating panels and islands cover at the stage's right edge —
   *  no room there for a comment composer */
  rightInset: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drawing = useCanvasDrawing(ref)
  const worldRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const pixelGridRef = useRef<HTMLDivElement>(null)
  const [labelLayer, setLabelLayer] = useState<HTMLDivElement | null>(null)
  const zoomLabelRef = useRef<HTMLSpanElement>(null)
  const setViewport = useStore((s) => s.setViewport)
  const canvas = usePageCanvas()
  const activePageId = useStore((s) => s.activePageId)
  const select = useStore((s) => s.select)
  const panMode = useStore((s) => s.panMode)
  /* ⌘. — the tool pill and the zoom pill go with the rest of the chrome */
  const uiHidden = useStore((s) => s.uiHidden)
  /* ⇧R — phones have no room for rulers (nor a keyboard to ask for them) */
  const isMobile = useIsMobile()
  const showRulers = useStore((s) => s.rulers) && !uiHidden && !isMobile
  const tool = useStore((s) => s.tool)
  /* view links get Select and Hand, comment links add the Comment tool */
  const role = useStore(roleOf)
  const readOnly = !roleAllows(role, 'edit')
  const setTool = useStore((s) => s.setTool)
  const [panning, setPanning] = useState(false)
  /* the selection rectangle being dragged out, in world coordinates */
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  /* where the Comment tool was clicked on empty canvas: the composer opens there */
  const [composeAt, setComposeAt] = useState<CanvasComposeAt | null>(null)
  const dismissCompose = useCallback(() => setComposeAt(null), [])
  /* where the background menu opened, so Paste drops the frame there */
  const bgAt = useRef({ x: 0, y: 0 })
  /* the world's layout zoom (see worldTransform) — caught up with the camera
     only once the zoom settles, and never below 1, where scaling down a 1×
     raster stays sharp and nothing needs a relayout; the ref serves the
     per-frame viewport writes */
  const [layoutZoom, setLayoutZoom] = useState(1)
  const layoutZoomRef = useRef(1)
  const fitted = useRef(false)
  const deepLinkHandled = useRef(false)
  const focusedPage = useRef<string | null>(null)
  const [linkSearch, setLinkSearch] = useState(location.search)

  useEffect(() => {
    function onPop() {
      fitted.current = false
      deepLinkHandled.current = false
      focusedPage.current = null
      setLinkSearch(location.search)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /* Viewport → DOM without React: no component subscribes to the viewport, so
     pan/zoom never renders anything. A store subscription writes the world
     transform, the grid layer, the --zoom variable (which counter-scales
     labels/pins/cursors from CSS), and the zoom pill's % directly. */
  useLayoutEffect(() => {
    function apply(vp: { x: number; y: number; zoom: number }) {
      const world = worldRef.current
      const grid = gridRef.current
      const stage = ref.current
      if (!world || !grid || !stage) return
      world.style.transform = worldTransform(vp, layoutZoomRef.current)
      stage.style.setProperty('--zoom', String(vp.zoom))
      /* the camera's offset, for chrome drawn in screen px (FrameLabelLayer) */
      stage.style.setProperty('--vx', `${vp.x}px`)
      stage.style.setProperty('--vy', `${vp.y}px`)
      const period = 26 * vp.zoom
      grid.style.backgroundSize = `${period}px ${period}px`
      /* one period of overhang: the layer slides back by up to a period */
      grid.style.width = grid.style.height = `calc(100% + ${period}px)`
      const gx = (((vp.x % period) + period) % period) - period
      const gy = (((vp.y % period) + period) % period) - period
      grid.style.transform = `translate(${gx}px, ${gy}px)`
      const pixels = pixelGridRef.current
      if (pixels) {
        const opacity = pixelGridOpacity(vp.zoom)
        pixels.hidden = opacity === 0
        pixels.style.opacity = String(opacity)
        pixels.style.backgroundSize = `${vp.zoom}px ${vp.zoom}px`
        const px = (((vp.x % vp.zoom) + vp.zoom) % vp.zoom) - vp.zoom
        const py = (((vp.y % vp.zoom) + vp.zoom) % vp.zoom) - vp.zoom
        pixels.style.transform = `translate(${px}px, ${py}px)`
      }
      if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(vp.zoom * 100)}%`
    }
    apply(useStore.getState().viewport)
    let settle = 0
    const unsub = useStore.subscribe((s, prev) => {
      /* a (re)connect needs the camera announced afresh — the server only
         knows what this socket has sent */
      if (s.connected && !prev.connected && ref.current) sendViewport(s.viewport, ref.current)
      if (s.viewport === prev.viewport) return
      apply(s.viewport)
      if (ref.current) sendViewport(s.viewport, ref.current)
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        setLayoutZoom(layoutZoomFor(useStore.getState().viewport.zoom, MAX_ZOOM))
      }, 250)
    })
    return () => {
      unsub()
      window.clearTimeout(settle)
    }
  }, [])

  /* a new layout zoom lands in the same commit as the frames' counter-zoom
     (FrameView), so no paint sees one without the other */
  useLayoutEffect(() => {
    layoutZoomRef.current = layoutZoom
    const world = worldRef.current
    if (!world) return
    /* a new zoom recomputes every length inside the world: anything with a
       transition (a peer's cursor glides between positions) would animate
       from its old-zoom value while the world itself snaps, so it jumped
       off its spot and slid back. Transitions are off for this one change. */
    world.dataset.rezoom = ''
    world.style.zoom = String(layoutZoom)
    world.style.transform = worldTransform(useStore.getState().viewport, layoutZoom)
    void world.offsetWidth
    delete world.dataset.rezoom
  }, [layoutZoom])

  /* following a peer: whenever their camera (or, lacking one, their cursor)
     moves, ease ours toward the same view. Writes go through
     setViewportFollowing so they don't count as "our own move" and end the
     follow — everything else that touches the camera does. */
  useEffect(() => {
    let raf = 0
    let target: { x: number; y: number; zoom: number } | null = null
    function step() {
      raf = 0
      const s = useStore.getState()
      if (!target || !s.following) return
      const vp = s.viewport
      const k = 0.35
      const next = {
        x: vp.x + (target.x - vp.x) * k,
        y: vp.y + (target.y - vp.y) * k,
        zoom: vp.zoom + (target.zoom - vp.zoom) * k,
      }
      const done =
        Math.abs(next.x - target.x) < 0.5 &&
        Math.abs(next.y - target.y) < 0.5 &&
        Math.abs(next.zoom - target.zoom) < 0.001
      s.setViewportFollowing(done ? target : next)
      if (!done) raf = requestAnimationFrame(step)
    }
    function retarget() {
      const el = ref.current
      const s = useStore.getState()
      if (!el || !s.following) return
      const leader = s.presences[s.following]
      const cursor = s.cursors[s.following]
      const stage = { width: el.clientWidth, height: el.clientHeight }
      if (leader?.viewport?.pageId && leader.viewport.pageId !== s.activePageId) {
        s.setActivePage(leader.viewport.pageId)
        useStore.setState({ following: s.following })
      }
      if (leader?.viewport) target = cameraToFollow(leader.viewport, stage)
      else if (cursor) target = cameraOnCursor(cursor, stage, s.viewport.zoom)
      else return
      if (!raf) raf = requestAnimationFrame(step)
    }
    const unsub = useStore.subscribe((s, prev) => {
      if (!s.following) {
        target = null
        return
      }
      const started = s.following !== prev.following
      const moved =
        s.presences[s.following] !== prev.presences[s.following] || s.cursors[s.following] !== prev.cursors[s.following]
      if (started || moved) retarget()
    })
    /* the stage growing or shrinking changes what we can see: followers of
       ours need the new size, and if we are following, the leader's view
       has to be refitted to it */
    const el = ref.current
    const ro = new ResizeObserver(() => {
      if (!el) return
      sendViewport(useStore.getState().viewport, el)
      retarget()
    })
    if (el) ro.observe(el)
    return () => {
      unsub()
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  /** where a fly-to lands: a frame fitted with padding, or a bare world
   *  point centred at the zoom we already have (a peer's cursor) */
  function flyTargetFor(
    req: NonNullable<typeof flyTo>,
    el: HTMLDivElement,
    from: { x: number; y: number; zoom: number },
  ): { x: number; y: number; zoom: number } | undefined {
    if ('point' in req) {
      return {
        x: el.clientWidth / 2 - req.point.x * from.zoom,
        y: el.clientHeight / 2 - req.point.y * from.zoom,
        zoom: from.zoom,
      }
    }
    const f = currentPageCanvas()?.frames.find((x) => x.id === req.frameId)
    if (!f) return undefined
    const pad = 80
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((el.clientWidth - pad * 2) / f.width, (el.clientHeight - pad * 2) / f.height, 1)),
    )
    return {
      x: (el.clientWidth - f.width * zoom) / 2 - f.x * zoom,
      y: (el.clientHeight - f.height * zoom) / 2 - f.y * zoom,
      zoom,
    }
  }

  /* a fly-to request (prompt bar): glide the camera to the frame instead of
     snapping, so the new design streams in on-screen with a bit of drama.
     The request object stays in the store; only a NEW request re-runs this. */
  const flyTo = useStore((s) => s.flyTo)
  useEffect(() => {
    if (!flyTo) return
    const el = ref.current
    if (!el) return
    const from = useStore.getState().viewport
    const target = flyTargetFor(flyTo, el, from)
    if (!target) return
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
    (f: Frame, selector: string | null) => {
      const el = ref.current
      if (!el) return
      select(f.id)
      focusedPage.current = useStore.getState().activePageId
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
      const s = useStore.getState()
      s.pickElement(null)
      if (selector) {
        /* FrameView resolves this in the ready iframe: scripts can add or
           remove elements that differ from the saved HTML. */
        s.setTool('select')
        s.setInspectorOpen(false)
        s.pickElement({ frameId: f.id, selector })
      } else {
        s.setInspectorOpen(true)
      }
    },
    [setViewport, select],
  )

  /* centre a canvas comment's pin at 100% on its page and open its thread
     (the link in a comment email) */
  const focusPoint = useCallback(
    (c: CanvasComment) => {
      const el = ref.current
      if (!el) return
      const s = useStore.getState()
      focusedPage.current = c.pageId
      s.setActivePage(c.pageId)
      setViewport({ x: el.clientWidth / 2 - c.x, y: el.clientHeight / 2 - c.y, zoom: 1 })
      s.requestOpenThread(c.id)
    },
    [setViewport],
  )

  /* fit a set of frames (with their name labels above) into the view; an
     empty set resets to the origin at 100% */
  const fitFrames = useCallback(
    (frames: { x: number; y: number; width: number; height: number }[]) => {
      const el = ref.current
      if (!el) return
      const boxes = frames.map((f) => ({ x: f.x, y: f.y - 30, w: f.width, h: f.height + 30 }))
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
    },
    [setViewport],
  )

  const fit = useCallback(() => {
    const c = currentPageCanvas()
    if (c) fitFrames(c.frames)
  }, [fitFrames])

  /* zoom to the selected frames — with nothing selected there is nothing to
     fit, so the view stays put */
  const fitSelection = useCallback(() => {
    const { selectedIds } = useStore.getState()
    const frames = currentPageCanvas()?.frames.filter((f) => selectedIds.includes(f.id)) ?? []
    if (frames.length) fitFrames(frames)
  }, [fitFrames])

  useEffect(() => {
    fitted.current = focusedPage.current === activePageId
    focusedPage.current = null
  }, [activePageId])

  /* zoom-to-fit once the canvas arrives — unless the URL deep-links a frame,
     a comment pinned to the canvas, or a page */
  useEffect(() => {
    if (!canvas || fitted.current) return
    fitted.current = true
    if (useStore.getState().following) return
    const params = deepLinkHandled.current ? null : new URLSearchParams(linkSearch)
    const focusId = params?.get('frame')
    const target = focusId ? useStore.getState().canvas?.frames.find((f) => f.id === focusId) : null
    if (target) {
      deepLinkHandled.current = true
      focusFrame(target, params?.get('selector') ?? null)
      return
    }
    const pinned = params ? linkedCanvasComment(params.get('comment')) : null
    if (pinned) {
      deepLinkHandled.current = true
      focusPoint(pinned)
      return
    }
    const page = params?.get('page')
    const whole = useStore.getState().canvas
    if (page && whole && page !== activePageId && canvasPages(whole).some((p) => p.id === page)) {
      /* the page switch re-runs this effect, which then fits that page */
      deepLinkHandled.current = true
      useStore.getState().setActivePage(page)
      return
    }
    fit()
  }, [canvas, activePageId, fit, focusFrame, focusPoint, linkSearch])

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
      /* let overlays with their own scrollbar scroll instead of panning */
      if ((e.target as Element | null)?.closest('[data-stage-scroll]')) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = el!.getBoundingClientRect()
        pivotX = e.clientX - rect.left
        pivotY = e.clientY - rect.top
        zoomDelta += Math.max(-40, Math.min(40, e.deltaY))
      } else if (e.shiftKey && e.deltaX === 0) {
        panX += e.deltaY
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
      if (!a || !b) return null
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
      if (!cur) return
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
     preventDefault keeps the browser's own page zoom out of it. ⇧1 / ⇧2 fit
     everything / the selection and ⇧R shows or hides the rulers, as in Figma. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key.toLowerCase() === 'r') {
          e.preventDefault()
          if (!e.repeat) useStore.getState().toggleRulers()
          return
        }
        /* by code: ⇧1 types '!' on most layouts, so the key name is no use */
        if (e.code !== 'Digit1' && e.code !== 'Digit2') return
        e.preventDefault()
        if (e.code === 'Digit1') fit()
        else fitSelection()
        return
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.key !== '0' && e.key !== '=' && e.key !== '+' && e.key !== '-') return
      /* '+' arrives as ⇧= on most layouts; any other shifted combo isn't ours */
      if (e.shiftKey && e.key !== '+') return
      const el = ref.current
      if (!el) return
      e.preventDefault()
      const zoom = useStore.getState().viewport.zoom
      if (e.key === '0') zoomCentered(el, 1)
      else if (e.key === '-') zoomCentered(el, zoom / 1.25)
      else zoomCentered(el, zoom * 1.25)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fit, fitSelection])

  /* the same zooms from the desktop shell's View menu */
  useEffect(
    () =>
      onViewCommand((command) => {
        const el = ref.current
        if (!el) return
        const zoom = useStore.getState().viewport.zoom
        if (command === 'zoom-in') zoomCentered(el, zoom * 1.25)
        else if (command === 'zoom-out') zoomCentered(el, zoom / 1.25)
        else if (command === 'zoom-reset') zoomCentered(el, 1)
        else if (command === 'zoom-fit') fit()
        else if (command === 'zoom-selection') fitSelection()
      }),
    [fit, fitSelection],
  )

  function toWorld(clientX: number, clientY: number) {
    const rect = ref.current!.getBoundingClientRect()
    const vp = useStore.getState().viewport
    return {
      x: (clientX - rect.left - vp.x) / vp.zoom,
      y: (clientY - rect.top - vp.y) / vp.zoom,
    }
  }

  /* space bar → pan mode: the stage drags the viewport instead of drawing a
     marquee, and frames let the press fall through to it. Held-space repeats
     must not re-trigger, and typing in a field is never a pan. */
  useEffect(() => {
    function isTyping(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    }
    function onDown(e: KeyboardEvent) {
      if (e.key !== ' ' || isTyping(e)) return
      e.preventDefault()
      if (!useStore.getState().panMode) useStore.getState().setPanMode(true)
    }
    function onUp(e: KeyboardEvent) {
      if (e.key === ' ') useStore.getState().setPanMode(false)
    }
    const reset = () => useStore.getState().setPanMode(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', reset)
      reset()
    }
  }, [])

  /* Bare shortcut keys pick a tool, Esc returns to Select — bare keys
     only (no modifiers), and never while typing in a field. Esc is the one
     exception for canvas composers: it drops their draft and returns to Select.
     Other fields keep Escape for their own editing behavior. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return
      if (e.key === 'Escape') {
        if (isTypingTarget(e.target) && !e.target.closest('[data-comment-ui], [data-drawing-input]')) return
        if (useStore.getState().tool !== 'select') useStore.getState().setTool('select')
        return
      }
      if (isTypingTarget(e.target)) return
      const next = toolForKey(e.key)
      if (!next) return
      e.preventDefault()
      useStore.getState().setTool(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function onPointerDown(e: React.PointerEvent) {
    const target = e.target as HTMLElement
    /* a locked frame lets the press through (FrameView.startDrag), and the
       stage treats it as empty canvas: a click clears, a drag marquees */
    const isBackground =
      e.target === e.currentTarget || target.classList.contains('world') || !!target.closest('[data-frame-locked]')
    const s = useStore.getState()
    const action = resolvePointerAction({
      tool: s.tool,
      target: isBackground ? 'background' : 'frame',
      button: e.button,
      pointerType: e.pointerType,
      spaceHeld: s.panMode,
    })
    /* a press on a frame only reaches the stage when the frame let it through
       (Hand, space held) — anything but a pan on it is the frame's own business */
    if (action === 'pan') return startPan(e, isBackground)
    if (action === 'marquee') startMarquee(e)
    if (action === 'comment-canvas') {
      /* a finger that moves is a pan, a finger that lifts in place is a
         comment: the pan follows the movement, the comment checks the
         distance on release and only opens when there was none */
      if (e.pointerType === 'touch') startPan(e, isBackground)
      startCanvasComment(e)
    }
  }

  /* the Comment tool on empty canvas: a click (not a drag) opens the composer
     at that point; the pin lands there when the comment is posted. Any
     composer already open was closed by the press (CanvasComments). */
  function startCanvasComment(e: React.PointerEvent) {
    const origin = { x: e.clientX, y: e.clientY }
    const point = toWorld(e.clientX, e.clientY)
    /* the composer hangs beside the pin on whichever side keeps it on the
       visible stage (the side panel overlays the stage's right edge) */
    const rect = e.currentTarget.getBoundingClientRect()
    const placement = placeComposer(e.clientX, rect.left, rect.right - rightInset)
    function onUp(ev: PointerEvent) {
      window.removeEventListener('pointerup', onUp)
      if (Math.abs(ev.clientX - origin.x) + Math.abs(ev.clientY - origin.y) > 3) return
      select(null)
      setComposeAt({ x: point.x, y: point.y, placement, at: Date.now() })
    }
    window.addEventListener('pointerup', onUp)
  }

  function startPan(e: React.PointerEvent, isBackground: boolean) {
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
      if (!moved && isBackground) select(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function startMarquee(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    const origin = toWorld(e.clientX, e.clientY)
    /* ⇧-marquee adds to what is already selected */
    const keep = e.shiftKey ? useStore.getState().selectedIds : []
    let moved = false

    function onMove(ev: PointerEvent) {
      const cur = toWorld(ev.clientX, ev.clientY)
      const zoom = useStore.getState().viewport.zoom
      if (Math.abs(cur.x - origin.x) * zoom + Math.abs(cur.y - origin.y) * zoom > 3) moved = true
      if (!moved) return
      const rect = {
        x: Math.min(origin.x, cur.x),
        y: Math.min(origin.y, cur.y),
        width: Math.abs(cur.x - origin.x),
        height: Math.abs(cur.y - origin.y),
      }
      setMarquee(rect)
      const frames = currentPageCanvas()?.frames ?? []
      /* a hidden frame is not on the stage to be lassoed, and a locked one is
         not the marquee's to take */
      const hits = frames
        .filter(
          (f) =>
            !f.hidden &&
            !f.locked &&
            f.x < rect.x + rect.width &&
            f.x + f.width > rect.x &&
            f.y < rect.y + rect.height &&
            f.y + f.height > rect.y,
        )
        .map((f) => f.id)
      useStore.getState().selectMany([...keep, ...hits.filter((id) => !keep.includes(id))])
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setMarquee(null)
      /* a plain click on empty canvas clears the selection */
      if (!moved && !e.shiftKey) select(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function onPointerMove(e: React.PointerEvent) {
    drawing.onPointerMove(e)
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
            className={cn(
              'stage absolute inset-0 touch-none',
              panning
                ? 'cursor-grabbing! [&_*]:cursor-grabbing!'
                : panMode || tool === 'hand'
                  ? 'cursor-grab! [&_*]:cursor-grab!'
                  : tool === 'comment'
                    ? COMMENT_CURSOR
                    : isDrawingTool(tool)
                      ? tool === 'text'
                        ? 'cursor-text! [&_:not([data-comment-ui]_*)]:cursor-text!'
                        : 'cursor-crosshair! [&_:not([data-comment-ui]_*)]:cursor-crosshair!'
                      : 'cursor-default',
            )}
            onPointerDownCapture={drawing.onPointerDown}
            onDoubleClickCapture={drawing.onDoubleClick}
            onTouchStartCapture={drawing.onTouchStart}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onContextMenu={(e) => {
              /* frames stop the event on their own trigger, so anything arriving
                 here is the empty canvas — except a right-click on a frame's
                 chrome overlay, which is not a menu target at all */
              const isBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('world')
              /* Paste and New frame are both edits */
              if (!isBackground || readOnly) return e.preventDefault()
              /* Paste drops the frame where the click landed. The menu's own
                 box is not that point: Radix positions it after mount, and
                 flips it away from a viewport edge. */
              bgAt.current = { x: e.clientX, y: e.clientY }
            }}
          >
            {/* dot grid on its own composited layer: panning is transform-only
            (zero paint), zooming repaints just this layer's tiny tile */}
            <div
              className="pointer-events-none absolute left-0 top-0 origin-top-left will-change-transform [background-image:radial-gradient(circle,var(--dot)_1.2px,transparent_1.2px)]"
              ref={gridRef}
            />
            {/* frame names, in screen px (FrameLabelLayer): under the world,
                so a frame dragged over another's name covers it as before */}
            <div className="pointer-events-none absolute inset-0" ref={setLabelLayer} />
            {/* `world` is likewise a behaviour hook: pan hit-testing checks
            classList.contains('world') to tell background from frame */}
            <div
              className="world absolute left-0 top-0 origin-top-left will-change-transform data-rezoom:**:transition-none!"
              ref={worldRef}
            >
              <FrameLabelLayer.Provider value={labelLayer}>
                {canvas?.frames.map((f) =>
                  f.hidden ? (
                    <HiddenFrameView key={f.id} frame={f} />
                  ) : (
                    <FrameView key={f.id} frame={f} layoutZoom={layoutZoom} />
                  ),
                )}
              </FrameLabelLayer.Provider>
              <GhostFrames />
              <FlowOverlay />
              <GuideLines stage={ref} />
              <PrototypeOverlay />
              <SnapGuides />
              <CanvasComments composeAt={composeAt} onComposeDone={dismissCompose} />
              <Cursors />
              {drawing.preview}
              {marquee && (
                <div
                  className="pointer-events-none absolute bg-brand/10 [box-shadow:inset_0_0_0_calc(1px/var(--zoom,1))_var(--brand)]"
                  style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
                />
              )}
            </div>
            {/* the pixel grid lies over the frames, not under them, so it lines
                up their content; it never takes the pointer */}
            <div
              hidden
              className="pointer-events-none absolute left-0 top-0 h-[calc(100%+16px)] w-[calc(100%+16px)] origin-top-left will-change-transform [--pixel-line:rgb(128_128_128/0.16)] [background-image:linear-gradient(to_right,var(--pixel-line)_1px,transparent_1px),linear-gradient(to_bottom,var(--pixel-line)_1px,transparent_1px)]"
              ref={pixelGridRef}
            />
            {showRulers && <Rulers stage={ref} />}
          </div>
        </ContextMenuTrigger>
        <FollowFrame />

        {/* the tool rail: a vertical island beside the Layers panel on desktop
            (the page sets --rail-left and --chrome-top), a centred strip at
            the bottom on phones */}
        <div
          className={cn(
            'absolute bottom-[calc(8px+env(safe-area-inset-bottom))] left-1/2 z-[35] -translate-x-1/2 sm:bottom-4',
            'md:top-[calc(var(--chrome-top,0px)+10px)] md:bottom-auto md:left-[var(--rail-left,14px)] md:translate-x-0 md:transition-[left] md:duration-150',
            uiHidden && 'hidden',
          )}
        >
          {isDrawingTool(tool) && (
            <div
              data-drawing-hint
              className="absolute bottom-full left-1/2 mb-2 flex w-max max-w-[min(340px,90vw)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-[10px] bg-surface px-3 py-2 text-center text-[12px] text-ink-soft shadow-pop md:top-0 md:bottom-auto md:left-full md:mb-0 md:ml-2.5 md:translate-x-0 md:justify-start md:text-left"
            >
              <span>
                {tool === 'path'
                  ? 'Click for corners · Drag for curves · Snap to points · Enter to finish'
                  : tool === 'text'
                    ? `Click or drag, then type · ${MOD_KEY}Enter to save`
                    : tool === 'circle'
                      ? 'Drag to draw a circle · Esc to cancel'
                      : 'Drag to draw · Shift for a square · Esc to cancel'}
              </span>
              {drawing.pathActive && (
                <>
                  <button
                    type="button"
                    className="font-semibold text-brand disabled:opacity-40"
                    disabled={!drawing.canFinishPath}
                    onClick={drawing.finish}
                  >
                    Finish path
                  </button>
                  <button type="button" onClick={drawing.cancel}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}
          <Toolbar aria-label="Canvas tools" className="md:w-10 md:flex-col">
            {/* one fill slides between tools; the buttons themselves stay
                transparent so the pill is the only thing that moves */}
            <ToolbarHighlight activeKey={tool} />
            {TOOLS.filter((t) => toolAllowed(t.id, role)).map((t) => (
              <Tooltip key={t.id} label={`${t.label} (${t.key})`} side="right">
                <ToolbarButton
                  aria-label={t.label}
                  aria-pressed={tool === t.id}
                  className="relative z-[1] hover:bg-transparent aria-pressed:text-ink"
                  onClick={() => setTool(t.id)}
                >
                  {TOOL_ICONS[t.id]}
                </ToolbarButton>
              </Tooltip>
            ))}
          </Toolbar>
        </div>

        <ZoomControls
          labelRef={zoomLabelRef}
          hidden={uiHidden}
          onZoomIn={() => ref.current && zoomCentered(ref.current, useStore.getState().viewport.zoom * 1.25)}
          onZoomOut={() => ref.current && zoomCentered(ref.current, useStore.getState().viewport.zoom / 1.25)}
          onZoomTo={(zoom) => ref.current && zoomCentered(ref.current, zoom)}
          onFit={fit}
          onFitSelection={fitSelection}
        />

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
}
