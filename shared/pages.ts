import type { Canvas, CanvasPageInfo, Frame } from './types.ts'

export function canvasPages(canvas: Pick<Canvas, 'id' | 'pages'>): CanvasPageInfo[] {
  return canvas.pages?.length ? canvas.pages : [{ id: `${canvas.id}:page1`, name: 'Page 1' }]
}

export function framePageId(canvas: Pick<Canvas, 'id' | 'pages'>, frame: Frame): string {
  return frame.pageId ?? canvasPages(canvas)[0]!.id
}

export function pageFrames(canvas: Pick<Canvas, 'id' | 'pages' | 'frames'>, pageId: string): Frame[] {
  return canvas.frames.filter((frame) => framePageId(canvas, frame) === pageId)
}

/** What deciding the page a canvas opens on reads: no frame HTML. */
export type LinkedCanvas = Pick<Canvas, 'id' | 'pages' | 'frames' | 'landingPageId'>

/** The page a link naming none opens: a library canvas's components page
 *  (the server says which, as `landingPageId`), else the first page. */
export function defaultPageId(canvas: LinkedCanvas): string {
  const pages = canvasPages(canvas)
  return pages.find((page) => page.id === canvas.landingPageId)?.id ?? pages[0]!.id
}

/** The page a canvas URL's query asks for: the page of the frame it links,
 *  else the page it names, else the default. A frame or page that is not on
 *  the canvas (deleted, mistyped) counts as not named. */
export function openingPageId(canvas: LinkedCanvas, search: string): string {
  const params = new URLSearchParams(search)
  const frameId = params.get('frame')
  const frame = frameId ? canvas.frames.find((candidate) => candidate.id === frameId) : undefined
  if (frame) return framePageId(canvas, frame)
  const pageId = params.get('page')
  if (pageId && canvasPages(canvas).some((page) => page.id === pageId)) return pageId
  return defaultPageId(canvas)
}

export const MAX_PAGE_NAME = 100
/** The longest canvas name an agent may give, the page limit's twin. */
export const MAX_CANVAS_NAME = 100

/** The name for a copy of `name`: "<name> copy", then "<name> copy 2", "… 3"
 *  while `taken` already holds it. The base is trimmed so the result fits
 *  the page name limit. */
export function copyPageName(name: string, taken: readonly string[]): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`
    const candidate = `${name.slice(0, MAX_PAGE_NAME - suffix.length).trimEnd()}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

export function samePages(a: unknown, b: CanvasPageInfo[]): boolean {
  return (
    Array.isArray(a) &&
    a.length === b.length &&
    a.every((page, i) => page?.id === b[i]!.id && page?.name === b[i]!.name)
  )
}

/** Apply one local page edit to the current list, preserving collaborators' additions. */
export function applyPageChanges(
  current: CanvasPageInfo[],
  from: CanvasPageInfo[],
  to: CanvasPageInfo[],
): CanvasPageInfo[] {
  let next = current.map((page) => ({ ...page }))
  for (const page of from) {
    const target = to.find((candidate) => candidate.id === page.id)
    const existing = next.find((candidate) => candidate.id === page.id)
    if (!target) {
      if (existing && existing.name !== page.name) throw new Error('This page was renamed by a collaborator.')
      next = next.filter((candidate) => candidate.id !== page.id)
    } else if (target.name !== page.name) {
      if (!existing) throw new Error('This page no longer exists.')
      if (existing.name !== page.name && existing.name !== target.name)
        throw new Error('This page was renamed by a collaborator.')
      existing.name = target.name
    }
  }
  for (const [index, page] of to.entries()) {
    if (from.some((candidate) => candidate.id === page.id)) continue
    const existing = next.find((candidate) => candidate.id === page.id)
    if (existing) {
      if (existing.name !== page.name) throw new Error('A different page already uses this ID.')
      continue
    }
    const following = to.slice(index + 1).find((candidate) => next.some((p) => p.id === candidate.id))
    const previous = to
      .slice(0, index)
      .reverse()
      .find((candidate) => next.some((p) => p.id === candidate.id))
    const position = following
      ? next.findIndex((p) => p.id === following.id)
      : previous
        ? next.findIndex((p) => p.id === previous.id) + 1
        : next.length
    next.splice(position, 0, { ...page })
  }
  const sharedIds = new Set(
    from.filter((page) => to.some((p) => p.id === page.id) && next.some((p) => p.id === page.id)).map((p) => p.id),
  )
  const originalOrder = from.filter((p) => sharedIds.has(p.id)).map((p) => p.id)
  const targetOrder = to.filter((p) => sharedIds.has(p.id)).map((p) => p.id)
  if (originalOrder.some((id, i) => id !== targetOrder[i])) {
    const currentOrder = next.filter((p) => sharedIds.has(p.id)).map((p) => p.id)
    if (
      JSON.stringify(currentOrder) !== JSON.stringify(originalOrder) &&
      JSON.stringify(currentOrder) !== JSON.stringify(targetOrder)
    )
      throw new Error('Page order changed. Please try again.')
    const ordered = targetOrder.map((id) => next.find((p) => p.id === id)!)
    let index = 0
    next = next.map((page) => (sharedIds.has(page.id) ? ordered[index++]! : page))
  }
  return next
}

/** The page components made from markup keep their mains on. */
export const COMPONENTS_PAGE = 'Components'

/** The page a library canvas opens on when its link names none: the one
 *  holding the most published components' mains (a tie goes to the page named
 *  "Components", then to page order). Undefined when no published component
 *  has a main frame on a page, and the canvas opens as any other does. */
export function libraryLandingPageId(
  canvas: Pick<Canvas, 'id' | 'pages' | 'frames' | 'components'>,
  publishedIds: readonly string[],
): string | undefined {
  const mains = new Map<string, number>()
  for (const def of canvas.components ?? []) {
    if (!def.mainFrameId || !publishedIds.includes(def.id)) continue
    const frame = canvas.frames.find((candidate) => candidate.id === def.mainFrameId)
    if (!frame) continue
    const pageId = framePageId(canvas, frame)
    mains.set(pageId, (mains.get(pageId) ?? 0) + 1)
  }
  let best: CanvasPageInfo | undefined
  for (const page of canvasPages(canvas)) {
    const count = mains.get(page.id) ?? 0
    if (!count) continue
    const lead = best ? (mains.get(best.id) ?? 0) : 0
    if (count > lead || (count === lead && page.name === COMPONENTS_PAGE && best?.name !== COMPONENTS_PAGE)) best = page
  }
  return best?.id
}
