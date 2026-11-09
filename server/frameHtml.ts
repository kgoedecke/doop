import type { Frame } from '../shared/types.ts'

/**
 * A frame's `html` is the one field the server does not keep for every
 * canvas: boot reads frames without it, and `store.load` fills it in per
 * canvas when something needs the canvas (see store.ts). Until then the
 * property is an accessor that throws on read, so a code path that forgot to
 * load fails loudly instead of seeing an empty design and saving it back.
 * Assigning `html` always works: a write replaces the whole document, so it
 * needs nothing loaded first.
 */

export class FrameHtmlNotLoadedError extends Error {
  constructor(
    readonly frameId: string,
    readonly canvasId: string,
  ) {
    super(
      `frame ${frameId}'s HTML was read before canvas ${canvasId} was loaded — await store.load(canvasId) at the entry point`,
    )
    this.name = 'FrameHtmlNotLoadedError'
  }
}

/** Called on every read of an unloaded frame's html, so the store can start
 *  loading that canvas and a retry succeeds. */
let onMiss: (canvasId: string) => void = () => {}

export function setHtmlMissHandler(handler: (canvasId: string) => void) {
  onMiss = handler
}

export function setHtml(frame: Frame, html: string) {
  Object.defineProperty(frame, 'html', { value: html, writable: true, enumerable: true, configurable: true })
}

export function unloadHtml(frame: Frame) {
  Object.defineProperty(frame, 'html', {
    enumerable: true,
    configurable: true,
    get() {
      onMiss(frame.canvasId)
      throw new FrameHtmlNotLoadedError(frame.id, frame.canvasId)
    },
    set(html: string) {
      setHtml(frame, html)
    },
  })
}

export function htmlLoaded(frame: Frame): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(frame, 'html')
  return descriptor !== undefined && 'value' in descriptor
}

/** A standalone copy of a frame carrying `html`, for a render of one frame
 *  whose canvas is not loaded. Spreading the frame would read its html. */
export function withHtml(frame: Frame, html: string): Frame {
  const copy = {} as Frame
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(frame))) {
    if (key !== 'html') Object.defineProperty(copy, key, descriptor)
  }
  setHtml(copy, html)
  return copy
}
