import {
  composeFrameHtml,
  sharedDependencies,
  sourceOf,
  type ComposeOptions,
  type FrameResources,
} from '../shared/frameCompose.ts'
import {
  THEMES_DEPENDENCY,
  componentDependency,
  stampDependencies,
  tokenDependency,
  type RenderStamp,
} from './styleVersion.ts'
import type { Canvas, Frame, WireFrame } from '../shared/types.ts'
import { env } from './env.ts'
import { carriesHtml, withHtml } from './frameHtml.ts'
import { store } from './store.ts'

/**
 * Where the server turns a frame's stored HTML (its source) into the document
 * someone renders, and back (shared/frameCompose.ts). Stored HTML carries no
 * component stylesheets, component head tags or token block; a frame stored
 * before that still carries them, stale or not, and composes to the same
 * document. `DOOP_LEAN_FRAME_STORAGE=false` is the temporary switch back to
 * storing the composed document; reads compose either way.
 */

export function resourcesOf(canvas: Pick<Canvas, 'tokens' | 'tokenThemes' | 'components'>): FrameResources {
  return { tokens: canvas.tokens ?? [], themes: canvas.tokenThemes ?? [], components: canvas.components ?? [] }
}

/** The self-contained document for HTML of this canvas: what a renderer, an
 *  export or a client that cannot compose is handed. */
export function composedHtml(canvasId: string, html: string, options?: ComposeOptions): string {
  const canvas = store.getCanvas(canvasId)
  return canvas ? composeFrameHtml(html, resourcesOf(canvas), options) : html
}

/** A copy of the frame carrying its composed document; the frame itself when
 *  composing changes nothing, or it carries no HTML. */
export function composedFrame<F extends WireFrame>(frame: F, options?: ComposeOptions): F {
  if (!carriesHtml(frame)) return frame
  const source = frame.html as string
  const html = composedHtml(frame.canvasId, source, options)
  return html === source ? frame : (withHtml(frame as unknown as Frame, html) as unknown as F)
}

/** HTML of this canvas without what the canvas supplies to every frame. */
export function sourceHtml(canvasId: string, html: string): string {
  return sourceOf(html, store.getCanvas(canvasId)?.components ?? [])
}

/** A prepared (composed) document as the store keeps it: its source, unless
 *  lean storage is switched off. */
export function storedHtml(canvasId: string, composed: string): string {
  return env.DOOP_LEAN_FRAME_STORAGE ? sourceHtml(canvasId, composed) : composed
}

/** Would storing `next` (already in stored form) change this frame? A frame still holding
 *  blocks from before lean storage is unchanged when its source is: a shared-style change
 *  is no reason to write it. */
export function sameStored(canvasId: string, next: string, current: string): boolean {
  if (next === current) return true
  return env.DOOP_LEAN_FRAME_STORAGE && next === sourceHtml(canvasId, current)
}

/* Documents that are whole as given (a print shell, a component preview sheet):
   a renderer loads them as written, with nothing of the canvas composed in. */
const wholeDocuments = new WeakSet<object>()

/** Mark a frame-shaped document as already whole: the renderer (server/screenshot.ts)
 *  loads its HTML as given. The mark is the object's, so a copy of it is composed again. */
export function wholeDocument<F extends Frame>(frame: F): F {
  wholeDocuments.add(frame)
  return frame
}

export function isWholeDocument(frame: Frame): boolean {
  return wholeDocuments.has(frame)
}

/** Fill in what a render of this frame is supplied by its canvas, now that its HTML is at
 *  hand (server/styleVersion.ts): the stamp then goes stale when one of those changes. */
export function stampRender(stamp: RenderStamp, source: Frame): RenderStamp {
  const canvas = store.getCanvas(source.canvasId)
  if (!canvas || !source.html) return stampDependencies(source.canvasId, stamp, [])
  const { tokens, components } = sharedDependencies(source.html, resourcesOf(canvas))
  return stampDependencies(source.canvasId, stamp, [
    ...(tokens.length ? [THEMES_DEPENDENCY] : []),
    ...tokens.map(tokenDependency),
    ...components.map(componentDependency),
  ])
}
