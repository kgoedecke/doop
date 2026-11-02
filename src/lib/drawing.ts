import type { Frame } from '../../shared/types'
import { api, errorMessage } from './api'
import { recordCreate, recordUpdates, trackSave } from './history'
import { currentPageCanvas } from './pages'
import { useStore } from './store'
import type { DrawingTool } from './tools'

export interface Point {
  x: number
  y: number
}

/** A pen drag sets a tangent vector; the incoming handle mirrors it. */
export interface PathPoint extends Point {
  handle?: Point
  handleIn?: Point
  handleOut?: Point
}

/** A constant screen-space radius makes anchors equally easy to hit at any zoom. */
export function nearestPathAnchor(points: Point[], at: Point, zoom: number, exclude = -1): number | null {
  let nearest: number | null = null
  let distance = 8
  points.forEach((point, index) => {
    const next = Math.hypot(point.x - at.x, point.y - at.y) * zoom
    if (index !== exclude && (next < distance || (nearest === null && next <= distance))) {
      nearest = index
      distance = next
    }
  })
  return nearest
}

export interface Drawing {
  tool: DrawingTool
  x: number
  y: number
  width: number
  height: number
  points?: PathPoint[]
  closed?: boolean
  text?: string
}

export interface DrawingTarget {
  canvasId: string
  pageId: string | null
  frameId?: string
}

export const DRAWING_FILL = '#d9d9d9'
export const DRAWING_INK = '#202124'
const names: Record<DrawingTool, string> = {
  rectangle: 'Rectangle',
  circle: 'Circle',
  path: 'Vector path',
  text: 'Text',
  frame: 'Frame',
}
let pendingDrawing: Promise<void> = Promise.resolve()

/** Standalone elements use the same persistence, layers and export as frames,
 *  with transparent chrome. The marker stays in HTML through undo and copying. */
export function isCanvasElement(html: string): boolean {
  return /<body\b[^>]*\bdata-doop-canvas-element=/i.test(html)
}

export function drawingTarget(point: Point, tool: DrawingTool): DrawingTarget | null {
  const canvas = currentPageCanvas()
  if (!canvas) return null
  const hit = [...canvas.frames]
    .reverse()
    .find((f) => !f.hidden && point.x >= f.x && point.y >= f.y && point.x <= f.x + f.width && point.y <= f.y + f.height)
  return {
    canvasId: canvas.id,
    pageId: useStore.getState().activePageId,
    frameId: tool !== 'frame' && hit && !hit.locked && !isCanvasElement(hit.html) ? hit.id : undefined,
  }
}

/** Normalize reverse drags; circles stay round and Shift constrains boxes. */
export function drawingBounds(tool: DrawingTool, start: Point, end: Point, square = false): Drawing {
  let dx = end.x - start.x
  let dy = end.y - start.y
  if (tool === 'circle' || square) {
    const size = Math.max(Math.abs(dx), Math.abs(dy))
    dx = (dx < 0 ? -1 : 1) * size
    dy = (dy < 0 ? -1 : 1) * size
  }
  return { tool, x: start.x + Math.min(0, dx), y: start.y + Math.min(0, dy), width: Math.abs(dx), height: Math.abs(dy) }
}

export function defaultDrawing(tool: DrawingTool, at: Point): Drawing {
  const size =
    tool === 'frame'
      ? { width: 640, height: 480 }
      : tool === 'text'
        ? { width: 240, height: 40 }
        : { width: 120, height: 120 }
  return { tool, ...at, ...size }
}

