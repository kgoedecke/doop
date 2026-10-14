import type { Canvas, CanvasPageInfo, Frame } from './types.ts'

export function canvasPages(canvas: Pick<Canvas, 'id' | 'pages'>): CanvasPageInfo[] {
  return canvas.pages?.length ? canvas.pages : [{ id: `${canvas.id}:page1`, name: 'Page 1' }]
}

export function framePageId(canvas: Pick<Canvas, 'id' | 'pages'>, frame: Frame): string {
  return frame.pageId ?? canvasPages(canvas)[0]!.id
}

export function pageFrames(canvas: Canvas, pageId: string): Frame[] {
  return canvas.frames.filter((frame) => framePageId(canvas, frame) === pageId)
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
