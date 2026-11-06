import type { Frame } from '../../shared/types'
import { api, ApiError } from './api'
import { isCanvasElement, queueDrawingSave, type Point } from './drawing'
import {
  apply,
  paddedBounds,
  parsePathData,
  strokePad,
  subpathsData,
  type Box,
  type Matrix,
  type Subpath,
} from './svgPath'
import { recordUpdates } from './history'
import { requestFrame } from './frameBridge'
import { useStore } from './store'

export type PathMatrix = Matrix
export interface EditablePath {
  /** Every stroke of the path: a compound path (a letter with a hole) has several. */
  subpaths: Subpath[]
}
export interface PathEditSource extends EditablePath {
  selector: string
  markup: string
  matrix: PathMatrix
  layoutMatrix: PathMatrix
  /** The layout box of the SVG's parent, when the SVG sits inside a group
   *  (an imported file's shape) rather than directly in the body. */
  parentBox?: Box
  paint: { fill: string; stroke: string; strokeWidth: string }
}

/** The one path a pen or imported shape's SVG draws: its direct `path` child. */
export function shapePath(svg: Element): SVGPathElement | null {
  const paths = [...svg.children].filter((child) => child.localName === 'path')
  return paths.length === 1 ? (paths[0] as SVGPathElement) : null
}

export async function loadPathEdit(frame: Frame, where: Record<string, unknown>): Promise<PathEditSource | null> {
  const reply = await requestFrame(frame.id, 'doop:path', where)
  const hit = reply?.hit as (Omit<PathEditSource, 'subpaths' | 'markup'> & { data: string }) | undefined
  if (!hit) return null
  const parsed = parseEditablePath(hit.data)
  const doc = new DOMParser().parseFromString(frame.html, 'text/html')
  const svg = doc.querySelector(hit.selector)
  if (!parsed || !svg || shapePath(svg)?.getAttribute('d') !== hit.data) return null
  return { ...hit, ...parsed, markup: svg.outerHTML }
}

/** Read any path data (the pen's absolute commands, or what a file or agent
 *  wrote) as editable subpaths; null when it is malformed or draws nothing. */
export function parseEditablePath(data: string): EditablePath | null {
  const subpaths = parsePathData(data)
  return subpaths ? { subpaths } : null
}

export function editablePathData(path: EditablePath): string {
  return subpathsData(path.subpaths)
}

export function mapPathPoint(point: Point, matrix: PathMatrix): Point {
  return apply(matrix, point)
}

export function unmapPathPoint(point: Point, [a, b, c, d, e, f]: PathMatrix): Point {
  const determinant = a * d - b * c
  return {
    x: (d * (point.x - e) - c * (point.y - f)) / determinant,
    y: (a * (point.y - f) - b * (point.x - e)) / determinant,
  }
}

/** A matrix that only scales along the axes (and, once shifted to the
 *  shell's origin, no longer translates): no rotation, skew or flip. */
