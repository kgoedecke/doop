import { memo, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { create } from 'zustand'
import type { CanvasGuide } from '../../shared/types'
import { currentPageCanvas } from '../lib/pages'
import { commitGuide, newGuide, visibleGuides } from '../lib/guides'
import { isTypingTarget } from '../lib/keys'
import { boundsOf, formatRulerValue, rulerTicks } from '../lib/rulers'
import { snapFrame } from '../lib/snap'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { useIsMobile } from '../hooks/use-mobile'
import { cn } from '../lib/utils'

/* The rulers' thickness, in screen px. */
export const RULER_PX = 20
/* tick lengths along the ruler's inner edge */
const MAJOR_TICK_PX = 7
const MINOR_TICK_PX = 3
/* a guide line's grabbable band, in screen px either side of the line */
const GUIDE_GRAB_PX = 3
/* a guide spans this far either side of the world origin: past any canvas */
const GUIDE_REACH = 1_000_000
/* a press that travels less than this is a click on the guide, not a drag */
const DRAG_THRESHOLD_PX = 3

type Axis = CanvasGuide['axis']

/** The guide being dragged, for the position badge beside the pointer. */
const useGuideDrag = create<{
  drag: { axis: Axis; value: number; x: number; y: number; removing: boolean } | null
}>(() => ({ drag: null }))

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Where the rulers count from: the selected frames' top-left, as in Figma,
 *  else the world origin. Their extent is highlighted on both rulers. */
function rulerSelection(): Box | null {
  const { selectedIds } = useStore.getState()
  if (!selectedIds.length) return null
  return boundsOf(currentPageCanvas()?.frames.filter((f) => selectedIds.includes(f.id)) ?? [])
}

/** The ruler (or a guide) a pointer position belongs to: a guide dropped
 *  back onto its own ruler is removed. */
function overRuler(axis: Axis, clientX: number, clientY: number): boolean {
  const ruler = document.querySelector(`[data-ruler="${axis === 'h' ? 'top' : 'left'}"]`)
  if (!ruler) return false
  const box = ruler.getBoundingClientRect()
  return axis === 'h' ? clientY <= box.bottom : clientX <= box.right
}

/** Drag a guide: a new one out of a ruler (`before` null), or an existing
 *  one across the canvas. It lands as one undo step; dropped on its ruler it
 *  is gone. Alt places it freely, otherwise it snaps to frame edges. */
function dragGuide(e: ReactPointerEvent<HTMLElement>, stage: HTMLElement, axis: Axis, before: CanvasGuide | null) {
  const { canvas, activePageId } = useStore.getState()
  if (canvas && activePageId && e.button === 0) trackGuide(e, stage, axis, before, canvas.id, activePageId)
}

function trackGuide(
  e: ReactPointerEvent<HTMLElement>,
  stage: HTMLElement,
  axis: Axis,
  before: CanvasGuide | null,
  canvasId: string,
  pageId: string,
) {
  e.preventDefault()
  e.stopPropagation()
  const el = e.currentTarget
  const pointerId = e.pointerId
  el.setPointerCapture(pointerId)
  const id = before?.id ?? newGuide(pageId, axis, 0).id
  const start = { x: e.clientX, y: e.clientY }
  let current: CanvasGuide | null = before
  let moved = false

  function place(ev: PointerEvent) {
    const box = stage.getBoundingClientRect()
    const vp = useStore.getState().viewport
    const world = { x: (ev.clientX - box.left - vp.x) / vp.zoom, y: (ev.clientY - box.top - vp.y) / vp.zoom }
    let at = axis === 'v' ? world.x : world.y
    if (!ev.altKey) {
      const frames = currentPageCanvas()?.frames.filter((f) => !f.hidden) ?? []
      const snapped = snapFrame('move', { x: world.x, y: world.y, width: 0, height: 0 }, frames, vp.zoom)
      at = axis === 'v' ? snapped.x : snapped.y
    }
    current = { id, pageId, axis, at: Math.round(at) }
    useStore.getState().setGuideLocal(id, current)
    const origin = rulerSelection()
    useGuideDrag.setState({
      drag: {
        axis,
        value: current.at - (origin ? (axis === 'v' ? origin.x : origin.y) : 0),
        x: ev.clientX - box.left,
        y: ev.clientY - box.top,
        removing: overRuler(axis, ev.clientX, ev.clientY),
      },
    })
  }
  function onMove(ev: PointerEvent) {
    if (ev.pointerId !== pointerId) return
    if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD_PX) return
    moved = true
    place(ev)
  }
  function finish() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
    useGuideDrag.setState({ drag: null })
  }
  function onUp(ev: PointerEvent) {
    if (ev.pointerId !== pointerId) return
    finish()
    if (!moved) {
      /* a click on a guide selects it, for Delete */
      if (before) {
        useStore.getState().select(null)
        useStore.getState().selectGuide(before.id)
      }
      return
    }
    if (useStore.getState().canvas?.id !== canvasId) return
    const removed = overRuler(axis, ev.clientX, ev.clientY)
    if (removed && !before) useStore.getState().setGuideLocal(id, null)
    else void commitGuide(canvasId, before, removed ? null : current)
  }
  /* Esc, or the pointer taken away: the guide goes back where it was */
  function revert() {
    finish()
    if (useStore.getState().canvas?.id === canvasId) useStore.getState().setGuideLocal(id, before)
  }
  function onCancel(ev: PointerEvent) {
    if (ev.pointerId === pointerId) revert()
  }
  function onKey(ev: KeyboardEvent) {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    revert()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
}

