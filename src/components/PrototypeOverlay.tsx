import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Frame } from '../../shared/types'
import { canvasPages, framePageId } from '../../shared/pages'
import { DEFAULT_PROTO_DURATION, targetsFrame, type Interaction } from '../../shared/prototype'
import { useStore } from '../lib/store'
import { usePageCanvas } from '../lib/pages'
import { inspectElement, onFrameChange, scanHotspots, type ScannedHotspot } from '../lib/frameBridge'
import { elementInteractions, saveInteractions } from '../lib/prototype'
import { isLayerLocked } from '../lib/layerEdits'
import { FlowStartIcon } from './ui/icons'

type Rect = { x: number; y: number; width: number; height: number }

/* the connector from a hotspot's right (or left) edge into the target frame's
   near side, bent like Figma's prototype noodles; world coordinates */
function connector(from: Rect, to: Rect): string {
  const toRight = to.x + to.width / 2 >= from.x + from.width / 2
  const sx = toRight ? from.x + from.width : from.x
  const sy = from.y + from.height / 2
  const tx = toRight ? to.x : to.x + to.width
  const ty = to.y + Math.min(80, to.height / 2)
  const bend = Math.max(60, Math.abs(tx - sx) / 3) * (toRight ? 1 : -1)
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`
}

function worldRect(frame: Frame, rect: Rect): Rect {
  /* clamp into the frame: a hotspot scrolled out of view still anchors on it */
  const x = Math.min(Math.max(rect.x, 0), Math.max(frame.width - 4, 0))
  const y = Math.min(Math.max(rect.y, 0), Math.max(frame.height - 4, 0))
  return {
    x: frame.x + x,
    y: frame.y + y,
    width: Math.max(4, Math.min(rect.width, frame.width - x)),
    height: Math.max(4, Math.min(rect.height, frame.height - y)),
  }
}

function contains(f: Frame, x: number, y: number) {
  return x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height
}

/** Prototype mode on the stage: every interaction's connector from its
 *  hotspot to the frame it opens, a flag on the page's flow start, and — on
 *  the picked element — a handle to drag onto a frame to wire a navigation. */
export function PrototypeOverlay() {
  const on = useStore((s) => s.prototypeMode)
  const canvas = usePageCanvas()
  const activePageId = useStore((s) => s.activePageId)
  if (!on || !canvas) return null
  const pageId = activePageId ?? canvasPages(canvas)[0]?.id
  const startFrameId = canvasPages(canvas).find((p) => p.id === pageId)?.startFrameId
  return <Connectors frames={canvas.frames.filter((f) => !f.hidden)} startFrameId={startFrameId} />
}

function Connectors({ frames, startFrameId }: { frames: Frame[]; startFrameId?: string }) {
  const [scans, setScans] = useState<Record<string, ScannedHotspot[]>>({})
  const zoom = useStore((s) => s.viewport.zoom)
  const picked = useStore((s) => s.selectedElement)
  const fullCanvas = useStore((s) => s.canvas)

  /* the live documents report their hotspots (script-made ones included);
     each re-reads whenever its frame renders */
  const idsKey = frames.map((f) => f.id).join(' ')
  useEffect(() => {
    let live = true
    const read = (id: string) =>
      scanHotspots(id)
        .then((items) => live && setScans((all) => ({ ...all, [id]: items })))
        .catch(console.error)
    const offs = idsKey
      .split(' ')
      .filter(Boolean)
      .map((id) => {
        void read(id)
        return onFrameChange(id, () => void read(id))
      })
    return () => {
      live = false
      offs.forEach((off) => off())
    }
  }, [idsKey])

  const byId = useMemo(() => new Map((fullCanvas?.frames ?? []).map((f) => [f.id, f])), [fullCanvas])
  const onPage = useMemo(() => new Map(frames.map((f) => [f.id, f])), [frames])

  const links = useMemo(() => {
    const out: { key: string; box: Rect; path: string | null; label: string | null; picked: boolean }[] = []
    for (const frame of frames) {
      for (const [n, spot] of (scans[frame.id] ?? []).entries()) {
        const box = worldRect(frame, spot.rect)
        const isPicked = picked?.frameId === frame.id && picked.selector === spot.selector
        for (const [m, interaction] of spot.interactions.entries()) {
          const key = `${frame.id}:${n}:${m}`
          if (!targetsFrame(interaction)) {
            out.push({ key, box, path: null, label: describe(interaction), picked: isPicked })
            continue
          }
          const target = onPage.get(interaction.target)
          if (target) out.push({ key, box, path: connector(box, target), label: null, picked: isPicked })
          else {
            const elsewhere = byId.get(interaction.target)
            const page =
              elsewhere && fullCanvas
                ? canvasPages(fullCanvas).find((p) => p.id === framePageId(fullCanvas, elsewhere))
                : undefined
            out.push({
              key,
              box,
              path: null,
              label: elsewhere ? `→ ${elsewhere.name}${page ? ` (${page.name})` : ''}` : '→ missing frame',
              picked: isPicked,
            })
          }
        }
      }
    }
    return out
  }, [frames, scans, onPage, byId, fullCanvas, picked])

  const start = startFrameId ? onPage.get(startFrameId) : undefined
  const sourceFrame = picked ? onPage.get(picked.frameId) : undefined
  const stroke = 1.5 / zoom

  return (
    <>
      <svg
        className="pointer-events-none absolute top-0 left-0 z-[6] overflow-visible text-brand"
        width={1}
        height={1}
        data-prototype-overlay=""
      >
        <defs>
          <marker id="proto-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="currentColor" />
          </marker>
        </defs>
        {links.map((link) => (
          <g key={link.key} opacity={link.picked || !picked ? 1 : 0.55}>
            <rect
              x={link.box.x}
              y={link.box.y}
              width={link.box.width}
              height={link.box.height}
              rx={3 / zoom}
              fill="currentColor"
              fillOpacity={0.08}
              stroke="currentColor"
              strokeWidth={stroke}
            />
            {link.path && (
              <path
                d={link.path}
                fill="none"
                stroke="currentColor"
                strokeWidth={stroke * (link.picked ? 1.6 : 1)}
                markerEnd="url(#proto-arrow)"
                data-proto-connector=""
              />
            )}
            {link.label && (
              <text
                x={link.box.x + link.box.width + 6 / zoom}
                y={link.box.y + link.box.height / 2}
                dominantBaseline="middle"
                fill="currentColor"
                fontSize={11 / zoom}
                stroke="var(--surface)"
                strokeWidth={3 / zoom}
                paintOrder="stroke"
              >
                {link.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {start && (
        <div
          className="pointer-events-none absolute z-[7] flex origin-bottom-left items-center gap-1 rounded-tag bg-brand px-1.5 py-0.5 text-caption font-medium text-white"
          style={{ left: start.x, top: start.y, transform: `translateY(-100%) translateY(-6px) scale(${1 / zoom})` }}
          data-flow-start={start.id}
        >
          <FlowStartIcon size={12} /> Start
        </div>
      )}
      {sourceFrame && picked && !isLayerLocked(sourceFrame, picked.selector) && (
        <ConnectHandle
          key={`${picked.frameId}:${picked.selector}`}
          frame={sourceFrame}
          selector={picked.selector}
          frames={frames}
        />
      )}
    </>
  )
}

function describe(i: Interaction): string {
  switch (i.action) {
    case 'back':
      return '← Back'
    case 'close-overlay':
      return '✕ Close overlay'
    case 'scroll-to':
      return `↓ ${i.target ?? ''}`
    case 'url':
      return `↗ ${i.target ?? ''}`
    default:
      return ''
  }
}

/** The round handle on the picked element's edge: drag it onto another frame
 *  to add a click → navigate interaction, as one undo step. */
function ConnectHandle({ frame, selector, frames }: { frame: Frame; selector: string; frames: Frame[] }) {
  const [rect, setRect] = useState<Rect | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number; over: Frame | null } | null>(null)
  const zoom = useStore((s) => s.viewport.zoom)

  useEffect(() => {
    let live = true
    const read = () =>
      inspectElement(frame.id, selector)
        .then((info) => live && setRect(info ? info.rect : null))
        .catch(console.error)
    void read()
    const off = onFrameChange(frame.id, () => void read())
    return () => {
      live = false
      off()
    }
  }, [frame.id, selector, frame.updatedAt])

  if (!rect) return null
  const box = worldRect(frame, rect)
  const hx = box.x + box.width
  const hy = box.y + box.height / 2

  function toWorld(clientX: number, clientY: number) {
    const stage = document.querySelector('.stage')?.getBoundingClientRect()
    const vp = useStore.getState().viewport
    return { x: (clientX - (stage?.left ?? 0) - vp.x) / vp.zoom, y: (clientY - (stage?.top ?? 0) - vp.y) / vp.zoom }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toWorld(e.clientX, e.clientY)
    setDrag({ ...p, over: null })
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return
    const p = toWorld(e.clientX, e.clientY)
    const over = frames.find((f) => f.id !== frame.id && contains(f, p.x, p.y)) ?? null
    setDrag({ ...p, over })
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return
    e.stopPropagation()
    const target = drag.over
    setDrag(null)
    if (!target) return
    const live = useStore.getState().canvas?.frames.find((f) => f.id === frame.id) ?? frame
    const list = elementInteractions(live.html, selector)
    if (!list) return useStore.getState().pushNotice('A script creates this element — wire it in the HTML')
    const next: Interaction = {
      trigger: 'click',
      action: 'navigate',
      target: target.id,
      transition: 'instant',
      duration: DEFAULT_PROTO_DURATION,
    }
    const kept = list.filter((i) => !(i.trigger === 'click' && targetsFrame(i)))
    if (saveInteractions(live, selector, [...kept, next]))
      useStore.getState().pushNotice(`Click now goes to “${target.name}”`)
  }

  const size = 14 / zoom
  return (
    <>
      {drag && (
        <svg
          className="pointer-events-none absolute top-0 left-0 z-[8] overflow-visible text-brand"
          width={1}
          height={1}
        >
          {drag.over && (
            <rect
              x={drag.over.x}
              y={drag.over.y}
              width={drag.over.width}
              height={drag.over.height}
              fill="currentColor"
              fillOpacity={0.06}
              stroke="currentColor"
              strokeWidth={2 / zoom}
            />
          )}
          <path
            d={connector(box, { x: drag.x, y: drag.y, width: 0, height: 0 })}
            fill="none"
            stroke="currentColor"
            strokeWidth={2 / zoom}
            strokeDasharray={`${6 / zoom} ${4 / zoom}`}
          />
        </svg>
      )}
      <div
        className="absolute z-[8] cursor-crosshair rounded-full border-2 border-white bg-brand shadow-pop"
        style={{ left: hx - size / 2, top: hy - size / 2, width: size, height: size, borderWidth: 2 / zoom }}
        title="Drag onto a frame to link it"
        aria-label="Drag onto a frame to link it"
        data-proto-handle=""
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      />
    </>
  )
}
