import type { Frame } from '../../shared/types'
import { api, errorMessage } from './api'
import { recordCreate, recordUpdates, trackSave } from './history'
import { currentPageCanvas } from './pages'
import { useStore } from './store'
import { currentPaper } from './paper'
import type { ResolvedTheme } from './theme'
import type { DrawingTool } from './tools'
import { paddedBounds, subpathsData } from './svgPath'

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
/** The dark theme's `--ink`, so text on bare canvas reads against its paper. */
export const DRAWING_INK_ON_DARK = '#f2f2f2'

/** A standalone element sits on the canvas paper, so its ink inverts with the
 *  paper's tone (the theme, or the page's own colour). Inside a frame the
 *  document's own background applies, and the frame cannot know the viewer's
 *  theme, so it keeps the dark ink. */
export function drawingInk(target: DrawingTarget, tone: ResolvedTheme): string {
  return !target.frameId && tone === 'dark' ? DRAWING_INK_ON_DARK : DRAWING_INK
}
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
  return { tool: 'path', ...paddedBounds([{ points, closed }], 2), points, closed }
}

export function pathData(drawing: Drawing): string {
  const points = drawing.points ?? []
  if (!points.length) return ''
  return subpathsData([{ points, closed: !!drawing.closed }], drawing)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** DOM creation keeps typed text literal, including HTML-looking strings. */
export function drawingElement(doc: Document, drawing: Drawing, standalone: boolean, ink = DRAWING_INK): Element {
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
    path.setAttribute('stroke', ink)
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    el.append(path)
  } else {
    const style = (el as HTMLElement).style
    if (drawing.tool === 'text') {
      style.cssText += `font:24px/1.4 Arial,sans-serif;color:${ink};white-space:pre-wrap;overflow-wrap:anywhere;`
      el.textContent = drawing.text ?? ''
    } else {
      style.background = DRAWING_FILL
      if (drawing.tool === 'circle') style.borderRadius = '50%'
    }
  }
  return el
}

export function drawingDocument(drawing: Drawing, ink = DRAWING_INK): string {
  const doc = new DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html')
  doc.documentElement.style.cssText = 'width:100%;height:100%;margin:0;'
  doc.body.style.cssText = 'width:100%;height:100%;margin:0;'
  if (drawing.tool === 'frame') doc.body.style.background = '#ffffff'
  else {
    doc.body.setAttribute('data-doop-canvas-element', 'true')
    doc.body.append(drawingElement(doc, drawing, true, ink))
  }
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

/** Read the current document when committing, so edits received during the
 *  gesture survive. Use the normal API for collaboration and tracked history. */
export function saveDrawing(drawing: Drawing, target: DrawingTarget): Promise<void> {
  // Read now, not when the queue reaches this save: the ink matches the paper the person drew on.
  const ink = drawingInk(target, currentPaper(target.pageId).tone)
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
        html: drawingDocument(drawing, ink),
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
