import { create } from 'zustand'
import type { Frame } from '../../shared/types'
import { api, ApiError } from './api'
import { useStore } from './store'
import { recordUpdate, trackSave } from './history'
import { designSelector, editDesign, parseDesign, sourceElement, type DesignEdit } from './designDocument'

export interface ElementSelection {
  frameId: string
  selector: string
  identity: string
  fallback?: { selector: string; identity: string }
}
export interface ElementInspection {
  /** Source and viewport that produced these measured bounds. */
  rendered?: { html: string; width: number; height: number }
  selector: string
  styles: Record<string, string>
  rect: { x: number; y: number; width: number; height: number }
}

interface EditorState {
  selection: ElementSelection | null
  inspection: ElementInspection | null
  layersOpen: boolean
  busy: boolean
  error: string | null
  saved: boolean
  inlineFrameId: string | null
  unsavedHtml: Record<string, string>
  setLayersOpen(open: boolean): void
}

function preference(key: string, fallback: boolean): boolean {
  try {
    return localStorage.getItem(key) === null ? fallback : localStorage.getItem(key) === '1'
  } catch {
    return fallback
  }
}

export const useDesignEditor = create<EditorState>((set) => ({
  selection: null,
  inspection: null,
  layersOpen: preference('doop:layers-open', true),
  busy: false,
  error: null,
  saved: false,
  inlineFrameId: null,
  unsavedHtml: {},
  setLayersOpen: (layersOpen) => {
    set({ layersOpen })
    try {
      localStorage.setItem('doop:layers-open', layersOpen ? '1' : '0')
    } catch {
      /* private storage */
    }
  },
}))

export function selectDesignElement(frameId: string, selector: string) {
  const frame = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
  const el = frame ? sourceElement(parseDesign(frame.html), selector) : null
  useStore.getState().select(frameId)
  useStore.getState().setInspectorOpen(true)
  useDesignEditor.setState({
    selection: el ? { frameId, selector: designSelector(el), identity: el.outerHTML } : null,
    inspection: null,
    error: el ? null : 'This element is generated at runtime. Choose a source layer in Layers.',
  })
}

export function selectDesignFrame(frameId: string) {
  useDesignEditor.setState({ selection: null, inspection: null, error: null })
  useStore.getState().select(frameId)
  useStore.getState().setInspectorOpen(true)
}

useStore.subscribe((state, before) => {
  if (state.canvas?.id !== before.canvas?.id || state.selectedId !== before.selectedId) {
    useDesignEditor.setState({ selection: null, inspection: null, error: null, saved: false })
  } else {
    const selection = useDesignEditor.getState().selection
    const frame = selection?.fallback && state.canvas?.frames.find((item) => item.id === selection.frameId)
    const previous = selection && before.canvas?.frames.find((item) => item.id === selection.frameId)
    if (frame && frame.html !== previous?.html && selection?.fallback) {
      const doc = parseDesign(frame.html)
      const current = sourceElement(doc, selection.selector)
      if (!current || (!anchored(selection.selector) && current.outerHTML !== selection.identity)) {
        const fallback = sourceElement(doc, selection.fallback.selector)
        if (fallback && (anchored(selection.fallback.selector) || fallback.outerHTML === selection.fallback.identity)) {
          useDesignEditor.setState({
            selection: {
              frameId: frame.id,
              selector: selection.fallback.selector,
              identity: fallback.outerHTML,
              fallback: { selector: selection.selector, identity: selection.identity },
            },
            inspection: null,
          })
        }
      }
    }
  }
})

function anchored(selector: string) {
  return selector.startsWith('[data-doop-node=') || selector.startsWith('#')
}

/** An unanchored positional selector must never silently retarget after a remote edit. */
export function currentSourceElement(html: string, selection: ElementSelection) {
  const el = sourceElement(parseDesign(html), selection.selector)
  if (!el) return null
  if (!anchored(selection.selector) && el.outerHTML !== selection.identity) return null
  return el
}

export function commitDesignEdit(frameId: string, selector: string, edit: DesignEdit): Promise<void> {
  const frame = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
  if (!frame) return Promise.resolve()
  const selected = useDesignEditor.getState().selection
  try {
    if (useDesignEditor.getState().inlineFrameId === frameId)
      throw new Error('Finish text editing before changing this layer.')
    if (
      selected?.frameId === frameId &&
      selected.selector === selector &&
      !currentSourceElement(frame.html, selected)
    ) {
      throw new Error('This layer changed. Select it again in Layers before editing.')
    }
    if (useStore.getState().streams[frameId])
      throw new Error('An agent is updating this frame. Try again when it finishes.')
    const result = editDesign(frame.html, selector, edit)
    if (result.html === frame.html) return Promise.resolve()
    const el = sourceElement(parseDesign(result.html), result.selector)
    const follows = useStore.getState().selectedId === frameId && (!selected || selected.selector === selector)
    if (follows && el) {
      useDesignEditor.setState({
        selection: {
          frameId,
          selector: result.selector,
          identity: el.outerHTML,
          fallback:
            selected && result.selector !== selected.selector
              ? { selector: selected.selector, identity: selected.identity }
              : selected?.fallback,
        },
      })
    }
    let accepted = false
    return saveDesignPatch(frameId, { html: result.html }, () => {
      accepted = true
    }).then(() => {
      const current = useDesignEditor.getState().selection
      if (!accepted && follows && current?.frameId === frameId && current.selector === result.selector) {
        useDesignEditor.setState({ selection: selected, inspection: null })
      }
    })
  } catch (err) {
    useDesignEditor.setState({ error: err instanceof Error ? err.message : 'Could not edit this layer.' })
    return Promise.resolve()
  }
}