/** A little padding keeps horizontal/vertical paths and their stroke visible. */
export function pathDrawing(points: PathPoint[], closed = false): Drawing {
  const bounds: Point[] = [...points]
  for (let i = 1; i < points.length + (closed ? 1 : 0); i++) {
    const from = points[i - 1]!
    const to = points[i % points.length]!
    const [a, b] = controls(from, to)
    for (const axis of ['x', 'y'] as const) {
      // Extrema of the cubic, rather than its handles, define its visible bounds.
      const p = -from[axis] + 3 * a[axis] - 3 * b[axis] + to[axis]
      const q = 2 * (from[axis] - 2 * a[axis] + b[axis])
      const r = a[axis] - from[axis]
      const discriminant = q * q - 4 * p * r
      const roots =
        Math.abs(p) < 1e-9
          ? Math.abs(q) < 1e-9
            ? []
            : [-r / q]
          : discriminant < 0
            ? []
            : [(-q + Math.sqrt(discriminant)) / (2 * p), (-q - Math.sqrt(discriminant)) / (2 * p)]
      for (const t of roots) {
        if (t <= 0 || t >= 1) continue
        const u = 1 - t
        bounds.push({
          x: u ** 3 * from.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t ** 3 * to.x,
          y: u ** 3 * from.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t ** 3 * to.y,
        })
      }
    }
  }
  const x = Math.min(...bounds.map((p) => p.x)) - 2
  const y = Math.min(...bounds.map((p) => p.y)) - 2
  return {
    tool: 'path',
    x,
    y,
    width: Math.max(...bounds.map((p) => p.x)) - x + 2,
    height: Math.max(...bounds.map((p) => p.y)) - y + 2,
    points,
    closed,
  }
}

export function pathData(drawing: Drawing): string {
  const points = drawing.points ?? []
  const first = points[0]
  if (!first) return ''
  const at = (p: Point) => `${round(p.x - drawing.x)} ${round(p.y - drawing.y)}`
  const commands = [`M ${at(first)}`]
  for (let i = 1; i < points.length + (drawing.closed ? 1 : 0); i++) {
    const from = points[i - 1]!
    const to = points[i % points.length]!
    if (from.handle || to.handle || from.handleOut || to.handleIn) {
      const [a, b] = controls(from, to)
      commands.push(`C ${at(a)} ${at(b)} ${at(to)}`)
    } else if (i < points.length) commands.push(`L ${at(to)}`)
  }
  if (drawing.closed) commands.push('Z')
  return commands.join(' ')
}

