import type { Frame } from '../../shared/types'
import { api, ApiError } from './api'
import { isCanvasElement, pathData, pathDrawing, queueDrawingSave, type PathPoint, type Point } from './drawing'
import { recordUpdates } from './history'
import { requestFrame } from './frameBridge'
import { useStore } from './store'

export type PathMatrix = [number, number, number, number, number, number]
export interface EditablePath {
  points: PathPoint[]
  closed: boolean
}
export interface PathEditSource extends EditablePath {
  selector: string
  markup: string
  matrix: PathMatrix
  layoutMatrix: PathMatrix
  paint: { fill: string; stroke: string; strokeWidth: string }
}

export async function loadPathEdit(frame: Frame, where: Record<string, unknown>): Promise<PathEditSource | null> {
  const reply = await requestFrame(frame.id, 'doop:path', { ...where, standalone: isCanvasElement(frame.html) })
  const hit = reply?.hit as (Omit<PathEditSource, 'points' | 'closed' | 'markup'> & { data: string }) | undefined
  if (!hit) return null
  const parsed = parseEditablePath(hit.data)
  const doc = new DOMParser().parseFromString(frame.html, 'text/html')
  const svg = doc.querySelector(hit.selector)
  if (!parsed || !svg || svg.querySelector('path')?.getAttribute('d') !== hit.data) return null
  return { ...hit, ...parsed, markup: svg.outerHTML }
}

/** Read the absolute line/cubic commands written by the pen, including old paths. */
export function parseEditablePath(data: string): EditablePath | null {
  const token = /[MLCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g
  if (data.replace(token, '').replace(/[\s,]/g, '')) return null
  const tokens = data.match(token) ?? []
  let index = 0
  const point = (): Point | null => {
    const x = Number(tokens[index++])
    const y = Number(tokens[index++])
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
  }
  if (tokens[index++] !== 'M') return null
  const first = point()
  if (!first) return null
  const points: PathPoint[] = [first]
  let command = 'L'
  let closed = false
  while (index < tokens.length) {
    if (/^[MLCZ]$/.test(tokens[index]!)) command = tokens[index++]!
    if (command === 'Z') {
      if (index !== tokens.length) return null
      closed = true
      break
    }
    if (command === 'L') {
      const next = point()
      if (!next) return null
      points.push(next)
    } else if (command === 'C') {
      const a = point()
      const b = point()
      const next = point()
      if (!a || !b || !next) return null
      const previous = points.at(-1)!
      previous.handleOut =
        a.x === previous.x && a.y === previous.y ? undefined : { x: a.x - previous.x, y: a.y - previous.y }
      points.push({
        ...next,
        handleIn: b.x === next.x && b.y === next.y ? undefined : { x: b.x - next.x, y: b.y - next.y },
      })
    } else return null
  }
  const last = points.at(-1)!
  if (closed && points.length > 2 && last.x === first.x && last.y === first.y) {
    points[0]!.handleIn = last.handleIn
    points.pop()
  }
  return points.length >= 2 ? { points, closed } : null
}

export function editablePathData(path: EditablePath): string {
  return pathData({ tool: 'path', x: 0, y: 0, width: 0, height: 0, ...path })
}

export function mapPathPoint(point: Point, [a, b, c, d, e, f]: PathMatrix): Point {
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f }
}

export function unmapPathPoint(point: Point, [a, b, c, d, e, f]: PathMatrix): Point {
  const determinant = a * d - b * c
  return {
    x: (d * (point.x - e) - c * (point.y - f)) / determinant,
    y: (a * (point.y - f) - b * (point.x - e)) / determinant,
  }
}

/** Keep the path's affine transform while resizing its SVG viewport to fit new points. */
export function updatePathFrame(frame: Frame, source: PathEditSource, path: EditablePath): Partial<Frame> | null {
  const doc = new DOMParser().parseFromString(frame.html, 'text/html')
  const svg = doc.querySelector<SVGSVGElement>(source.selector)
  const element = svg?.querySelector('path')
  if (!svg || !element || svg.outerHTML !== source.markup || svg.closest('[data-doop-locked]')) return null
  const bounds = pathDrawing(path.points, path.closed)
  const standalone = isCanvasElement(frame.html)
  const matrix: PathMatrix = [...source.layoutMatrix]
  const patch: Partial<Frame> = {}
  if (standalone) {
    // Include the SVG's padding after rotation/scale so its stroke is not clipped.
    const corners = [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x, y: bounds.y + bounds.height },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    ].map((point) => mapPathPoint(point, source.matrix))
    const x = Math.min(...corners.map((point) => point.x))
    const y = Math.min(...corners.map((point) => point.y))
    patch.x = frame.x + x
    patch.y = frame.y + y
    patch.width = Math.max(...corners.map((point) => point.x)) - x
    patch.height = Math.max(...corners.map((point) => point.y)) - y
    matrix[4] -= x
    matrix[5] -= y
  }
  matrix[4] += matrix[0] * bounds.x + matrix[2] * bounds.y
  matrix[5] += matrix[1] * bounds.x + matrix[3] * bounds.y
  svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  Object.assign(svg.style, {
    position: standalone ? 'absolute' : 'fixed',
    left: '0px',
    top: '0px',
    margin: '0',
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    boxSizing: 'border-box',
    padding: '0',
    border: '0',
    transformOrigin: '0 0',
    transform: `matrix(${matrix.join(',')})`,
    translate: 'none',
    rotate: 'none',
    scale: 'none',
  })
  // The measured matrix already includes the path's own SVG transform.
  element.removeAttribute('transform')
  Object.assign(element.style, { transform: 'none', translate: 'none', rotate: 'none', scale: 'none' })
  element.setAttribute('d', editablePathData(path))
  patch.html = '<!doctype html>\n' + doc.documentElement.outerHTML
  return patch
}

export async function savePathEdit(frame: Frame, source: PathEditSource, path: EditablePath): Promise<Frame | null> {
  let saved: Frame | null = null
  await queueDrawingSave(async () => {
    const state = useStore.getState()
    const canvas = state.canvas?.id === frame.canvasId ? state.canvas : await api.getCanvas(frame.canvasId)
    const latest = canvas.frames.find((f) => f.id === frame.id)
    if (!latest || latest.locked || latest.hidden) throw new Error('The path is no longer editable.')
    const patch = updatePathFrame(latest, source, path)
    if (!patch) throw new Error('The path changed while you were editing. Reopen it to continue.')
    try {
      saved = await api.updateFrame(latest.id, patch, latest.updatedAt)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const remote = error.body.frame as Frame | undefined
        const current = useStore.getState()
        const local = current.canvas?.frames.find((f) => f.id === frame.id)
        if (
          current.canvas?.id === frame.canvasId &&
          remote?.id === frame.id &&
          remote.canvasId === frame.canvasId &&
          local &&
          remote.updatedAt > local.updatedAt
        )
          current.upsertFrame(remote)
      }
      throw error
    }
    if (useStore.getState().canvas?.id === frame.canvasId) {
      const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
      // A newer room update may arrive before this HTTP response.
      if (current && current.updatedAt <= saved.updatedAt) useStore.getState().upsertFrame(saved)
      recordUpdates([{ frameId: latest.id, before: latest, after: patch }])
    }
  }, 'Couldn’t save the path. Please try again.')
  return saved
}
