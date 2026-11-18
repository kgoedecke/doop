import { composedHtml } from '../server/frameCompose.ts'
import { store } from '../server/store.ts'

/** A frame's document as it is rendered: its stored HTML (the source, under lean
 *  storage) with the canvas's component stylesheets and token values composed in
 *  (server/frameCompose.ts). What a test of how a frame looks reads. */
export function renderedHtml(frameId: string): string {
  const frame = store.getFrame(frameId)!
  return composedHtml(frame.canvasId, frame.html)
}
