import { normalizeRotation } from '../shared/frameRotation.ts'
import * as actions from './actions.ts'
import { PageLimitError } from './store.ts'
import { canvasPages, framePageId, samePages } from '../shared/pages.ts'
import type { Actor, Canvas, CanvasPageInfo, Frame } from '../shared/types.ts'

/**
 * The page tools every agent gets, whether it connects over MCP
 * (server/mcp.ts) or runs in the server (server/resident.ts): one set of
 * checks for adding a page, saving the page list and moving a frame, so the
 * two surfaces cannot drift apart.
 */

export type PageToolResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type FrameMetaPatch = Partial<
  Pick<Frame, 'name' | 'pageId' | 'x' | 'y' | 'width' | 'height' | 'locked' | 'rotation'>
>

/** The canvas's pages as a tool reports them: id and name, in order. */
export function pageList(canvas: Canvas): CanvasPageInfo[] {
  return canvasPages(canvas).map(({ id, name }) => ({ id, name }))
}

function pageListText(canvas: Canvas): string {
  return pageList(canvas)
    .map((page) => `${page.id} ("${page.name}")`)
    .join(', ')
}

/** Add an empty page at the end of the canvas. */
export function addPage(
  canvasId: string,
  name: string,
  actor: Actor,
): PageToolResult<{ page: CanvasPageInfo; pages: CanvasPageInfo[] }> {
  try {
    const created = actions.createCanvasPage(canvasId, name, actor)
    return created ? { ok: true, value: created } : { ok: false, error: 'canvas not found' }
  } catch (e) {
    if (e instanceof PageLimitError) return { ok: false, error: e.message }
    throw e
  }
}

/** Rename, reorder or delete pages by saving the whole ordered list. Refused when
 *  `expected` is not the list as it stands (a collaborator changed it since it
 *  was read) or when a dropped page still holds frames. */
export function savePages(
  canvas: Canvas,
  expected: unknown,
  pages: CanvasPageInfo[],
  actor: Actor,
): PageToolResult<CanvasPageInfo[]> {
  if (!samePages(expected, canvasPages(canvas)))
    return { ok: false, error: `Pages changed. The pages are now: ${pageListText(canvas)}. Retry with that list.` }
  if (new Set(pages.map((p) => p.id)).size !== pages.length) return { ok: false, error: 'Page IDs must be unique' }
  const stranded = canvas.frames.find((f) => !pages.some((p) => p.id === framePageId(canvas, f)))
  if (stranded)
    return {
      ok: false,
      error: `Move frames before deleting their page: "${stranded.name}" (${stranded.id}) is still on it — move it with update_frame's pageId`,
    }
  return { ok: true, value: actions.setCanvasPages(canvas.id, pages, actor) }
}

/** A frame metadata patch as the store takes it: unset fields dropped, the
 *  page checked against the canvas and the rotation normalised. Empty is
 *  refused unless `allowEmpty` (a fit adds the height afterwards). */
export function checkFrameMeta(
  canvas: Canvas,
  patch: FrameMetaPatch,
  { allowEmpty = false } = {},
): PageToolResult<FrameMetaPatch> {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as FrameMetaPatch
  if (!allowEmpty && !Object.keys(clean).length) return { ok: false, error: 'nothing to update' }
  if (clean.pageId !== undefined && !canvasPages(canvas).some((p) => p.id === clean.pageId))
    return { ok: false, error: frameMetaError({ unknownPage: clean.pageId }, canvas) }
  if (clean.rotation !== undefined) {
    if (!Number.isFinite(clean.rotation)) return { ok: false, error: 'rotation must be a finite number of degrees' }
    clean.rotation = normalizeRotation(clean.rotation)
  }
  return { ok: true, value: clean }
}

/** Rename, move, resize or (un)lock a frame, or move it to another page. */
export function updateFrameMeta(
  canvas: Canvas,
  frameId: string,
  patch: FrameMetaPatch,
  actor: Actor,
): PageToolResult<Frame> {
  const checked = checkFrameMeta(canvas, patch)
  if (!checked.ok) return checked
  const frame = actions.updateFrame(frameId, checked.value, actor)
  return frame ? { ok: true, value: frame } : { ok: false, error: `frame ${frameId} not found` }
}

/** A refused metadata patch in the words the tools answer it with. */
export function frameMetaError(refusal: { unknownPage: string }, canvas: Canvas): string {
  return `no page ${refusal.unknownPage} on this canvas — the pages are: ${pageListText(canvas)}`
}
