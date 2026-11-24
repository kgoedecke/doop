import type { Frame, WireFrame } from '../shared/types.ts'

/**
 * A frame's `html` is the one field the server does not keep for every
 * canvas: boot reads frames without it, and `store.loadPages` fills it in per
 * page when something needs the page (see store.ts). Until then the
 * property is an accessor that throws on read, so a code path that forgot to
 * load fails loudly instead of seeing an empty design and saving it back.
 * Assigning `html` always works: a write replaces the whole document, so it
 * needs nothing loaded first.
 */

export class FrameHtmlNotLoadedError extends Error {
  readonly frameId: string
  readonly canvasId: string

  constructor(frameId: string, canvasId: string) {
    super(
      `frame ${frameId}'s HTML was read before its page of canvas ${canvasId} was loaded — await store.loadPages (or store.load) at the entry point`,
    )
    this.frameId = frameId
    this.canvasId = canvasId

    this.name = 'FrameHtmlNotLoadedError'
  }
}

/** Called on every read of an unloaded frame's html, so the store can start
 *  loading that frame's page and a retry succeeds. */
let onMiss: (canvasId: string, frameId: string) => void = () => {}

export function setHtmlMissHandler(handler: (canvasId: string, frameId: string) => void) {
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
      onMiss(frame.canvasId, frame.id)
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

/** A frame's fields without `html`, for a room message to a browser that has
 *  not loaded the frame's page. Never reads the html, loaded or not. */
export function frameMeta(frame: WireFrame): WireFrame {
  const meta: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(frame))) {
    if (key !== 'html' && 'value' in descriptor) meta[key] = descriptor.value
  }
  return meta as WireFrame
}

/** The frame carries its html: a loaded frame, or a copy made with it. */
export function carriesHtml(frame: WireFrame): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(frame, 'html')
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
}
