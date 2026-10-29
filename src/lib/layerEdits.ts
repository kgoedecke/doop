import type { Frame } from '../../shared/types'
import { pickedSelectors, useStore } from './store'
import { api, ApiError, errorMessage } from './api'
import { inspectElement, requestFrame } from './frameBridge'
import { isCanvasElement } from './drawing'
import { carriedCss, newScope, renameInCss, scopeMarkup, withCarriedCss } from './styleCarry'
import {
  deleteFramesTracked,
  dropEntry,
  recordDrawingTransfer,
  recordUpdate,
  recordUpdates,
  trackSave,
} from './history'
import {
  buildLayerTree,
  duplicateElements,
  elementHtml,
  isElementHidden,
  isElementLocked,
  moveElement,
  placeElement,
  removeElements,
  replaceElement,
  setElementLocked,
  setElementsHidden,
  shiftElement,
  type DropTarget,
  type FlowPlacement,
  type MovedElement,
} from './layers'

/* ---- element edits shared by the Layers rail and the element panel ---- */

export function saveFrameHtml(frame: Frame, html: string) {
  // Layer commands each need their own undo step, even when invoked rapidly.
  recordUpdate(frame.id, { html: frame.html }, { html }, true)
  useStore.getState().patchFrameLocal(frame.id, { html })
  trackSave(api.updateFrame(frame.id, { html }).catch(console.error))
}

/* ---- locks ---- */

/** A locked layer, or one inside a locked box, takes no edits from the stage
 *  or the rail: it can be selected in the Layers panel (so it can be
 *  unlocked) and nothing else. */
export function isLayerLocked(frame: Frame, selector: string): boolean {
  return !!frame.locked || isElementLocked(frame.html, selector)
}

/** Set or clear the element's own lock; false when the selector no longer
 *  resolves. The live document gets the attribute as well: FrameView
 *  withholds html from a frame in text-edit mode, and that mode's next save
 *  serializes the live document — without the attribute there, the save
 *  would silently drop the lock. */
export function setLayerLocked(frame: Frame, selector: string, locked: boolean): boolean {
  return setLayersLocked(frame, [selector], locked)
}

/** Lock or unlock frames together, as one undo step. Frames already in the
 *  wanted state are left alone. */
export function setFramesLocked(frames: Frame[], locked: boolean) {
  const changed = frames.filter((f) => !!f.locked !== locked)
  if (!changed.length) return
  recordUpdates(changed.map((f) => ({ frameId: f.id, before: { locked: !!f.locked }, after: { locked } })))
  const store = useStore.getState()
  for (const f of changed) {
    store.patchFrameLocal(f.id, { locked })
    /* as for the eye: undo waits for the save, and a save the server refused
       is rolled back so the lock shows what everyone else sees */
    trackSave(
      api.updateFrame(f.id, { locked }).catch((err: unknown) => {
        const s = useStore.getState()
        s.patchFrameLocal(f.id, { locked: !locked })
        s.pushNotice(errorMessage(err, `Couldn’t ${locked ? 'lock' : 'unlock'} “${f.name}”`))
      }),
    )
  }
}

/** Set or clear the own lock of every element as one undo step; false when
 *  any selector no longer resolves. */
export function setLayersLocked(frame: Frame, selectors: string[], locked: boolean): boolean {
  let html = frame.html
  // A lock is an attribute, so the positional paths hold between steps.
  for (const selector of selectors) {
    const next = setElementLocked(html, selector, locked)
    if (next === null) return false
    html = next
  }
  saveFrameHtml(frame, html)
  for (const selector of selectors) void requestFrame(frame.id, 'doop:lock', { selector, locked })
  return true
}

/** ⌘⇧L: picked layers toggle their own locks — together, unlocking only
 *  once every one is locked; otherwise the selected frames lock together the
 *  same way (a mixed selection locks the rest first, as Figma does). False
 *  when nothing is selected. */