function controls(from: PathPoint, to: PathPoint): [Point, Point] {
  return [
    { x: from.x + (from.handleOut?.x ?? from.handle?.x ?? 0), y: from.y + (from.handleOut?.y ?? from.handle?.y ?? 0) },
    { x: to.x + (to.handleIn?.x ?? -(to.handle?.x ?? 0)), y: to.y + (to.handleIn?.y ?? -(to.handle?.y ?? 0)) },
  ]
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** DOM creation keeps typed text literal, including HTML-looking strings. */
export function drawingElement(doc: Document, drawing: Drawing, standalone: boolean): Element {
  const el =
    drawing.tool === 'path'
      ? doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      : doc.createElement(drawing.tool === 'text' ? 'p' : 'div')
  el.setAttribute('data-doop-drawing', drawing.tool)
  el.setAttribute('data-name', names[drawing.tool])
  // Fixed coordinates inside an existing iframe ignore the imported body's
  // margins, positioning and layout. Standalone elements scale with their frame.
  el.setAttribute(
    'style',
    `position:${standalone ? 'absolute' : 'fixed'};left:${standalone ? 0 : round(drawing.x)}px;top:${standalone ? 0 : round(drawing.y)}px;width:${standalone ? '100%' : `${round(drawing.width)}px`};height:${standalone ? '100%' : `${round(drawing.height)}px`};box-sizing:border-box;margin:0;`,
  )
  if (drawing.tool === 'path') {
    el.setAttribute('viewBox', `0 0 ${round(drawing.width)} ${round(drawing.height)}`)
    el.setAttribute('preserveAspectRatio', 'none')
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', pathData(drawing))
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', DRAWING_INK)
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    el.append(path)
  } else {
    const style = (el as HTMLElement).style
    if (drawing.tool === 'text') {
      style.cssText += `font:24px/1.4 Arial,sans-serif;color:${DRAWING_INK};white-space:pre-wrap;overflow-wrap:anywhere;`
      el.textContent = drawing.text ?? ''
    } else {
      style.background = DRAWING_FILL
      if (drawing.tool === 'circle') style.borderRadius = '50%'
    }
  }
  return el
}

export function drawingDocument(drawing: Drawing): string {
  const doc = new DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html')
  doc.documentElement.style.cssText = 'width:100%;height:100%;margin:0;'
  doc.body.style.cssText = 'width:100%;height:100%;margin:0;'
  if (drawing.tool === 'frame') doc.body.style.background = '#ffffff'
  else {
    doc.body.setAttribute('data-doop-canvas-element', 'true')
    doc.body.append(drawingElement(doc, drawing, true))
  }
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

/** Read the current document when committing, so edits received during the
 *  gesture survive. Use the normal API for collaboration and tracked history. */
export function saveDrawing(drawing: Drawing, target: DrawingTarget): Promise<void> {
  const save = async () => {
    const s = useStore.getState()
    // This gesture is complete. Navigation only cancels drafts; queued saves
    // still belong to their recorded canvas/page, not the current viewport.
    if (target.frameId) {
      const canvas = s.canvas?.id === target.canvasId ? s.canvas : await api.getCanvas(target.canvasId)
      const frame = canvas.frames.find((f) => f.id === target.frameId)
      if (!frame || frame.locked || frame.hidden) {
        s.pushNotice('Couldn’t add the drawing: its frame was deleted, locked, or hidden.')
        return
      }
      const doc = new DOMParser().parseFromString(frame.html, 'text/html')
      const local = { ...drawing, x: drawing.x - frame.x, y: drawing.y - frame.y }
      // Path points and bounds must use the same coordinate system.
      local.points = drawing.points?.map((p) => ({ ...p, x: p.x - frame.x, y: p.y - frame.y }))
      const el = drawingElement(doc, local, false)
      el.id = `doop-drawing-${crypto.randomUUID()}`
      doc.body.append(el)
      const html = '<!doctype html>\n' + doc.documentElement.outerHTML
      const saved = await api.updateFrame(frame.id, { html })
      if (useStore.getState().canvas?.id !== target.canvasId) return
      // Each completed drawing is its own undo step, even when drawn quickly.
      recordUpdates([{ frameId: frame.id, before: { html: frame.html }, after: { html } }])
      useStore.getState().upsertFrame(saved)
      if (useStore.getState().activePageId === target.pageId) {
        useStore.getState().select(frame.id)
        useStore.getState().pickElement({ frameId: frame.id, selector: `#${el.id}` })
      }
    } else {
      const frame: Frame = await api.createFrame(target.canvasId, {
        name: names[drawing.tool],
        pageId: target.pageId ?? undefined,
        x: round(drawing.x),
        y: round(drawing.y),
        width: Math.max(1, round(drawing.width)),
        height: Math.max(1, round(drawing.height)),
        html: drawingDocument(drawing),
      })
      if (useStore.getState().canvas?.id !== target.canvasId) return
      recordCreate(frame)
      useStore.getState().upsertFrame(frame)
      if (useStore.getState().activePageId === target.pageId) useStore.getState().select(frame.id)
    }
  }
  return queueDrawingSave(save, 'Couldn’t save the drawing. Please try again.')
}

/** Creation and reparenting share a queue so consecutive gestures compose
 *  on the last saved document, even while the network is slow. */
export function queueDrawingSave(save: () => Promise<void>, fallback: string): Promise<void> {
  const pending = pendingDrawing.then(save).catch((err: unknown) => {
    useStore.getState().pushNotice(errorMessage(err, fallback))
  })
  pendingDrawing = pending
  trackSave(pending)
  return pending
}