function isAxisAligned([a, b, c, d]: PathMatrix): boolean {
  const epsilon = 1e-6
  return a > 0 && d > 0 && Math.abs(b) < epsilon && Math.abs(c) < epsilon
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

const pct = (value: number) => `${Math.round(value * 1000) / 1000}%`

/** Place a group's layer in percentages of the group's box, so the group's
 *  shell keeps scaling it. */
function placeInGroup(el: HTMLElement | SVGElement, box: Box, group: Box) {
  Object.assign(el.style, {
    left: pct(((box.x - group.x) / group.width) * 100),
    top: pct(((box.y - group.y) / group.height) * 100),
    width: pct((box.width / group.width) * 100),
    height: pct((box.height / group.height) * 100),
  })
}

/** When a group's box moves or grows, every layer laid out in percentages of
 *  it (an imported file's shapes) is re-placed so it stays where it was. */
function relayoutGroup(root: Element, from: Box, to: Box) {
  for (const el of root.querySelectorAll<HTMLElement | SVGElement>('[data-doop-drawing]')) {
    const style = el.style
    const values = [style.left, style.top, style.width, style.height]
    if (el.getAttribute('data-doop-drawing') === 'group' || !values.every((value) => value.endsWith('%'))) continue
    const [left, top, width, height] = values.map(parseFloat) as [number, number, number, number]
    placeInGroup(
      el,
      {
        x: from.x + (left / 100) * from.width,
        y: from.y + (top / 100) * from.height,
        width: (width / 100) * from.width,
        height: (height / 100) * from.height,
      },
      to,
    )
  }
}

/** The outermost group a nested shape belongs to: the import's root. */
function groupRoot(svg: Element): Element | null {
  let root: Element | null = null
  for (let el = svg.parentElement; el && el.getAttribute('data-doop-drawing') === 'group'; el = el.parentElement)
    root = el
  return root
}

/** Keep the path's affine transform while resizing its SVG viewport to fit new points. */
export function updatePathFrame(frame: Frame, source: PathEditSource, path: EditablePath): Partial<Frame> | null {
  const doc = new DOMParser().parseFromString(frame.html, 'text/html')
  const svg = doc.querySelector<SVGSVGElement>(source.selector)
  const element = svg && shapePath(svg)
  if (!svg || !element || svg.outerHTML !== source.markup || svg.closest('[data-doop-locked]')) return null
  const bounds = paddedBounds(path.subpaths, strokePad(source.paint.strokeWidth))
  const standalone = isCanvasElement(frame.html)
  const nested = svg.parentElement !== doc.body
  const matrix: PathMatrix = [...source.layoutMatrix]
  const patch: Partial<Frame> = {}
  const root = nested ? groupRoot(svg) : null
  if (nested && source.parentBox && root && isAxisAligned(matrix)) {
    /* an imported shape: its box in the group's layout px, laid out in
       percentages of the group so the group's shell goes on scaling it;
       a point dragged past the group's edge grows the group around it */
    const box: Box = {
      x: matrix[4] + matrix[0] * bounds.x,
      y: matrix[5] + matrix[3] * bounds.y,
      width: matrix[0] * bounds.width,
      height: matrix[3] * bounds.height,
    }
    let group = source.parentBox
    const grown = union(group, box)
    if (!sameBox(grown, group)) {
      const rootStyle = (root as HTMLElement).style
      if (standalone && root.parentElement === doc.body) {
        patch.x = frame.x + grown.x - group.x
        patch.y = frame.y + grown.y - group.y
        patch.width = grown.width
        patch.height = grown.height
        relayoutGroup(root, group, grown)
        group = grown
      } else if ([rootStyle.left, rootStyle.top, rootStyle.width, rootStyle.height].every((v) => v.endsWith('px'))) {
        rootStyle.left = `${parseFloat(rootStyle.left) + grown.x - group.x}px`
        rootStyle.top = `${parseFloat(rootStyle.top) + grown.y - group.y}px`
        rootStyle.width = `${grown.width}px`
        rootStyle.height = `${grown.height}px`
        relayoutGroup(root, group, grown)
        group = grown
      }
    }
    svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`)
    svg.setAttribute('preserveAspectRatio', 'none')
    Object.assign(svg.style, { position: 'absolute', margin: '0', overflow: 'visible', transform: 'none' })
    placeInGroup(svg, box, group)
  } else {
    if (standalone && !nested) {
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
    } else if (nested && source.parentBox) {
      matrix[4] -= source.parentBox.x
      matrix[5] -= source.parentBox.y
    }
    matrix[4] += matrix[0] * bounds.x + matrix[2] * bounds.y
    matrix[5] += matrix[1] * bounds.x + matrix[3] * bounds.y
    /* A standalone path that is not rotated or skewed keeps filling its shell,
       the way the drawing tool made it: the shell is exactly the scaled box,
       the viewBox stretches the path onto it, and the shell's grips (the only
       ones a standalone's root wears) keep resizing the path. A rotated or
       skewed one needs its own box and transform. */
    const fillsShell = standalone && !nested && isAxisAligned(matrix)
    svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`)
    svg.setAttribute('preserveAspectRatio', 'none')
    Object.assign(svg.style, {
      position: standalone || nested ? 'absolute' : 'fixed',
      left: '0px',
      top: '0px',
      margin: '0',
      width: fillsShell ? '100%' : `${bounds.width}px`,
      height: fillsShell ? '100%' : `${bounds.height}px`,
      boxSizing: 'border-box',
      padding: '0',
      border: '0',
      transformOrigin: '0 0',
      transform: fillsShell ? 'none' : `matrix(${matrix.join(',')})`,
      translate: 'none',
      rotate: 'none',
      scale: 'none',
    })
  }
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
