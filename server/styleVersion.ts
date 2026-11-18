import type { Frame } from '../shared/types.ts'

/*
 * Whether a render of a frame is still current. A frame's own version is its
 * `updatedAt`; what the canvas supplies to it (token values, its components'
 * stylesheets, and their markup: a frame stores a reference to a component,
 * not its markup) changes without the frame being written, so a render also
 * records what it was supplied: the tokens the document names and the
 * components it uses, with the version each had. Versions are counters per
 * canvas, moved by the store when a token or a component's rules change. A
 * render is then retired by a change to something that frame uses, and by
 * nothing else on the canvas, and the check reads no frame HTML: the
 * dependencies were taken when the render read it.
 *
 * In memory: after a restart every cached render is unknown, as it always was.
 */

/** every token's theme blocks follow the canvas's theme list */
export const THEMES_DEPENDENCY = 'themes'
export const tokenDependency = (name: string) => `token:${name}`
export const componentDependency = (id: string) => `component:${id}`

const versions = new Map<string, Map<string, number>>()

/** Something frames are supplied with changed: renders that took it are stale. */
export function bumpStyle(canvasId: string, dependency: string): void {
  let ofCanvas = versions.get(canvasId)
  if (!ofCanvas) versions.set(canvasId, (ofCanvas = new Map()))
  ofCanvas.set(dependency, (ofCanvas.get(dependency) ?? 0) + 1)
}

export function forgetStyleVersions(canvasId: string): void {
  versions.delete(canvasId)
}

function versionsOf(canvasId: string, dependencies: readonly string[]): string {
  const ofCanvas = versions.get(canvasId)
  return dependencies.map((dependency) => ofCanvas?.get(dependency) ?? 0).join('.')
}

/** What a render was made from. `dependencies` are filled in when the render reads the
 *  frame's HTML (`stampDependencies`); until then only the frame's own version is known. */
export interface RenderStamp {
  updatedAt: number
  /** the frame's `rendered` mark: it was rendered again in memory, with no write, when a
   *  component it uses changed its markup (store.rerenderFrame) */
  rendered?: number
  dependencies?: readonly string[]
  versions?: string
}

export function renderStamp(frame: Pick<Frame, 'updatedAt' | 'rendered'>): RenderStamp {
  return { updatedAt: frame.updatedAt, ...(frame.rendered !== undefined ? { rendered: frame.rendered } : {}) }
}

/** Record what the render was supplied, as it stands now. */
export function stampDependencies(canvasId: string, stamp: RenderStamp, dependencies: readonly string[]): RenderStamp {
  stamp.dependencies = dependencies
  stamp.versions = versionsOf(canvasId, dependencies)
  return stamp
}

/** Is a render with this stamp what the frame would render to now? */
export function stampCurrent(
  frame: Pick<Frame, 'canvasId' | 'updatedAt' | 'rendered'>,
  stamp: RenderStamp | undefined,
): boolean {
  if (!stamp || stamp.updatedAt !== frame.updatedAt || stamp.rendered !== frame.rendered) return false
  return !stamp.dependencies || versionsOf(frame.canvasId, stamp.dependencies) === stamp.versions
}
