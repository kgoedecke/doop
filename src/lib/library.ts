import { useCallback, useEffect, useState } from 'react'
import { api, type CanvasLibrary, type ComponentLibrary } from './api'
import { useStore } from './store'

/** What the open canvas's workspace library offers it and expects of it, read
 *  again whenever a library publishes (the room says so) or the canvas's own
 *  components change, since either moves what is new, linked or out of date. */
/** What a canvas's library is waiting on someone for: changes it has not
 *  published, and published updates it has not pulled. */
export function libraryAttention(status: CanvasLibrary | null): { unpublished: number; updates: number } {
  if (!status?.entitled) return { unpublished: 0, updates: 0 }
  return {
    /* a canvas that never published owes nobody anything yet, and someone who
       may not publish is not the one its changes wait on */
    unpublished:
      status.library && status.canPublish ? status.changes.filter((entry) => entry.change !== 'unchanged').length : 0,
    updates: status.updates.length,
  }
}

/** Just the status, for chrome that only marks that something waits (the tab's dot). */
export function useLibraryStatus(canvasId: string | undefined): CanvasLibrary | null {
  const tick = useStore((s) => s.libraryTick)
  const components = useStore((s) => s.canvas?.components)
  const [loaded, setLoaded] = useState<{ canvasId: string; status: CanvasLibrary } | null>(null)
  useEffect(() => {
    if (!canvasId) return
    let live = true
    api
      .canvasLibrary(canvasId)
      .then((status) => live && setLoaded({ canvasId, status }))
      .catch(console.error)
    return () => {
      live = false
    }
  }, [canvasId, tick, components])
  return loaded && loaded.canvasId === canvasId ? loaded.status : null
}

export function useCanvasLibrary(canvasId: string, canEdit: boolean) {
  const tick = useStore((s) => s.libraryTick)
  const components = useStore((s) => s.canvas?.components)
  const [status, setStatus] = useState<CanvasLibrary | null>(null)
  const [libraries, setLibraries] = useState<ComponentLibrary[]>([])
  const [reloads, setReloads] = useState(0)
  const reload = useCallback(() => setReloads((count) => count + 1), [])

  useEffect(() => {
    let live = true
    api
      .canvasLibrary(canvasId)
      .then((next) => {
        if (!live) return
        setStatus(next)
        /* the listing walks other canvases: only for someone who can use it */
        if (!next.entitled || !canEdit) return setLibraries([])
        return api.componentLibraries(canvasId).then((all) => {
          if (live) setLibraries(all.filter((library) => library.library))
        })
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [canvasId, canEdit, tick, components, reloads])

  return { status, libraries, reload }
}

const UPSELL_KEY = 'doop:library-upsell'
/** The card comes back once, when a canvas has grown this many components. */
export const UPSELL_RETURN_AT = 5

type UpsellMemory = { dismissed: number }

/* what this page has dismissed, for a browser whose storage cannot be written
   (full, blocked, private mode): the card still goes away for the visit */
let dismissedHere = 0

function readStored(): number {
  try {
    const parsed = JSON.parse(localStorage.getItem(UPSELL_KEY) ?? 'null') as UpsellMemory | null
    return typeof parsed?.dismissed === 'number' ? parsed.dismissed : 0
  } catch {
    return 0
  }
}

function readUpsell(): UpsellMemory {
  return { dismissed: Math.max(readStored(), dismissedHere) }
}

/** Whether to show the library card: until dismissed, then once more for a
 *  canvas that has clearly taken to components, then never again. */
export function upsellVisible(componentCount: number): boolean {
  const { dismissed } = readUpsell()
  if (dismissed === 0) return true
  return dismissed === 1 && componentCount >= UPSELL_RETURN_AT
}

/** For tests: forget what this page dismissed. */
export function resetUpsellMemory() {
  dismissedHere = 0
}

export function dismissUpsell(componentCount: number) {
  const { dismissed } = readUpsell()
  /* dismissing it on a canvas already past the mark uses up the second showing too */
  const next = componentCount >= UPSELL_RETURN_AT ? 2 : Math.min(2, dismissed + 1)
  dismissedHere = next
  try {
    localStorage.setItem(UPSELL_KEY, JSON.stringify({ dismissed: next }))
  } catch {
    /* storage refused the write: the card returns on the next visit, not this one */
  }
}
