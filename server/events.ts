import type { ActorKind, ElementComment, Frame } from '../shared/types.ts'

/**
 * Canvas events, for the things that happen AFTER a mutation has been stored
 * and broadcast to the room: email, outbound webhooks, anything that tells
 * people who are not looking at the canvas right now. The room itself never
 * goes through here — the ws broadcast is the mutation's own job.
 *
 * Emitted from the action layer (one call per mutation, so REST and MCP both
 * fire it); listeners register at boot. A listener that throws is logged and
 * skipped: a broken notifier must never fail the comment it was told about.
 */
export type CanvasEvent =
  | { type: 'comment.created'; comment: ElementComment; frame: Frame; actorKind: ActorKind }
  | { type: 'comment.replied'; comment: ElementComment; frame: Frame; actorKind: ActorKind }

export type CanvasEventListener = (canvasId: string, event: CanvasEvent) => void

const listeners = new Set<CanvasEventListener>()

/** Observe every canvas event; returns the unsubscribe. */
export function onCanvasEvent(listener: CanvasEventListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitCanvasEvent(canvasId: string, event: CanvasEvent): void {
  for (const listener of listeners) {
    try {
      listener(canvasId, event)
    } catch (err) {
      console.error(`[events] ${event.type} listener failed`, err)
    }
  }
}
