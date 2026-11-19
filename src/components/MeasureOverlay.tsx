import { useEffect, useState } from 'react'
import { frameDesignPoint, rotatedBounds } from '../../shared/frameRotation'
import type { Frame } from '../../shared/types'
import { clientToWorld, frameAtPoint } from '@/lib/commentMove'
import { measureElement } from '@/lib/frameBridge'
import {
  formatDistance,
  lineLength,
  measureBetween,
  type MeasureLine,
  type Measurement,
  type MeasureRect,
} from '@/lib/measure'
import { measurePointer, useMeasureKey, type MeasurePointer } from '@/lib/measureKey'
import { boundsOf } from '@/lib/rulers'
import { pickedSelectors, useStore } from '@/lib/store'

/* how far past its frame's edge a picked element's grips can be pointed at, in screen px */
const GRIP_REACH = 12

const HAIRLINE = 'calc(1px / var(--zoom, 1))'

interface Shown {
  /** the frame whose design px the measurement is in; the world's when null */
  within: Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'rotation'> | null
  measurement: Measurement
}

function frameBounds(frame: Frame): MeasureRect {
  return rotatedBounds(frame, frame.rotation ?? 0)
}

/* the picked elements are measured, as one box, to what the pointer is over
   in their frame, or to the box around them when that is one of them or
   nothing. Away from their frame the frames are measured instead. */
async function measureElementAt(world: { x: number; y: number }): Promise<Shown | null> {
  const s = useStore.getState()
  const picked = s.selectedElement
  const frame = picked && s.canvas?.frames.find((f) => f.id === picked.frameId)
  if (!picked || !frame) return null
  const at = frameDesignPoint(world, frame)
  const reach = GRIP_REACH / s.viewport.zoom
  if (at.x < -reach || at.y < -reach || at.x > frame.width + reach || at.y > frame.height + reach)
    return measureFramesAt(world)
  const reply = await measureElement(frame.id, picked.selector, at, pickedSelectors(s))
  const selection = reply && boundsOf(reply.rects)
  if (!reply || !selection) return null
  return { within: frame, measurement: measureBetween(selection, reply.over ?? reply.parent) }
}

/* selected frames are measured, as one box, to another frame under the pointer */
function measureFramesAt(world: { x: number; y: number }): Shown | null {
  const s = useStore.getState()
  if (!s.canvas) return null
  const over = frameAtPoint(s.canvas, s.activePageId, world)
  if (!over || s.selectedIds.includes(over.id)) return null
  const selection = boundsOf(s.canvas.frames.filter((f) => s.selectedIds.includes(f.id) && !f.hidden).map(frameBounds))
  return selection && { within: null, measurement: measureBetween(selection, frameBounds(over)) }
}

function measureAt(pointer: MeasurePointer | null): Promise<Shown | null> | Shown | null {
  if (!pointer || pointer.pressed || !pointer.onCanvas) return null
  const world = clientToWorld(pointer.x, pointer.y)
  return useStore.getState().selectedElement ? measureElementAt(world) : measureFramesAt(world)
}

function Line({ line, dashed }: { line: MeasureLine; dashed?: boolean }) {
  const length = lineLength(line)
  const stroke = dashed ? 'dashed' : 'solid'
  return (
    <div
      data-measure-guide={dashed ? '' : undefined}
      className="absolute border-accent-ink"
      style={
        line.axis === 'x'
          ? { left: line.from, top: line.at, width: length, borderTopWidth: HAIRLINE, borderTopStyle: stroke }
          : { left: line.at, top: line.from, height: length, borderLeftWidth: HAIRLINE, borderLeftStyle: stroke }
      }
    />
  )
}

function Label({ line, turned }: { line: MeasureLine; turned: number }) {
  const middle = (line.from + line.to) / 2
  return (
    <span
      data-measure-distance={line.axis}
      className="absolute rounded-tag bg-accent-ink px-1.5 py-0.5 text-label font-medium whitespace-nowrap text-white tabular-nums"
      style={{
        left: line.axis === 'x' ? middle : line.at,
        top: line.axis === 'x' ? line.at : middle,
        /* screen px at every zoom, like the size badge, and upright in a turned frame */
        transform: `translate(-50%, -50%) rotate(${-turned}deg) scale(calc(1 / var(--zoom, 1)))`,
      }}
    >
      {formatDistance(lineLength(line))}
    </span>
  )
}

function Measuring() {
  const [shown, setShown] = useState<Shown | null>(null)
  useEffect(() => {
    let request = 0
    let queued = 0
    async function read() {
      queued = 0
      request += 1
      const mine = request
      const next = await measureAt(measurePointer())
      /* a later reading is already on its way */
      if (mine !== request) return
      /* the same reading again keeps what is drawn */
      setShown((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
    }
    /* at most one reading a frame, however fast the pointer or the store moves */
    const queue = () => {
      queued ||= requestAnimationFrame(() => void read())
    }
    queue()
    const pointerEvents = ['pointermove', 'pointerdown', 'pointerup'] as const
    for (const type of pointerEvents) window.addEventListener(type, queue, { passive: true, capture: true })
    document.documentElement.addEventListener('pointerleave', queue)
    /* the selection, a frame's box or its document, or the camera changed
       under a still pointer; presence and the rest of the store do not count */
    const unsubscribe = useStore.subscribe((s, was) => {
      if (
        s.canvas !== was.canvas ||
        s.viewport !== was.viewport ||
        s.selectedIds !== was.selectedIds ||
        s.selectedElement !== was.selectedElement ||
        s.selectedElements !== was.selectedElements
      )
        queue()
    })
    return () => {
      request += 1
      cancelAnimationFrame(queued)
      for (const type of pointerEvents) window.removeEventListener(type, queue, { capture: true })
      document.documentElement.removeEventListener('pointerleave', queue)
      unsubscribe()
    }
  }, [])

  if (!shown) return null
  const { within, measurement } = shown
  return (
    <div
      data-measure=""
      className="pointer-events-none absolute z-10"
      style={
        within
          ? {
              left: within.x,
              top: within.y,
              width: within.width,
              height: within.height,
              transform: within.rotation ? `rotate(${within.rotation}deg)` : undefined,
            }
          : { left: 0, top: 0 }
      }
    >
      {measurement.guides.map((line, i) => (
        <Line key={`guide-${i}`} line={line} dashed />
      ))}
      {measurement.lines.map((line, i) => (
        <Line key={`line-${i}`} line={line} />
      ))}
      {measurement.lines.map((line, i) => (
        <Label key={`label-${i}`} line={line} turned={within?.rotation ?? 0} />
      ))}
    </div>
  )
}

/** While ⌥ is held with something selected, the distances from the selection
 *  to what the pointer is over, as Figma draws them: red lines, each labelled
 *  with its length. Lives in the Stage's world. */
export function MeasureOverlay() {
  const held = useMeasureKey()
  const armed = useStore((s) => held && s.tool === 'select' && !s.panMode && s.selectedIds.length > 0)
  return armed ? <Measuring /> : null
}
