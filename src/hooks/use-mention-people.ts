import { useEffect, useSyncExternalStore } from 'react'
import { api, type CanvasPerson } from '../lib/api'
import { canCommentOpenCanvas, useStore } from '../lib/store'

/* The people on a canvas change when someone is invited or removed, so every
   field that mounts asks again; the last answer shows meanwhile, and
   requests made at once share one call, and an answer redraws every reader
   (a thread's comments read what its reply field asked for). A stale list
   only costs the picker a name: the server reads mentions against the
   current people. */
const lastKnown = new Map<string, CanvasPerson[]>()
const inFlight = new Map<string, Promise<CanvasPerson[] | null>>()
const listeners = new Set<() => void>()
const NOBODY: CanvasPerson[] = []

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function askPeople(canvasId: string): Promise<CanvasPerson[] | null> {
  let pending = inFlight.get(canvasId)
  if (!pending) {
    pending = api
      .canvasPeople(canvasId)
      .then((people) => {
        lastKnown.set(canvasId, people)
        for (const listener of listeners) listener()
        return people
      })
      /* a failure keeps the last answer; the next field to mount asks again */
      .catch(() => null)
      .finally(() => inFlight.delete(canvasId))
    inFlight.set(canvasId, pending)
  }
  return pending
}

/** The people a comment on the open canvas may @mention; empty for someone
 *  who may not comment, and until the list first arrives. `ask: false` only
 *  reads what a field asked for (a comment's text, drawn many times over). */
export function useMentionPeople({ ask = true }: { ask?: boolean } = {}): CanvasPerson[] {
  const canvasId = useStore((s) => s.canvas?.id)
  const canComment = useStore(canCommentOpenCanvas)
  const known = useSyncExternalStore(subscribe, () => (canvasId ? lastKnown.get(canvasId) : undefined))
  useEffect(() => {
    if (canvasId && canComment && ask) void askPeople(canvasId)
  }, [canvasId, canComment, ask])
  if (!canvasId || !canComment) return NOBODY
  return known ?? NOBODY
}
