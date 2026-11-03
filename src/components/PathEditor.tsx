import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Frame } from '../../shared/types'
import { isCanvasElement, nearestPathAnchor, type PathPoint, type Point } from '../lib/drawing'
import { requestFrame } from '../lib/frameBridge'
import { gesture } from '../lib/gesture'
import { isTypingTarget } from '../lib/keys'
import {
  editablePathData,
  loadPathEdit,
  mapPathPoint,
  savePathEdit,
  unmapPathPoint,
  type EditablePath,
  type PathEditSource,
  type PathMatrix,
} from '../lib/pathEditing'
import { nearestT, segments, splitSegment, subpathsData } from '../lib/svgPath'
import { useStore } from '../lib/store'
import { useT } from '../lib/i18n'

/** One anchor of the path, addressed by its subpath and its place in it;
 *  `flat` numbers every anchor of the path in order, for the markup. */
interface Anchor {
  subpath: number
  index: number
  flat: number
  point: PathPoint
}

function anchorsOf(path: EditablePath): Anchor[] {
  const out: Anchor[] = []
  path.subpaths.forEach((subpath, s) =>
    subpath.points.forEach((point, i) => out.push({ subpath: s, index: i, flat: out.length, point })),
  )
  return out
}

function replacePoint(path: EditablePath, anchor: Anchor, point: PathPoint): EditablePath {
  return {
    subpaths: path.subpaths.map((subpath, s) =>
      s === anchor.subpath
        ? { ...subpath, points: subpath.points.map((p, i) => (i === anchor.index ? point : p)) }
        : subpath,
    ),
  }
}