export function toggleLockSelection(): boolean {
  const s = useStore.getState()
  const frames = s.canvas?.frames ?? []
  const picked = s.selectedElement
  if (picked) {
    const frame = frames.find((f) => f.id === picked.frameId)
    if (!frame) return false
    const selectors = pickedSelectors(s)
    const allLocked = selectors.every((selector) => isElementLocked(frame.html, selector, true))
    return setLayersLocked(frame, selectors, !allLocked)
  }
  const selected = frames.filter((f) => s.selectedIds.includes(f.id))
  if (!selected.length) return false
  setFramesLocked(selected, !selected.every((f) => f.locked))
  return true
}

/** Remove one element; false when the selector no longer resolves (a
 *  collaborator rewrote the frame under the pick), in which case the stale
 *  pick is dropped so it cannot stand in for a frame selection. A locked
 *  element stays, and stays picked, so it can be unlocked. */
export function deleteLayer(frame: Frame, selector: string): boolean {
  return deleteLayers(frame, [selector])
}

/** Remove the elements together, as one undo step; as for one element, a
 *  locked one keeps the whole set (and the pick) in place. */
export function deleteLayers(frame: Frame, selectors: string[]): boolean {
  if (selectors.some((selector) => isLayerLocked(frame, selector))) return false
  const html = removeElements(frame.html, selectors)
  const store = useStore.getState()
  store.setSelectedElement(null)
  store.setElementPanelOpen(false)
  if (html === null) return false
  saveFrameHtml(frame, html)
  return true
}

/** ⌫ on the canvas: a picked element is always what goes, never the frame
 *  around it — a pick whose frame or selector no longer exists (deleted or
 *  rewritten by a collaborator) is dropped rather than falling through to
 *  the frames. Frames only go when nothing is picked, and locked frames
 *  never go from here. Returns false when the key had nothing to act on. */
export function deleteSelection(): boolean {
  const s = useStore.getState()
  const frames = s.canvas?.frames ?? []
  const picked = s.selectedElement
  if (picked) {
    const pickedFrame = frames.find((f) => f.id === picked.frameId)
    if (pickedFrame) deleteLayers(pickedFrame, pickedSelectors(s))
    else s.pickElement(null)
    return true
  }
  const selected = frames.filter((f) => s.selectedIds.includes(f.id) && !f.locked)
  if (!selected.length) return false
  deleteFramesTracked(selected)
  return true
}

export function duplicateLayer(frame: Frame, selector: string) {
  duplicateLayers(frame, [selector])
}

/** Copy each element in place, right after itself, as one undo step. When
 *  the copies were made from the pick, the copies become the pick: the
 *  originals' positional paths would now point at shifted elements. */
export function duplicateLayers(frame: Frame, selectors: string[]) {
  if (frame.locked || selectors.some((selector) => isLayerLocked(frame, selector))) return
  const duplicated = duplicateElements(frame.html, selectors)
  if (!duplicated) return
  saveFrameHtml(frame, duplicated.html)
  const store = useStore.getState()
  const picked = store.selectedElement?.frameId === frame.id ? pickedSelectors(store) : []
  if (!picked.some((selector) => selectors.includes(selector))) return
  store.pickElement(null)
  for (const selector of duplicated.selectors) store.toggleElement({ frameId: frame.id, selector })
}

/* ---- the eye: hiding and showing, frames and elements alike ---- */

/** Hide the frames from the stage, or bring them back, as one undo step.
 *  A hidden frame keeps its row, its HTML and its exports — only the canvas
 *  stops drawing it. Frames already in the asked-for state are left alone. */
