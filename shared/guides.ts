import type { CanvasGuide } from './types.ts'

/** Guides one canvas may hold across all of its pages. */
export const MAX_GUIDES = 500
/** How far from the world origin a guide may sit, in world px. */
export const MAX_GUIDE_POSITION = 1_000_000

const GUIDE_ID = /^[\w-]{1,40}$/

export function isGuideId(value: unknown): value is string {
  return typeof value === 'string' && GUIDE_ID.test(value)
}

/** A guide position is kept to a hundredth of a world px: finer than any
 *  zoom can show, coarse enough that a round trip compares equal. */
export function roundGuidePosition(at: number): number {
  return Math.round(at * 100) / 100
}

/** The guide a request body describes, or a message saying what is wrong
 *  with it. `pageIds` are the pages the canvas has. */
export function parseGuide(id: unknown, body: unknown, pageIds: readonly string[]): CanvasGuide | string {
  if (!isGuideId(id)) return 'A guide id is 1–40 letters, digits, dashes or underscores.'
  const input = (body ?? {}) as Partial<Record<keyof CanvasGuide, unknown>>
  if (input.axis !== 'v' && input.axis !== 'h') return "A guide's axis is 'v' or 'h'."
  if (typeof input.at !== 'number' || !Number.isFinite(input.at) || Math.abs(input.at) > MAX_GUIDE_POSITION)
    return `A guide sits within ${MAX_GUIDE_POSITION}px of the origin.`
  if (typeof input.pageId !== 'string' || !pageIds.includes(input.pageId)) return 'page not found'
  return { id, pageId: input.pageId, axis: input.axis, at: roundGuidePosition(input.at) }
}

export function sameGuide(a: CanvasGuide | null | undefined, b: CanvasGuide | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.id === b.id && a.pageId === b.pageId && a.axis === b.axis && a.at === b.at
}