export function PathEditor({
  frame,
  initial,
  onClose,
}: {
  frame: Frame
  initial: PathEditSource
  onClose: () => void
}) {
  const [source, setSource] = useState(initial)
  const [path, setPath] = useState<EditablePath>(initial)
  const [selected, setSelected] = useState<number | null>(null)
  const [snapped, setSnapped] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const alive = useRef(true)
  const cleanup = useRef<(() => void) | null>(null)
  const revision = useRef(0)
  const zoom = useStore((s) => s.viewport.zoom)
  const t = useT()
  const stage = document.querySelector<HTMLElement>('.stage')
  const world = stage?.querySelector('.world')
  const border = isCanvasElement(frame.html) ? 0 : 1
  const matrix: PathMatrix = [...source.matrix]
  matrix[4] += frame.x + border
  matrix[5] += frame.y + border
  const anchors = anchorsOf(path)
  const current = selected === null ? undefined : anchors[selected]

  const refresh = useCallback(
    async (requested: Frame) => {
      const current = ++revision.current
      const latest = useStore.getState().canvas?.frames.find((f) => f.id === requested.id)
      if (!latest) return
      await requestFrame(latest.id, 'doop:html', { html: latest.html })
      const next = await loadPathEdit(latest, { selector: initial.selector })
      if (!alive.current || current !== revision.current) return
      if (!next) return onClose()
      setSource(next)
      setPath(next)
      setSelected((index) => (index !== null && index < anchorsOf(next).length ? index : null))
    },
    [initial.selector, onClose],
  )

  useEffect(() => {
    alive.current = true
    void requestFrame(frame.id, 'doop:path-editing', { selector: initial.selector })
    return () => {
      alive.current = false
      cleanup.current?.()
      void requestFrame(frame.id, 'doop:path-editing', { selector: null })
    }
  }, [frame.id, initial.selector])

  useEffect(() => {
    // Undo, remote changes and frame resizing all require fresh iframe geometry.
    cleanup.current?.()
    cleanup.current = null
    // eslint-disable-next-line react/set-state-in-effect -- sync the iframe document, then read its new geometry
    void refresh(frame)
  }, [frame, refresh])

  useEffect(() => {
    const page = useStore.getState().activePageId
    const unsubscribe = useStore.subscribe((state) => {
      const current = state.canvas?.frames.find((f) => f.id === frame.id)
      if (
        state.canvas?.id !== frame.canvasId ||
        state.activePageId !== page ||
        state.tool !== 'select' ||
        !state.selectedIds.includes(frame.id) ||
        !current ||
        current.locked ||
        current.hidden
      )
        onClose()
    })
    const outside = (event: PointerEvent) => {
      if (event.button !== 0 || useStore.getState().panMode || (event.target as Element).closest('[data-path-editor]'))
        return
      onClose()
    }
    const blur = () => {
      cleanup.current?.()
      cleanup.current = null
      setPath(source)
      setSnapped(null)
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => {
      unsubscribe()
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', blur)
    }
  }, [frame.id, frame.canvasId, onClose, source])

  async function commit(next: EditablePath) {
    if (busy.current || editablePathData(next) === editablePathData(source)) return
    busy.current = true
    setSaving(true)
    await savePathEdit(frame, source, next)
    if (alive.current) {
      await refresh(frame)
      setSaving(false)
    }
    busy.current = false
  }

  /** A path keeps at least one stroke of two anchors; a stroke that would
   *  fall under two goes as a whole when the path has others. */
  function canRemove(anchor: Anchor | undefined): boolean {
    if (!anchor) return false
    const subpath = path.subpaths[anchor.subpath]!
    return subpath.points.length > 2 || path.subpaths.length > 1
  }

  function removePoint() {
    if (!current || !canRemove(current) || busy.current) return
    const subpath = path.subpaths[current.subpath]!
    const next: EditablePath = {
      subpaths:
        subpath.points.length > 2
          ? path.subpaths.map((sp, s) =>
              s === current.subpath ? { ...sp, points: sp.points.filter((_, i) => i !== current.index) } : sp,
            )
          : path.subpaths.filter((_, s) => s !== current.subpath),
    }
    setSelected(null)
    setPath(next)
    void commit(next)
  }

  function toggleCurve(flat: number) {
    const anchor = anchors[flat]
    if (busy.current || !anchor) return
    const point = anchor.point
    const subpath = path.subpaths[anchor.subpath]!
    let next: PathPoint = { x: point.x, y: point.y }
    if (!point.handleIn && !point.handleOut) {
      const before = subpath.points[anchor.index - 1] ?? (subpath.closed ? subpath.points.at(-1)! : point)
      const after = subpath.points[anchor.index + 1] ?? (subpath.closed ? subpath.points[0]! : point)
      const tangent = { x: (after.x - before.x) / 6, y: (after.y - before.y) / 6 }
      if (!tangent.x && !tangent.y) tangent.x = 20
      next = { ...next, handleOut: tangent, handleIn: { x: -tangent.x, y: -tangent.y } }
    }
    const changed = replacePoint(path, anchor, next)
    setPath(changed)
    void commit(changed)
  }

  const worldPoint = (clientX: number, clientY: number): Point => {
    const box = stage!.getBoundingClientRect()
    const viewport = useStore.getState().viewport
    return {
      x: (clientX - box.left - viewport.x) / viewport.zoom,
      y: (clientY - box.top - viewport.y) / viewport.zoom,
    }
  }

  /** A click on the outline adds an anchor there, as the pen does in Figma:
   *  the segment is split where the pointer is, keeping the curve's shape. */
  function addPoint(event: ReactPointerEvent<SVGPathElement>, subpathIndex: number, segment: number) {
    if (busy.current || event.button !== 0 || !event.isPrimary || gesture.pinching || useStore.getState().panMode)
      return
    event.preventDefault()
    event.stopPropagation()
    const subpath = path.subpaths[subpathIndex]!
    const [from, to] = segments(subpath)[segment]!
    const at = unmapPathPoint(worldPoint(event.clientX, event.clientY), matrix)
    const { t } = nearestT(from, to, at)
    const [start, mid, end] = splitSegment(from, to, t)
    const count = subpath.points.length
    const points = [...subpath.points]
    points[segment] = start
    points[(segment + 1) % count] = end
    points.splice(segment + 1, 0, mid)
    const next: EditablePath = {
      subpaths: path.subpaths.map((sp, s) => (s === subpathIndex ? { ...sp, points } : sp)),
    }
    setPath(next)
    setSelected(anchors.find((a) => a.subpath === subpathIndex && a.index === segment)!.flat + 1)
    void commit(next)
  }

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.isComposing || isTypingTarget(event.target)) return
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (cleanup.current) {
          cleanup.current()
          cleanup.current = null
          setPath(source)
          setSnapped(null)
        } else onClose()
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        event.stopImmediatePropagation()
        removePoint()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  function start(event: ReactPointerEvent<SVGCircleElement>, anchor: Anchor, handle?: 'handleIn' | 'handleOut') {
    if (busy.current || event.button !== 0 || !event.isPrimary || gesture.pinching || useStore.getState().panMode)
      return
    event.preventDefault()
    event.stopPropagation()
    setSelected(anchor.flat)
    cleanup.current?.()
    const surface = event.currentTarget
    const pointerId = event.pointerId
    surface.setPointerCapture(pointerId)
    const original = path
    const others = anchorsOf(original)
    let next = path
    let moved = false
    const startX = event.clientX
    const startY = event.clientY
    const press = unmapPathPoint(worldPoint(event.clientX, event.clientY), matrix)
    const point = anchor.point
    function cancel() {
      cleanup.current?.()
      cleanup.current = null
      setPath(original)
      setSnapped(null)
    }
    function move(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      if (gesture.pinching) return cancel()
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 2) return
      moved = true
      const at = unmapPathPoint(worldPoint(ev.clientX, ev.clientY), matrix)
      const delta = { x: at.x - press.x, y: at.y - press.y }
      let changed: PathPoint
      if (handle) {
        let vector = { x: (point[handle]?.x ?? 0) + delta.x, y: (point[handle]?.y ?? 0) + delta.y }
        if (ev.shiftKey) {
          const angle = Math.round(Math.atan2(vector.y, vector.x) / (Math.PI / 4)) * (Math.PI / 4)
          const length = Math.hypot(vector.x, vector.y)
          vector = { x: Math.cos(angle) * length, y: Math.sin(angle) * length }
        }
        changed = { ...point, [handle]: vector }
        if (!ev.altKey) changed[handle === 'handleIn' ? 'handleOut' : 'handleIn'] = { x: -vector.x, y: -vector.y }
      } else {
        const desired = { x: point.x + delta.x, y: point.y + delta.y }
        const snap = ev.altKey
          ? null
          : nearestPathAnchor(
              others.map((a) => mapPathPoint(a.point, matrix)),
              mapPathPoint(desired, matrix),
              useStore.getState().viewport.zoom,
              anchor.flat,
            )
        setSnapped(snap)
        const target = snap === null ? desired : { x: others[snap]!.point.x, y: others[snap]!.point.y }
        changed = { ...point, ...target }
      }
      next = replacePoint(original, anchor, changed)
      setPath(next)
    }
    function up(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      move(ev)
      cleanup.current?.()
      cleanup.current = null
      setSnapped(null)
      if (moved && !gesture.pinching) void commit(next)
    }
    function cancelled(ev: PointerEvent) {
      if (ev.pointerId === pointerId) cancel()
    }
    cleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancelled)
      surface.removeEventListener('lostpointercapture', cancelled)
      if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancelled)
    surface.addEventListener('lostpointercapture', cancelled)
  }

  if (!stage || !world) return null
  const segmentData = ([from, to]: [PathPoint, PathPoint]) => subpathsData([{ points: [from, to], closed: false }])
  return (
    <>
      {createPortal(
        <svg
          data-path-editor
          className="pointer-events-none absolute top-0 left-0 z-30 overflow-visible"
          width={1}
          height={1}
        >
          <g transform={`matrix(${matrix.join(' ')})`}>
            <path
              d={editablePathData(path)}
              fill={source.paint.fill}
              stroke={source.paint.stroke}
              strokeWidth={source.paint.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* the outline's own hit area: a press here adds an anchor */}
            {path.subpaths.map((subpath, s) =>
              segments(subpath).map((segment, i) => (
                <path
                  key={`${s}-${i}`}
                  data-path-segment={`${s}-${i}`}
                  className="pointer-events-auto cursor-pen-add"
                  d={segmentData(segment)}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={10 / zoom}
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(e) => addPoint(e, s, i)}
                />
              )),
            )}
          </g>
          {anchors.map((anchor) => {
            const { point, flat } = anchor
            const at = mapPathPoint(point, matrix)
            return (
              <g key={flat}>
                {(['handleIn', 'handleOut'] as const).map((handle) => {
                  const vector = point[handle]
                  if (!vector || (!vector.x && !vector.y)) return null
                  const end = mapPathPoint({ x: point.x + vector.x, y: point.y + vector.y }, matrix)
                  return (
                    <g key={handle}>
                      <line x1={at.x} y1={at.y} x2={end.x} y2={end.y} stroke="var(--brand)" strokeWidth={0.75 / zoom} />
                      <circle
                        cx={end.x}
                        cy={end.y}
                        r={2 / zoom}
                        fill="white"
                        stroke="var(--brand)"
                        strokeWidth={0.75 / zoom}
                      />
                      <circle
                        data-path-handle={`${flat}-${handle}`}
                        aria-label={t(handle === 'handleIn' ? 'stage.pathHandleIncoming' : 'stage.pathHandleOutgoing', {
                          n: flat + 1,
                        })}
                        className="pointer-events-auto cursor-handle"
                        cx={end.x}
                        cy={end.y}
                        r={9 / zoom}
                        fill="transparent"
                        onPointerDown={(e) => start(e, anchor, handle)}
                      />
                    </g>
                  )
                })}
                <circle
                  cx={at.x}
                  cy={at.y}
                  r={2.5 / zoom}
                  fill={selected === flat ? 'var(--brand)' : 'white'}
                  stroke="var(--brand)"
                  strokeWidth={0.75 / zoom}
                />
                <circle
                  data-path-edit-anchor={flat}
                  aria-label={t('stage.pathPoint', { n: flat + 1 })}
                  className="pointer-events-auto cursor-node"
                  cx={at.x}
                  cy={at.y}
                  r={9 / zoom}
                  fill="transparent"
                  onPointerDown={(e) => start(e, anchor)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    toggleCurve(flat)
                  }}
                />
                {snapped === flat && (
                  <circle
                    data-path-edit-snap
                    cx={at.x}
                    cy={at.y}
                    r={7 / zoom}
                    fill="none"
                    stroke="var(--brand)"
                    strokeWidth={0.75 / zoom}
                  />
                )}
              </g>
            )
          })}
        </svg>,
        world,
      )}
      {createPortal(
        <div
          data-path-editor
          className="absolute bottom-24 left-1/2 z-40 flex max-w-[90%] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink shadow-pop"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span>{saving ? t('stage.savingPath') : t('stage.pathHint')}</span>
          {current && (
            <>
              <button
                type="button"
                disabled={saving}
                className="font-semibold text-brand disabled:opacity-40"
                onClick={() => toggleCurve(current.flat)}
              >
                {current.point.handleIn || current.point.handleOut ? t('stage.makeCorner') : t('stage.makeCurve')}
              </button>
              <button
                type="button"
                disabled={saving || !canRemove(current)}
                className="disabled:opacity-40"
                onClick={removePoint}
              >
                {t('stage.deletePoint')}
              </button>
            </>
          )}
          <button type="button" className="font-semibold text-brand" onClick={onClose}>
            {t('stage.done')}
          </button>
        </div>,
        stage,
      )}
    </>
  )
}