export function setFramesHidden(frames: Frame[], hidden: boolean) {
  const changed = frames.filter((f) => !!f.hidden !== hidden)
  if (!changed.length) return
  recordUpdates(changed.map((f) => ({ frameId: f.id, before: { hidden: !!f.hidden }, after: { hidden } })))
  const store = useStore.getState()
  for (const f of changed) {
    store.patchFrameLocal(f.id, { hidden })
    /* undo waits for the save, as it does for a drag — an immediate ⌘Z must
       not land before the hide it reverses. A save the server refused is
       rolled back, so the eye and the stage show what everyone else sees. */
    trackSave(
      api.updateFrame(f.id, { hidden }).catch((err: unknown) => {
        const s = useStore.getState()
        s.patchFrameLocal(f.id, { hidden: !hidden })
        s.pushNotice(errorMessage(err, `Couldn’t ${hidden ? 'hide' : 'show'} “${f.name}”`))
      }),
    )
  }
}

export function setFrameHidden(frame: Frame, hidden: boolean) {
  setFramesHidden([frame], hidden)
}

/** Hide one element inside the frame, or show it again; false when the
 *  selector no longer resolves. The mark lives in the frame's HTML, so it
 *  rides the same save as any other layer edit. */
export function setLayerHidden(frame: Frame, selector: string, hidden: boolean): boolean {
  return setLayersHidden(frame, [selector], hidden)
}

/** Hide or show every element as one undo step; false when any selector no
 *  longer resolves. */
export function setLayersHidden(frame: Frame, selectors: string[], hidden: boolean): boolean {
  const html = setElementsHidden(frame.html, selectors, hidden)
  if (html === null) return false
  if (html !== frame.html) saveFrameHtml(frame, html)
  // Text editing withholds HTML updates; its next save serializes the live iframe.
  for (const selector of selectors) void requestFrame(frame.id, 'doop:visibility', { selector, hidden })
  return true
}

/** ⌘⇧H: picked elements move together — all shown when every one is
 *  hidden, hidden otherwise; with nothing picked the selected frames do the
 *  same. False when the key had nothing to act on. */
export function toggleSelectionHidden(): boolean {
  const s = useStore.getState()
  const frames = s.canvas?.frames ?? []
  const picked = s.selectedElement
  if (picked) {
    const frame = frames.find((f) => f.id === picked.frameId)
    const selectors = pickedSelectors(s)
    const states = frame ? selectors.map((selector) => isElementHidden(frame.html, selector)) : []
    if (frame && states.length && !states.includes(null)) setLayersHidden(frame, selectors, !states.every(Boolean))
    return true
  }
  const selected = frames.filter((f) => s.selectedIds.includes(f.id))
  if (!selected.length) return false
  setFramesHidden(selected, !selected.every((f) => f.hidden))
  return true
}

/** Swap one element's markup; false when the selector no longer resolves or the element is locked. */
export function replaceLayerHtml(frame: Frame, selector: string, outerHtml: string): boolean {
  if (isLayerLocked(frame, selector)) return false
  const html = replaceElement(frame.html, selector, outerHtml)
  if (html === null) return false
  saveFrameHtml(frame, html)
  return true
}

/* a moved element keeps the selection: its selector changes with its
   position, so the rail and the frame outline have to be pointed at the new one */
function commitMove(frame: Frame, moved: MovedElement | null): boolean {
  if (!moved) return false
  saveFrameHtml(frame, moved.html)
  const store = useStore.getState()
  store.select(frame.id)
  store.setSelectedElement({ frameId: frame.id, selector: moved.selector })
  return true
}

/** Drop the element next to, or into, another; false when nothing moved. */
export function moveLayer(frame: Frame, selector: string, target: DropTarget, flow?: FlowPlacement): boolean {
  if (isLayerLocked(frame, selector)) return false
  return commitMove(frame, moveElement(frame.html, selector, target, flow))
}

/** Finish a drag that began on `pressed`: the element is moved in the frame
 *  as the store holds it now, unless its HTML changed during the gesture.
 *  A path selector can survive a collaborator's edit while pointing at a
 *  different element (a same-tag sibling inserted above shifts every
 *  nth-of-type below it), so a changed frame drops nothing. False when
 *  nothing moved. */