/** Only the Select tool grabs guides, and only for someone who can edit the
 *  canvas; every other tool, a held space bar or a read-only link lets the
 *  press through to the stage. */
function grabsGuides(): boolean {
  const s = useStore.getState()
  return s.tool === 'select' && !s.panMode && canEditOpenCanvas(s)
}

interface Palette {
  surface: string
  line: string
  tick: string
  label: string
  brand: string
  font: string
}

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el)
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    surface: token('--surface', '#fff'),
    line: token('--line', '#dcdcdc'),
    tick: token('--ink-faint', '#9c9b99'),
    label: token('--ink-soft', '#5f5e5b'),
    brand: token('--brand', '#0177d3'),
    font: token('--font-mono', 'ui-monospace, monospace'),
  }
}

interface RulerView {
  /** world coordinate at the ruler's first css px */
  worldStart: number
  zoom: number
  /** world coordinate the labels count from */
  origin: number
  /** the selection's extent along this ruler, world px */
  selection: [number, number] | null
}

/** Paint one ruler in device pixels, so every tick is one crisp device px
 *  wide at any devicePixelRatio. Labels go right of their tick on the top
 *  ruler, and read bottom-to-top above it on the left one. */
function paintRuler(canvas: HTMLCanvasElement, side: 'top' | 'left', view: RulerView, palette: Palette) {
  const dpr = window.devicePixelRatio || 1
  const cssLength = side === 'top' ? canvas.clientWidth : canvas.clientHeight
  const width = Math.round(canvas.clientWidth * dpr)
  const height = Math.round(canvas.clientHeight * dpr)
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = palette.surface
  ctx.fillRect(0, 0, width, height)
  const thick = side === 'top' ? height : width
  const hair = Math.max(1, Math.round(dpr))
  /* a world position → device px along the ruler */
  const along = (world: number) => Math.round((world - view.worldStart) * view.zoom * dpr)
  const tick = (pos: number, length: number) => {
    const len = Math.round(length * dpr)
    if (side === 'top') ctx.fillRect(pos, thick - len, hair, len)
    else ctx.fillRect(thick - len, pos, len, hair)
  }
  const label = (pos: number, text: string, align: 'after' | 'before') => {
    const gap = Math.round(3 * dpr)
    ctx.save()
    if (side === 'top') {
      ctx.textAlign = align === 'after' ? 'left' : 'right'
      ctx.fillText(text, align === 'after' ? pos + gap : pos - gap, Math.round(2 * dpr))
    } else {
      ctx.translate(Math.round(2 * dpr), align === 'after' ? pos - gap : pos + gap)
      ctx.rotate(-Math.PI / 2)
      ctx.textAlign = align === 'after' ? 'left' : 'right'
      ctx.fillText(text, 0, 0)
    }
    ctx.restore()
  }

  const start = view.worldStart - view.origin
  const ticks = rulerTicks(start, start + cssLength / view.zoom, view.zoom)
  ctx.font = `${10 * dpr}px ${palette.font}`
  ctx.textBaseline = 'top'
  const selection = view.selection?.map((world) => along(world)) as [number, number] | undefined
  if (selection) {
    ctx.fillStyle = palette.brand
    ctx.globalAlpha = 0.12
    if (side === 'top') ctx.fillRect(selection[0], 0, selection[1] - selection[0], thick)
    else ctx.fillRect(0, selection[0], thick, selection[1] - selection[0])
    ctx.globalAlpha = 1
  }
  ctx.fillStyle = palette.tick
  for (const at of ticks.minor) tick(along(at + view.origin), MINOR_TICK_PX)
  for (const at of ticks.major) tick(along(at + view.origin), MAJOR_TICK_PX)
  /* the selection's own numbers win over the regular labels near them */
  const clearance = Math.round(44 * dpr)
  ctx.fillStyle = palette.label
  for (const at of ticks.major) {
    const pos = along(at + view.origin)
    if (selection && selection.some((edge) => Math.abs(edge - pos) < clearance)) continue
    label(pos, formatRulerValue(at), 'after')
  }
  if (selection && view.selection) {
    ctx.fillStyle = palette.brand
    tick(selection[0], thick / dpr)
    tick(selection[1], thick / dpr)
    label(selection[0], formatRulerValue(view.selection[0] - view.origin), 'before')
    label(selection[1], formatRulerValue(view.selection[1] - view.origin), 'after')
  }
  /* the hairline between the ruler and the canvas */
  ctx.fillStyle = palette.line
  if (side === 'top') ctx.fillRect(0, thick - hair, width, hair)
  else ctx.fillRect(thick - hair, 0, hair, height)
}

