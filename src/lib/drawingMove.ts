import type { Frame } from '../../shared/types'
import { framePageId } from '../../shared/pages'
import { api, ApiError } from './api'
import { drawingDocument, isCanvasElement, queueDrawingSave, type Point } from './drawing'
import { recordCreate, recordDrawingTransfer, recordUpdates } from './history'
import { currentPageCanvas } from './pages'
import { useStore } from './store'
import { elementPath, uniqueIdsIn } from './layers'
import { carriedCss, newScope, renameInCss, SCOPE_ATTR, withCarriedCss } from './styleCarry'

export interface DrawingRect extends Point {
  width: number
  height: number
}

/** CSS layout size is distinct from the rendered bounds after a transform. */
export interface DrawingGeometry {
  width: number
  height: number
  offsetX: number
  offsetY: number
  styles: Record<string, string>
}

export interface DrawingHit {
  selector: string
  rect: DrawingRect
  geometry: DrawingGeometry
}

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const serialize = (doc: Document) => '<!doctype html>\n' + doc.documentElement.outerHTML

/** Inside a frame only drawings are eligible for canvas reparenting:
 *  imported content keeps its existing layout/drag behavior. A standalone
 *  element (no selector) is movable whatever it is — a lifted layer as much
 *  as a drawn shape. Locks apply through ancestors. */
export function movableDrawing(frame: Frame, selector?: string): HTMLElement | SVGSVGElement | null {
  if (frame.locked || frame.hidden) return null
  const doc = parse(frame.html)
  let el: Element | null
  try {
    el = selector ? (doc.querySelector(selector)?.closest('[data-doop-drawing]') ?? null) : doc.body.firstElementChild
  } catch {
    return null
  }
  if (!el || el.closest('[data-doop-locked], [data-doop-hidden]')) return null
  if (selector) return el.matches('[data-doop-drawing]') ? (el as HTMLElement | SVGSVGElement) : null
  if (!isCanvasElement(frame.html) || doc.body.children.length !== 1) return null
  return el as HTMLElement | SVGSVGElement
}

export function drawingDropFrame(point: Point, sourceId?: string): Frame | null {
  const hit = [...(currentPageCanvas()?.frames ?? [])]
    .reverse()
    .find(
      (f) =>
        f.id !== sourceId &&
        !f.hidden &&
        !isCanvasElement(f.html) &&
        point.x >= f.x &&
        point.y >= f.y &&
        point.x <= f.x + f.width &&
        point.y <= f.y + f.height,
    )
  return hit && !hit.locked ? hit : null
}

export function placeDrawing(
  el: HTMLElement | SVGSVGElement,
  rect: DrawingRect,
  frame?: Frame,
  geometry?: DrawingGeometry,
) {
  const style = el.style
  for (const [key, value] of Object.entries(geometry?.styles ?? {})) style.setProperty(key, value)
  style.position = frame ? 'fixed' : 'absolute'
  style.left = `${(frame ? rect.x - frame.x : 0) - (geometry?.offsetX ?? 0)}px`
  style.top = `${(frame ? rect.y - frame.y : 0) - (geometry?.offsetY ?? 0)}px`
  const fillsBox =
    !geometry ||
    (geometry.width === rect.width &&
      geometry.height === rect.height &&
      geometry.offsetX === 0 &&
      geometry.offsetY === 0)
  style.width = !frame && fillsBox ? '100%' : `${geometry?.width ?? rect.width}px`
  style.height = !frame && fillsBox ? '100%' : `${geometry?.height ?? rect.height}px`
  style.margin = '0'
}

/** Save the destination before removing the source. A failed source save
 *  rolls the destination back; an unsuccessful rollback keeps both copies. */