export function dropLayer(pressed: Frame, selector: string, target: DropTarget, flow?: FlowPlacement): boolean {
  const frame = useStore.getState().canvas?.frames.find((f) => f.id === pressed.id)
  if (!frame || frame.html !== pressed.html) return false
  return moveLayer(frame, selector, target, flow)
}

/** Whether a layer from another frame may be dropped into `frame`: not a
 *  locked one, and not a standalone drawing that still holds its shape (it
 *  is that one shape, not a box for others). A standalone whose shape was
 *  dragged out is left behind empty, and takes a layer back. */
export function takesLayers(frame: Frame, hasLayers: boolean): boolean {
  return !frame.locked && !(hasLayers && isCanvasElement(frame.html))
}

/** A standalone element is a frame holding one top-level layer with the
 *  canvas-element marker: the Layers rail shows it as that layer, at the
 *  root. Its selector, when the frame is one. */
export function standaloneSelector(frame: Frame): string | null {
  if (!isCanvasElement(frame.html)) return null
  const [only, ...more] = buildLayerTree(frame.html)
  return only && !more.length ? only.selector : null
}

/** Move the element out of `source` and next to, or into, a layer of
 *  `dest`: one undo step over both frames. The destination is saved first
 *  and the source emptied only once that landed, so a failed save can leave
 *  the element where it was but never nowhere. A standalone element that
 *  moves into a frame takes its shell with it (the shell was only ever that
 *  layer). False when the element is locked, the destination refuses layers
 *  (`takesLayers`), the target cannot take it, or either frame changed
 *  during the gesture. */
export function transferLayer(pressed: Frame, selector: string, over: Frame, target: DropTarget): boolean {
  const frames = useStore.getState().canvas?.frames ?? []
  const source = frames.find((f) => f.id === pressed.id)
  const dest = frames.find((f) => f.id === over.id)
  if (!source || !dest || source.html !== pressed.html || dest.html !== over.html) return false
  if (isLayerLocked(source, selector) || !takesLayers(dest, buildLayerTree(dest.html).length > 0)) return false
  const shell = standaloneSelector(source) === selector
  const scope = newScope()
  const raw = elementHtml(source.html, selector)
  /* a standalone's shape fills its shell (100% of it); in a frame those
     percentages would mean the frame, so it takes the shell's size along */
  const markup = raw === null ? null : scopeMarkup(shell ? sizedToShell(raw, source) : raw, scope)
  const moved = markup === null ? null : placeElement(dest.html, target, markup)
  const emptied = moved && removeElements(source.html, [selector])
  if (!moved || !emptied) return false
  /* the frame's own CSS for the subtree comes along, or the layer would land unstyled */
  const css = renameInCss(carriedCss(source.html, selector, scope), moved.renamed)
  const placed = { ...moved, html: withCarriedCss(moved.html, css, scope) }
  const destAfter = { ...dest, html: placed.html }
  const sourceAfter = shell ? null : { ...source, html: emptied }
  const store = useStore.getState()
  store.patchFrameLocal(dest.id, { html: placed.html })
  if (shell) store.removeFrame(source.id)
  else store.patchFrameLocal(source.id, { html: emptied })
  store.select(dest.id)
  store.setSelectedElement({ frameId: dest.id, selector: placed.selector })
  /* the entry goes in now, in its place among the edits around it; a move
     that is rolled back takes it out again, so there is nothing to undo */
  const entry = recordDrawingTransfer({ before: dest, after: destAfter }, { before: source, after: sourceAfter })
  /* the destination is saved first; every write is conditional on the
     version this move started from, so a collaborator's edit in the
     meantime wins and the screen shows it */
  let saved: Frame | null = null
  trackSave(
    api
      .updateFrame(dest.id, { html: placed.html }, dest.updatedAt)
      .then((frame) => {
        saved = frame
        return shell
          ? api.deleteFrame(source.id, source.updatedAt)
          : api.updateFrame(source.id, { html: emptied }, source.updatedAt)
      })
      .catch(async (err: unknown) => {
        const s = useStore.getState()
        const remote = err instanceof ApiError && err.status === 409 ? (err.body.frame as Frame | undefined) : undefined
        /* the source was saved again while the destination write was out —
           a quick edit beside the move — and that save already carried the
           element's removal (its markup is gone from the saved source, not
           just moved along by a sibling's deletion): the element lives in
           the destination alone now, and the move stands rather than being
           rolled back into nothing */
        if (saved && !shell && remote?.id === source.id && raw !== null && !remote.html.includes(raw)) {
          s.upsertFrame(remote)
          return
        }
        dropEntry(entry)
        s.patchFrameLocal(dest.id, { html: dest.html })
        if (shell) s.upsertFrame(source)
        else s.patchFrameLocal(source.id, { html: source.html })
        if (remote) s.upsertFrame(remote)
        s.pushNotice(errorMessage(err, `Couldn’t move the layer to “${dest.name}”`))
        if (!saved) return
        /* the restore is conditional on the version this move wrote: a
           collaborator's newer save stays, and the screen shows the
           duplicate the server holds rather than hiding it */
        await api.updateFrame(dest.id, { html: dest.html }, saved.updatedAt).catch((restoreErr: unknown) => {
          const theirs = restoreErr instanceof ApiError ? (restoreErr.body.frame as Frame | undefined) : undefined
          if (theirs?.id === dest.id) useStore.getState().upsertFrame(theirs)
          else useStore.getState().patchFrameLocal(dest.id, { html: placed.html })
        })
      }),
  )
  return true
}