/** Rulers docked on the stage's top and left edges (⇧R), in world px, counting
 *  from the selection's top-left or else the world origin. Dragging out of
 *  one creates a guide. Drawn on `<canvas>` straight from store
 *  subscriptions, so pan and zoom never re-render React. */
export function Rulers({ stage }: { stage: RefObject<HTMLDivElement> }) {
  const top = useRef<HTMLCanvasElement>(null)
  const left = useRef<HTMLCanvasElement>(null)
  const drag = useGuideDrag((s) => s.drag)

  useEffect(() => {
    let raf = 0
    let palette: Palette | null = null
    function paint() {
      raf = 0
      const el = stage.current
      const topEl = top.current
      const leftEl = left.current
      if (!el || !topEl || !leftEl) return
      palette ??= readPalette(topEl)
      const s = useStore.getState()
      const vp = s.viewport
      const box = el.getBoundingClientRect()
      const selection = rulerSelection()
      const topBox = topEl.getBoundingClientRect()
      const leftBox = leftEl.getBoundingClientRect()
      paintRuler(
        topEl,
        'top',
        {
          worldStart: (topBox.left - box.left - vp.x) / vp.zoom,
          zoom: vp.zoom,
          origin: selection?.x ?? 0,
          selection: selection ? [selection.x, selection.x + selection.width] : null,
        },
        palette,
      )
      paintRuler(
        leftEl,
        'left',
        {
          worldStart: (leftBox.top - box.top - vp.y) / vp.zoom,
          zoom: vp.zoom,
          origin: selection?.y ?? 0,
          selection: selection ? [selection.y, selection.y + selection.height] : null,
        },
        palette,
      )
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint)
    }
    /* a theme switch changes every token the rulers are painted in */
    const repaint = () => {
      palette = null
      schedule()
    }
    paint()
    const unsub = useStore.subscribe((s, prev) => {
      if (
        s.viewport !== prev.viewport ||
        s.selectedIds !== prev.selectedIds ||
        s.canvas?.frames !== prev.canvas?.frames ||
        s.activePageId !== prev.activePageId
      )
        schedule()
    })
    const resize = new ResizeObserver(schedule)
    if (stage.current) resize.observe(stage.current)
    const theme = new MutationObserver(repaint)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    const dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dpr.addEventListener('change', schedule)
    void document.fonts?.ready.then(repaint)
    return () => {
      unsub()
      resize.disconnect()
      theme.disconnect()
      dpr.removeEventListener('change', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [stage])

  function onRulerDown(e: ReactPointerEvent<HTMLCanvasElement>, axis: Axis) {
    /* the drawing tools and the hand still have the press; the rulers are
       never a place to draw, so a ruler press always stops here */
    e.stopPropagation()
    if (!grabsGuides() || !stage.current) return
    dragGuide(e, stage.current, axis, null)
  }

  return (
    <>
      {/* docked on the stage's edges, above the top bar: the page moves the
          bar and its floating chrome RULER_PX in */}
      <div data-rulers="" className="pointer-events-none absolute inset-0 z-[28]">
        <canvas
          ref={top}
          data-ruler="top"
          aria-label="Horizontal ruler: drag down to add a guide"
          className="pointer-events-auto absolute top-0 block cursor-row-resize touch-none"
          /* a canvas keeps its intrinsic width between left and right offsets */
          style={{ left: RULER_PX, width: `calc(100% - ${RULER_PX}px)`, height: RULER_PX }}
          onPointerDown={(e) => onRulerDown(e, 'h')}
        />
        <canvas
          ref={left}
          data-ruler="left"
          aria-label="Vertical ruler: drag right to add a guide"
          className="pointer-events-auto absolute left-0 block cursor-col-resize touch-none"
          style={{ top: RULER_PX, width: RULER_PX, height: `calc(100% - ${RULER_PX}px)` }}
          onPointerDown={(e) => onRulerDown(e, 'v')}
        />
        <div
          className="pointer-events-auto absolute left-0 top-0 bg-surface shadow-[inset_-1px_-1px_0_var(--line)]"
          style={{ width: RULER_PX, height: RULER_PX }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      </div>
      {drag && (
        <div
          data-guide-position=""
          className={cn(
            'pointer-events-none absolute z-[29] whitespace-nowrap rounded-tag px-1.5 py-0.5 font-mono text-micro tabular-nums shadow-pop',
            drag.removing ? 'bg-surface text-ink-faint' : 'bg-brand text-white',
          )}
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          {drag.removing ? 'Remove' : `${drag.axis === 'v' ? 'X' : 'Y'} ${formatRulerValue(drag.value)}`}
        </div>
      )}
    </>
  )
}

/** The page's ruler guides, drawn in world coordinates inside the world
 *  layer: a hairline (counter-scaled through --zoom) inside a few screen px
 *  of grabbable band. Drag one to move it, back onto its ruler to remove it;
 *  click one and Delete removes it. */
export const GuideLines = memo(function GuideLines({ stage }: { stage: RefObject<HTMLDivElement> }) {
  /* select the inputs, not the filtered list: that is a fresh array each time */
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const rulers = useStore((s) => s.rulers)
  const uiHidden = useStore((s) => s.uiHidden)
  /* the same breakpoint snapping reads, so a guide is drawn exactly when it snaps */
  const phone = useIsMobile()
  const guides = useMemo(
    () => visibleGuides({ canvas, activePageId, rulers, uiHidden, phone }),
    [canvas, activePageId, rulers, uiHidden, phone],
  )
  const selectedId = useStore((s) => s.selectedGuideId)
  const dragging = useGuideDrag((s) => s.drag !== null)

  /* Delete removes the selected guide before the canvas's own handler can
     take the (already deselected) frames; any press elsewhere lets go */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = useStore.getState()
      const id = s.selectedGuideId
      if (!id || isTypingTarget(e.target)) return
      if (e.key === 'Escape') return s.selectGuide(null)
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.repeat) return
      /* a guide out of sight (rulers off, chrome hidden, another page, a
         phone) is not there to delete: let go of it and leave the key be */
      const guide = visibleGuides(s).find((g) => g.id === id)
      if (!guide) return s.selectGuide(null)
      e.preventDefault()
      e.stopImmediatePropagation()
      s.selectGuide(null)
      if (s.canvas) void commitGuide(s.canvas.id, guide, null)
    }
    function onDown(e: PointerEvent) {
      if (!(e.target as Element | null)?.closest?.('[data-guide]')) useStore.getState().selectGuide(null)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [])

  const band = `calc(${GUIDE_GRAB_PX * 2 + 1}px / var(--zoom, 1))`
  return (
    <>
      {guides.map((g) => {
        const vertical = g.axis === 'v'
        const on = g.id === selectedId
        return (
          <div
            key={g.id}
            data-guide={g.id}
            data-axis={g.axis}
            data-selected={on ? '' : undefined}
            className={cn(
              'group/guide absolute z-[2] flex touch-none justify-center',
              vertical ? 'cursor-col-resize' : 'cursor-row-resize flex-col',
              dragging && 'pointer-events-none',
            )}
            style={
              vertical
                ? { left: g.at, top: -GUIDE_REACH, height: GUIDE_REACH * 2, width: band, translate: '-50% 0' }
                : { top: g.at, left: -GUIDE_REACH, width: GUIDE_REACH * 2, height: band, translate: '0 -50%' }
            }
            onPointerDown={(e) => {
              if (!grabsGuides() || !stage.current) return
              dragGuide(e, stage.current, g.axis, g)
            }}
          >
            <div
              className={cn(
                'pointer-events-none shrink-0 group-hover/guide:bg-brand',
                on ? 'bg-brand' : 'bg-brand/60',
                vertical ? 'h-full w-[calc(1px/var(--zoom,1))]' : 'h-[calc(1px/var(--zoom,1))] w-full',
              )}
            />
          </div>
        )
      })}
    </>
  )
})