export function moveDrawing(
  pressed: Frame,
  selector: string | undefined,
  rect: DrawingRect,
  targetId?: string,
  hit?: DrawingHit,
): Promise<void> {
  const save = async () => {
    const s = useStore.getState()
    const canvas = s.canvas?.id === pressed.canvasId ? s.canvas : await api.getCanvas(pressed.canvasId)
    const source = canvas.frames.find((f) => f.id === pressed.id)
    if (
      !source ||
      source.html !== pressed.html ||
      source.pageId !== pressed.pageId ||
      ['x', 'y', 'width', 'height'].some(
        (key) => source[key as keyof DrawingRect] !== pressed[key as keyof DrawingRect],
      )
    ) {
      throw new Error('The drawing changed during the drag. Please try again.')
    }
    const el = movableDrawing(source, selector)
    if (!el) throw new Error('This drawing can no longer be moved.')
    const standalone = isCanvasElement(source.html)
    const pageId = framePageId(canvas, source)
    const target = targetId ? canvas.frames.find((f) => f.id === targetId) : undefined
    if (
      targetId &&
      (!target ||
        target.locked ||
        target.hidden ||
        isCanvasElement(target.html) ||
        framePageId(canvas, target) !== pageId)
    ) {
      throw new Error('The destination frame is no longer available.')
    }
    const active = () => useStore.getState().canvas?.id === source.canvasId
    /* `insert` adds a frame the store does not hold yet (a new destination);
       a conflict refresh passes false, so a frame the room has deleted in the
       meantime cannot come back from a late 409 */
    const updateLocal = (f: Frame, insert = true) => {
      if (!active()) return
      const current = useStore.getState().canvas?.frames.find((frame) => frame.id === f.id)
      if (current ? current.updatedAt <= f.updatedAt : insert) useStore.getState().upsertFrame(f)
    }
    const conditional = async <T>(frame: Frame, request: Promise<T>): Promise<T> => {
      try {
        return await request
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const remote = error.body.frame as Frame | undefined
          if (remote?.id === frame.id && remote.canvasId === frame.canvasId) updateLocal(remote, false)
        }
        throw error
      }
    }
    const select = (f: Frame, elementId?: string) => {
      if (!active() || useStore.getState().activePageId !== pageId) return
      useStore.getState().select(f.id)
      if (elementId) useStore.getState().pickElement({ frameId: f.id, selector: `#${elementId}` })
    }
    if (standalone && !target) {
      const position = hit
        ? { x: rect.x - hit.rect.x, y: rect.y - hit.rect.y, width: source.width, height: source.height }
        : rect
      const saved = await conditional(source, api.updateFrame(source.id, position, source.updatedAt))
      updateLocal(saved)
      if (active()) recordUpdates([{ frameId: source.id, before: source, after: position }])
      select(saved)
      return
    }

    // Keep the original markup, styling and SVG geometry when changing parents.
    const sourceDoc = parse(source.html)
    const original = selector
      ? sourceDoc.querySelector(selector)?.closest('[data-doop-drawing]')
      : sourceDoc.body.firstElementChild
    if (!original) return
    if (target?.id === source.id) {
      placeDrawing(original as HTMLElement | SVGSVGElement, rect, source, hit?.geometry)
      const html = serialize(sourceDoc)
      const saved = await conditional(source, api.updateFrame(source.id, { html }, source.updatedAt))
      updateLocal(saved)
      if (active()) recordUpdates([{ frameId: source.id, before: { html: source.html }, after: { html } }])
      return
    }
    /* the CSS the element relies on in its source comes along, scoped to
       it, as it does for a move through the Layers panel */
    const scope = newScope()
    let css = carriedCss(source.html, elementPath(original), scope)
    original.remove()
    const sourceHtml = serialize(sourceDoc)
    el.setAttribute(SCOPE_ATTR, scope)
    placeDrawing(el, rect, target, hit?.geometry)
    const destinationDoc = target ? parse(target.html) : parse(drawingDocument({ tool: 'frame', ...rect }))
    if (!target) {
      destinationDoc.body.style.background = ''
      destinationDoc.body.setAttribute('data-doop-canvas-element', 'true')
    }
    /* an element with an id of its own keeps it (its carried rules name it)
       unless the destination already uses it; then it, and any descendant
       id the destination uses, take a fresh name, references included */
    if (!el.id) el.id = `doop-drawing-${crypto.randomUUID()}`
    css = renameInCss(css, uniqueIdsIn(destinationDoc, el))
    destinationDoc.body.append(el)
    const html = withCarriedCss(serialize(destinationDoc), css, scope)
    const destination = target
      ? await conditional(target, api.updateFrame(target.id, { html }, target.updatedAt))
      : await api.createFrame(source.canvasId, {
          name: el.getAttribute('data-name') ?? 'Drawing',
          pageId,
          ...rect,
          html,
        })
    updateLocal(destination)
    let remaining: Frame | null = null
    try {
      const live = active() ? useStore.getState().canvas?.frames.find((f) => f.id === source.id) : source
      if (!live || live.html !== source.html || live.locked || live.hidden)
        throw new Error('The source changed during the move.')
      if (standalone) {
        await conditional(source, api.deleteFrame(source.id, source.updatedAt))
        if (active()) useStore.getState().removeFrame(source.id)
      } else {
        remaining = await conditional(source, api.updateFrame(source.id, { html: sourceHtml }, source.updatedAt))
        updateLocal(remaining)
      }
    } catch (err) {
      const latestCanvas = active() ? useStore.getState().canvas! : await api.getCanvas(source.canvasId)
      const latest = latestCanvas.frames.find((f) => f.id === destination.id)
      const changed =
        latest &&
        (['html', 'name', 'pageId', 'x', 'y', 'width', 'height', 'locked', 'hidden'] as const).some(
          (key) => latest[key] !== destination[key],
        )
      if (!target && changed) {
        if (active()) recordCreate(latest)
        throw new Error('The original could not be removed. The detached copy was kept because it was edited.', {
          cause: err,
        })
      }
      try {
        if (target) {
          if (latest) {
            let rollback = target.html
            if (latest.html !== destination.html) {
              // Another editor may have changed the destination while the
              // source request failed. Remove just our inserted drawing.
              const doc = parse(latest.html)
              doc.getElementById(el.id)?.remove()
              rollback = serialize(doc)
            }
            updateLocal(await conditional(latest, api.updateFrame(target.id, { html: rollback }, latest.updatedAt)))
          }
        } else if (latest) {
          await conditional(destination, api.deleteFrame(destination.id, destination.updatedAt))
          if (active()) useStore.getState().removeFrame(destination.id)
        }
      } catch (rollbackError) {
        if (rollbackError instanceof ApiError && rollbackError.status === 409) {
          // A whole-document undo would erase the same remote edit we just protected.
          throw new Error(
            'The destination changed during the move. Both copies were kept; remove the extra drawing manually.',
            { cause: rollbackError },
          )
        }
        if (active()) {
          if (target) recordUpdates([{ frameId: target.id, before: { html: target.html }, after: { html } }])
          else recordCreate(destination)
        }
        throw new Error('The drawing was copied, but its original could not be removed. You can undo the copy.', {
          cause: rollbackError,
        })
      }
      throw err
    }
    if (active())
      recordDrawingTransfer({ before: target ?? null, after: destination }, { before: source, after: remaining })
    select(destination, target ? el.id : undefined)
  }
  return queueDrawingSave(save, 'Couldn’t move the drawing. Please try again.')
}