/* the standalone's root with its shell-relative size made absolute */
function sizedToShell(outerHtml: string, shell: Frame): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = outerHtml
  const el = tpl.content.firstElementChild as HTMLElement | SVGElement | null
  if (!el) return outerHtml
  if (el.style.width === '100%') el.style.width = `${shell.width}px`
  if (el.style.height === '100%') el.style.height = `${shell.height}px`
  return tpl.innerHTML
}

/** Lift the element out of its frame onto the canvas, as a standalone
 *  element of its own at the spot it was rendered (the frame's live
 *  document measures it; a frame not rendered yet places it at the frame's
 *  corner). The new frame is created first and the source emptied only
 *  once that landed; one undo step removes the element and puts the source
 *  back. False when the element is locked, already standalone, or its
 *  frame changed since the press. */
export async function detachLayer(pressed: Frame, selector: string): Promise<boolean> {
  const source = useStore.getState().canvas?.frames.find((f) => f.id === pressed.id)
  if (!source || source.html !== pressed.html) return false
  if (isLayerLocked(source, selector) || standaloneSelector(source) === selector) return false
  const markup = elementHtml(source.html, selector)
  const emptied = markup === null ? null : removeElements(source.html, [selector])
  if (!markup || !emptied) return false
  const [node] = buildLayerTree(`<body>${markup}</body>`)
  const info = await inspectElement(source.id, selector).catch(() => null)
  const rect = info?.rect ?? { x: 0, y: 0, width: 120, height: 120 }
  const scope = newScope()
  const html = withCarriedCss(
    standaloneDocument(scopeMarkup(markup, scope)),
    carriedCss(source.html, selector, scope),
    scope,
  )
  if (!html) return false
  const unchanged = () => useStore.getState().canvas?.frames.find((f) => f.id === source.id)?.html === source.html
  if (!unchanged()) return false
  let created: Frame
  try {
    created = await api.createFrame(source.canvasId, {
      name: node?.label ?? 'Layer',
      /* on the source's page, not whichever page is active or first */
      pageId: source.pageId,
      x: Math.round(source.x + rect.x),
      y: Math.round(source.y + rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      html,
    })
  } catch (err) {
    useStore.getState().pushNotice(errorMessage(err, 'Couldn’t move the layer onto the canvas'))
    return false
  }
  const store = useStore.getState()
  if (store.canvas?.id !== source.canvasId) return true
  /* the source may have been edited while the frame was created: that
     edit wins, and the copy just made goes away again */
  if (!unchanged()) {
    store.pushNotice(`“${source.name}” changed during the move; the layer stayed where it was`)
    trackSave(dropCreated(created))
    return false
  }
  store.upsertFrame(created)
  store.patchFrameLocal(source.id, { html: emptied })
  store.select(created.id)
  const [placed] = buildLayerTree(created.html)
  if (placed) store.setSelectedElement({ frameId: created.id, selector: placed.selector })
  /* the entry goes in now, in its place; the source write is conditional
     on the version the press saw: an edit that landed since wins, the
     element stays there, the entry comes out and the copy just made goes
     away — unless that edit already carried the element's removal, in
     which case the copy is the element's only home and the lift stands */
  const entry = recordDrawingTransfer(
    { before: null, after: created },
    { before: source, after: { ...source, html: emptied } },
  )
  trackSave(
    api.updateFrame(source.id, { html: emptied }, source.updatedAt).catch(async (err: unknown) => {
      const s = useStore.getState()
      const remote = err instanceof ApiError && err.status === 409 ? (err.body.frame as Frame | undefined) : undefined
      if (remote?.id === source.id && !remote.html.includes(markup)) {
        s.upsertFrame(remote)
        return
      }
      dropEntry(entry)
      s.patchFrameLocal(source.id, { html: source.html })
      if (remote?.id === source.id) s.upsertFrame(remote)
      s.pushNotice(errorMessage(err, `Couldn’t take the layer out of “${source.name}”`))
      s.removeFrame(created.id)
      await dropCreated(created)
    }),
  )
  return true
}

/* Take back a frame a lift created: conditional on its version, so an
   edit a collaborator already made to it stays and is shown; a copy the
   server keeps for any other reason is shown rather than hidden. */
function dropCreated(created: Frame): Promise<void> {
  return api.deleteFrame(created.id, created.updatedAt).then(
    () => undefined,
    (err: unknown) => {
      const remote = err instanceof ApiError && err.status === 409 ? (err.body.frame as Frame | undefined) : undefined
      useStore.getState().upsertFrame(remote?.id === created.id ? remote : created)
    },
  )
}

/* a transparent document the size of its one element: the markup fills the
   frame, so resizing the frame resizes the element as it does a drawing */
function standaloneDocument(markup: string): string {
  const doc = new DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html')
  doc.documentElement.style.cssText = 'width:100%;height:100%;margin:0;'
  doc.body.style.cssText = 'width:100%;height:100%;margin:0;'
  doc.body.setAttribute('data-doop-canvas-element', 'true')
  doc.body.innerHTML = markup
  const el = doc.body.firstElementChild as HTMLElement | SVGElement | null
  if (!el || doc.body.children.length !== 1) return ''
  /* the element is measured as rendered, transforms included, and that box
     becomes the frame: a transform, inline or from a carried rule, would
     apply a second time on top */
  for (const name of ['transform', 'translate', 'scale', 'rotate']) el.style.setProperty(name, 'none', 'important')
  for (const [name, value] of [
    ['position', 'absolute'],
    ['left', '0'],
    ['top', '0'],
    ['width', '100%'],
    ['height', '100%'],
    ['margin', '0'],
    ['box-sizing', 'border-box'],
  ] as const)
    el.style.setProperty(name, value)
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

/** Step the element one layer up (-1) or down (1) among its siblings. */
export function shiftLayer(frame: Frame, selector: string, dir: -1 | 1): boolean {
  if (isLayerLocked(frame, selector)) return false
  return commitMove(frame, shiftElement(frame.html, selector, dir))
}