let saveQueue: Promise<void> = Promise.resolve()
let queuedWrites = 0

interface SaveBatch {
  confirmed: Frame
  pending: number
  blockedHtml: boolean
  error?: string
  latestHtml?: string
  optimisticHtml: Set<string>
}
const saveBatches = new Map<string, SaveBatch>()

export function dismissUnsavedHtml(frameId: string) {
  useDesignEditor.setState((state) => {
    const unsavedHtml = { ...state.unsavedHtml }
    delete unsavedHtml[frameId]
    return { unsavedHtml }
  })
}

/** One write at a time, optimistic local rendering, rollback on error, and a
 * compare-and-swap HTML precondition so remote work is never silently replaced. */
export function saveDesignPatch(frameId: string, patch: Partial<Frame>, onSuccess?: () => void): Promise<void> {
  const before = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
  if (!before) return Promise.resolve()
  if (Object.entries(patch).every(([key, value]) => before[key as keyof Frame] === value)) return Promise.resolve()
  const key = `${before.canvasId}:${frameId}`
  const batch: SaveBatch = saveBatches.get(key) ?? {
    confirmed: before,
    pending: 0,
    blockedHtml: false,
    optimisticHtml: new Set<string>(),
  }
  saveBatches.set(key, batch)
  batch.pending++
  if (patch.html !== undefined) {
    batch.latestHtml = patch.html
    batch.optimisticHtml.add(patch.html)
  }
  useDesignEditor.setState({ busy: true, error: null, saved: false })
  queuedWrites++
  useStore.getState().patchFrameLocal(frameId, patch)
  const pending = saveQueue
    .then(async () => {
      // Resolve the precondition and undo baseline at dispatch, after earlier
      // writes have settled. Never use an earlier optimistic enqueue snapshot.
      const baseline = batch.confirmed
      let accepted = false
      let failure: unknown
      const currentHtml = useStore.getState().canvas?.frames.find((frame) => frame.id === frameId)?.html
      if (
        patch.html !== undefined &&
        currentHtml !== undefined &&
        currentHtml !== baseline.html &&
        !batch.optimisticHtml.has(currentHtml)
      ) {
        batch.blockedHtml = true
        batch.error =
          'This frame changed while an edit was queued. Recover your unsaved HTML and review the latest source.'
      }
      if (patch.html !== undefined && batch.blockedHtml) {
        failure = new Error(batch.error || 'An earlier save could not be confirmed. Recover your unsaved HTML below.')
      } else {
        try {
          const updated = await api.updateFrame(frameId, patch, patch.html !== undefined ? baseline.html : undefined)
          batch.confirmed = { ...baseline, ...patch, ...updated }
          accepted = true
        } catch (err) {
          failure = err
          try {
            const latest = await api.getCanvas(before.canvasId)
            const updated = latest.frames.find((frame) => frame.id === frameId)
            if (!updated) throw new Error('The frame no longer exists.', { cause: err })
            batch.confirmed = updated
            // A transport/server error can lose the response to a committed
            // write. An explicit client rejection (including 409) cannot.
            const rejected = err instanceof ApiError && err.status >= 400 && err.status < 500
            accepted = !rejected && Object.entries(patch).every(([key, value]) => updated[key as keyof Frame] === value)
            if (!accepted && updated.html !== baseline.html) batch.blockedHtml = true
          } catch {
            // Offline or deleted: retain the latest draft instead of guessing
            // a new base for dependent HTML and potentially replacing remote work.
            batch.blockedHtml = true
          }
        }
      }
      if (accepted) {
        if (useStore.getState().canvas?.id === before.canvasId) {
          recordUpdate(frameId, baseline, patch, false)
          onSuccess?.()
          if (!batch.blockedHtml) useDesignEditor.setState({ saved: true, error: null })
        }
        if (patch.html !== undefined && useDesignEditor.getState().unsavedHtml[frameId] === patch.html)
          dismissUnsavedHtml(frameId)
        return
      }
      const current = useStore.getState().canvas?.frames.find((f) => f.id === frameId)
      if (current) {
        const rollback = Object.fromEntries(
          Object.keys(patch)
            .filter(
              (key) =>
                current[key as keyof Frame] === patch[key as keyof Frame] ||
                (key === 'html' && batch.blockedHtml && batch.optimisticHtml.has(current.html)),
            )
            .map((key) => [key, batch.confirmed[key as keyof Frame]]),
        )
        useStore.getState().patchFrameLocal(frameId, rollback)
      }
      batch.error =
        failure instanceof ApiError && typeof failure.body.error === 'string'
          ? failure.body.error
          : failure instanceof Error
            ? failure.message
            : 'Could not save. Try again.'
      useDesignEditor.setState((state) => ({
        saved: false,
        error: useStore.getState().canvas?.id === before.canvasId ? batch.error : state.error,
        unsavedHtml:
          batch.latestHtml !== undefined ? { ...state.unsavedHtml, [frameId]: batch.latestHtml } : state.unsavedHtml,
      }))
    })
    .finally(() => {
      batch.pending--
      if (!batch.pending) saveBatches.delete(key)
      queuedWrites--
      useDesignEditor.setState({ busy: queuedWrites > 0 })
    })
  saveQueue = pending
  trackSave(pending)
  return pending
}
