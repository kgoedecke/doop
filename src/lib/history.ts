import { stackOf, type StackWrite } from '../../shared/frameStack'
import { applyPageChanges, canvasPages, samePages } from '../../shared/pages'
import { pageBackground } from '../../shared/pageBackground'
import type { Canvas, CanvasGuide, CanvasPageInfo, Frame } from '../../shared/types'
import { api } from './api'
import { requestFrame, settleFrames } from './frameBridge'
import { clearElementId, elementIdAt, elementName, setElementName } from './layers'
import { elementIdSelector } from '../../shared/elementId'
import { useStore } from './store'
import { posthog } from './posthog'

/** Local undo/redo for this client's own frame edits. Undo re-issues the
 *  inverse through the normal API, so every collaborator sees it live —
 *  remote actors' work is never undone from here. */

type Patch = Partial<
  Pick<Frame, 'name' | 'pageId' | 'html' | 'x' | 'y' | 'width' | 'height' | 'hidden' | 'locked' | 'z'>
>
type Snapshot = Pick<
  Frame,
  'canvasId' | 'pageId' | 'name' | 'html' | 'x' | 'y' | 'width' | 'height' | 'hidden' | 'locked' | 'z'
>

type Entry =
  | {
      type: 'pages'
      canvasId: string
      before: CanvasPageInfo[]
      after: CanvasPageInfo[]
      activeBefore: string | null
      activeAfter: string | null
      /* guides of the pages this change removes in either direction: a page
         takes its guides with it, so undo/redo puts them back with it */
      guides?: CanvasGuide[]
    }
  | { type: 'update'; frameId: string; before: Patch; after: Patch; at: number; discrete?: boolean }
  /* a layer's caption: `elementId` is the `data-doop-id` the rename stamped,
     what undo and redo find the element by once a sibling moves it */
  | {
      type: 'layer-name'
      frameId: string
      selector: string
      elementId?: string
      before: string | null
      after: string | null
    }
  | { type: 'create'; frameId: string; snapshot: Snapshot }
  /* frames restacked together (the Layers panel renumbering a page): saved
     as one request, so undo and redo change the order whole or not at all */
  | { type: 'stack'; canvasId: string; before: StackWrite[]; after: StackWrite[] }
  /* a ruler guide added (before null), moved, or removed (after null) */
  | { type: 'guide'; canvasId: string; before: CanvasGuide | null; after: CanvasGuide | null }
  /* a page's canvas colour set (after), changed or cleared (after null) */
  | { type: 'page-background'; canvasId: string; pageId: string; before: string | null; after: string | null }
  | { type: 'delete'; frameId: string; snapshot: Snapshot }
  /* Destination first, then source removal; reverse that order on undo so
     a failed request can never remove the only copy of a drawing. */
  | { type: 'transfer'; canvasId: string; entries: Entry[] }
  /* one multi-frame action (a group move, a group delete): undone and
     redone as a unit. An `ordered` group's members depend on each other (a
     page and the frames on it), so they run one after another: forward on
     redo, backwards on undo. */
  | { type: 'group'; entries: Entry[]; ordered?: boolean }

const MAX = 100
/* consecutive edits to the same fields land as one entry within this window
   (the Inspector autosaves every 700ms while typing) */
const COALESCE_MS = 1500

let undoStack: Entry[] = []
let redoStack: Entry[] = []
let busy = false
/* saves still in flight from a drag: undo/redo wait for them so the inverse
   write never lands before (and gets overwritten by) the original */
let inflight: Promise<unknown> = Promise.resolve()

export function trackSave(p: Promise<unknown>) {
  inflight = inflight.then(() => p.catch(() => undefined))
}

/* bumped by every clearHistory, so a save that finishes later can tell the
   history it was made under is gone (another canvas, or a fresh visit) */
let epoch = 0

export function historyEpoch() {
  return epoch
}

export function clearHistory() {
  undoStack = []
  redoStack = []
  epoch++
}

function push(entry: Entry) {
  undoStack.push(entry)
  if (undoStack.length > MAX) undoStack.shift()
  redoStack = []
}

function snapshot(f: Frame): Snapshot {
  return {
    canvasId: f.canvasId,
    pageId: f.pageId,
    name: f.name,
    html: f.html,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    /* a hidden or locked frame comes back as it was when its deletion is undone */
    hidden: f.hidden,
    locked: f.locked,
    /* and back to its place in the stack */
    z: stackOf(f),
  }
}

type UpdateEntry = Extract<Entry, { type: 'update' }>

function updateEntry(frameId: string, before: Patch, after: Patch): UpdateEntry | null {
  const keys = (Object.keys(after) as (keyof Patch)[]).filter((k) => before[k] !== after[k])
  if (!keys.length) return null
  const b: Patch = {}
  const a: Patch = {}
  for (const k of keys) {
    b[k] = before[k] as never
    a[k] = after[k] as never
  }
  return { type: 'update', frameId, before: b, after: a, at: Date.now() }
}

export function recordUpdate(frameId: string, before: Patch, after: Patch, discrete = false) {
  const entry = updateEntry(frameId, before, after)
  if (!entry) return
  entry.discrete = discrete
  const keys = Object.keys(entry.after) as (keyof Patch)[]
  const top = undoStack[undoStack.length - 1]
  if (
    top?.type === 'update' &&
    !discrete &&
    !top.discrete &&
    top.frameId === frameId &&
    Date.now() - top.at < COALESCE_MS &&
    keys.every((k) => k in top.after)
  ) {
    /* merge a burst of saves: keep the oldest before, the newest after */
    top.after = { ...top.after, ...entry.after }
    top.at = Date.now()
    redoStack = []
    return top
  }
  push(entry)
  return entry
}

export function recordLayerName(
  frameId: string,
  selector: string,
  before: string | null,
  after: string,
  elementId?: string,
): HistoryEntry {
  const entry: Entry = { type: 'layer-name', frameId, selector, before, after, ...(elementId ? { elementId } : {}) }
  push(entry)
  return entry
}

/** A name is metadata, not an HTML snapshot. Undo and rollback must update
 *  the live attribute even while the frame is being text-edited.
 *  `stamp` is the `data-doop-id` the first rename gives the element it
 *  reaches by position; undo and redo pass the id's own selector and no
 *  stamp, so a layer whose id is gone is refused, never a neighbour renamed. */
export async function saveLayerName(frameId: string, selector: string, name: string | null, stamp?: string) {
  const store = useStore.getState()
  const frame = store.canvas?.frames.find((f) => f.id === frameId)
  if (!frame) throw new Error('Frame removed')
  const before = elementName(frame.html, selector)
  const stamping = !!stamp && elementIdAt(frame.html, selector) === null
  const html = setElementName(frame.html, selector, name, stamp)
  if (html === null) throw new Error('Layer removed')
  const started = epoch
  store.patchFrameLocal(frameId, { html })
  const mirrored = requestFrame(frameId, 'doop:rename', { selector, name, ...(stamping ? { elementId: stamp } : {}) })
  try {
    await api.updateFrame(frameId, { html })
    await mirrored
  } catch (err) {
    const s = useStore.getState()
    const current = s.canvas?.frames.find((f) => f.id === frameId)
    if (
      s.canvas?.id === frame.canvasId &&
      epoch === started &&
      current &&
      elementName(current.html, selector) === name
    ) {
      /* a stamp this write made goes with it, in the saved and the live document */
      const named = setElementName(current.html, selector, before)
      const rollback = named !== null && stamping ? clearElementId(named, selector) : named
      if (rollback !== null) {
        s.patchFrameLocal(frameId, { html: rollback })
        await requestFrame(frameId, 'doop:rename', { selector, name: before, ...(stamping ? { elementId: null } : {}) })
      }
    }
    throw err
  }
}

/** Frames restacked together: one undo step, saved as one request. */
export function recordStack(canvasId: string, before: StackWrite[], after: StackWrite[]) {
  if (after.length) push({ type: 'stack', canvasId, before, after })
}

/** Write a stacking order: locally at once, then to the server as one
 *  request; a refusal puts every frame back, so the order is never half
 *  changed. Rejects with the server's error after rolling back. */
export async function saveStack(canvasId: string, before: StackWrite[], after: StackWrite[]) {
  const set = (writes: StackWrite[]) => {
    const s = useStore.getState()
    if (s.canvas?.id !== canvasId) return
    for (const { id, z } of writes) s.patchFrameLocal(id, { z })
  }
  set(after)
  try {
    await api.restackFrames(canvasId, after)
  } catch (err) {
    set(before)
    throw err
  }
}

/** Several frames moved together (a group drag): one undo step. */
export function recordUpdates(items: { frameId: string; before: Patch; after: Patch }[]) {
  const entries = items.map((i) => updateEntry(i.frameId, i.before, i.after)).filter((e): e is UpdateEntry => !!e)
  const [first, ...rest] = entries
  if (!first) return
  push(rest.length ? { type: 'group', entries } : first)
}

export function recordPages(
  canvasId: string,
  before: CanvasPageInfo[],
  after: CanvasPageInfo[],
  activeBefore: string | null,
  activeAfter: string | null,
  guides: CanvasGuide[] = [],
) {
  if (samePages(before, after)) return
  push({
    type: 'pages',
    canvasId,
    before: before.map((p) => ({ ...p })),
    after: after.map((p) => ({ ...p })),
    activeBefore,
    activeAfter,
    ...(guides.length ? { guides: guides.map((g) => ({ ...g })) } : {}),
  })
}

/** The guides on `canvas` that a page list of `next` would remove with
 *  their pages. */
export function guidesLeaving(canvas: Canvas, next: CanvasPageInfo[]): CanvasGuide[] {
  return (canvas.guides ?? []).filter((g) => !next.some((page) => page.id === g.pageId)).map((g) => ({ ...g }))
}

/* The departing pages' guides as they are now, replacing what was
   remembered for those pages: a guide a teammate deleted meanwhile is not
   brought back, even when none are left on the page. */
function rememberGuides(kept: CanvasGuide[] = [], departing: string[], now: CanvasGuide[]): CanvasGuide[] {
  return [...kept.filter((g) => !departing.includes(g.pageId)), ...now]
}

/* Update the entry's copies of the pages a list change removes with the
   colour each wears now (a teammate may have repainted a page since the
   step was recorded), so the opposite direction restores that one. */
function rememberBackgrounds(e: Extract<Entry, { type: 'pages' }>, current: CanvasPageInfo[], next: CanvasPageInfo[]) {
  for (const page of current) {
    if (next.some((p) => p.id === page.id)) continue
    for (const list of [e.before, e.after]) {
      const copy = list.find((p) => p.id === page.id)
      if (!copy) continue
      delete copy.background
      if (page.background) copy.background = page.background
    }
  }
}

/* A page comes back from the page route without its colour (page-list saves
   never carry one): paint the pages that just came back the colour the
   entry remembers for them, at once locally and then on the server. Each
   is its own request; one that fails does not hold the page change back,
   and a reply never repaints, so an edit made meanwhile stands. A failed
   request takes its colour off again (the server shows the theme paper),
   unless the page already shows a newer one, and says so. */
async function restoreBackgrounds(canvasId: string, remembered: CanvasPageInfo[], restored: CanvasPageInfo[]) {
  const painted = restored.flatMap((page) => {
    const background = pageBackground(remembered.find((p) => p.id === page.id))
    return background ? [{ id: page.id, background }] : []
  })
  const s = useStore.getState()
  if (s.canvas?.id !== canvasId) return
  for (const { id, background } of painted) s.setPageBackgroundLocal(id, background)
  const started = epoch
  const results = await Promise.allSettled(
    painted.map(({ id, background }) => api.setPageBackground(canvasId, id, background)),
  )
  const failed = painted.filter((_, i) => results[i]!.status === 'rejected')
  if (!failed.length) return
  const current = useStore.getState()
  /* the canvas was left (or revisited, under a fresh history) meanwhile:
     whatever it shows now is that visit's, not this restore's */
  if (current.canvas?.id !== canvasId || epoch !== started) return
  for (const { id, background } of failed) {
    const page = canvasPages(current.canvas).find((p) => p.id === id)
    if (page && pageBackground(page) === background) current.setPageBackgroundLocal(id, null)
  }
  const reason = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason
  current.pushNotice(
    `${failed.length === 1 ? 'A page’s background' : `${failed.length} pages’ backgrounds`} could not be put back: ${
      reason instanceof Error ? reason.message : 'request failed'
    }`,
  )
}

/* Put back the remembered guides of pages that just came back, those not
   already there. Each guide is its own request; one that fails (the canvas
   reached its guide limit meanwhile) does not hold the page change back. */
async function restoreGuides(canvasId: string, guides: CanvasGuide[], restored: CanvasPageInfo[]) {
  const back = guides.filter((g) => restored.some((page) => page.id === g.pageId))
  const results = await Promise.allSettled(
    back.map(async (guide) => {
      await api.putGuide(canvasId, guide)
      const s = useStore.getState()
      if (s.canvas?.id === canvasId) s.setGuideLocal(guide.id, guide)
    }),
  )
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  const s = useStore.getState()
  if (!failed.length || s.canvas?.id !== canvasId) return
  const reason = failed[0]!.reason
  s.pushNotice(
    `${failed.length === 1 ? 'A guide' : `${failed.length} guides`} could not be put back: ${
      reason instanceof Error ? reason.message : 'the save failed.'
    }`,
  )
}

export function recordGuide(canvasId: string, before: CanvasGuide | null, after: CanvasGuide | null) {
  if (!before && !after) return
  push({ type: 'guide', canvasId, before, after })
}

export function recordPageBackground(canvasId: string, pageId: string, before: string | null, after: string | null) {
  if (before === after) return
  push({ type: 'page-background', canvasId, pageId, before, after })
}

export type HistoryEntry = Entry

export function recordCreate(frame: Frame): HistoryEntry {
  const entry: Entry = { type: 'create', frameId: frame.id, snapshot: snapshot(frame) }
  push(entry)
  return entry
}

/** Take an entry back out of the history: for an action that was rolled
 *  back (a move whose save failed) or called off (a cancelled duplicate),
 *  so the next undo is the last thing that actually happened. */
export function dropEntry(entry: HistoryEntry) {
  undoStack = undoStack.filter((e) => e !== entry)
  redoStack = redoStack.filter((e) => e !== entry)
}

/** A transfer whose source half never landed (another save to the source
 *  won): only the destination half stays, so undo leaves the source as it
 *  was saved rather than writing the pre-move source over it. The entry
 *  keeps its place among the edits around it. */
export function keepTransferDestination(entry: HistoryEntry) {
  if (entry.type === 'transfer') entry.entries = entry.entries.slice(0, -1)
}

export function recordDrawingTransfer(
  destination: { before: Frame | null; after: Frame },
  source: { before: Frame; after: Frame | null },
  /** a restack the move needed first (a page renumbered to make room for
   *  the destination): undone after the destination goes, redone before
   *  it comes back */
  stack?: { before: StackWrite[]; after: StackWrite[] },
): HistoryEntry {
  const added: Entry = destination.before
    ? updateEntry(destination.after.id, { html: destination.before.html }, { html: destination.after.html })!
    : { type: 'create', frameId: destination.after.id, snapshot: snapshot(destination.after) }
  const removed: Entry = source.after
    ? updateEntry(source.before.id, { html: source.before.html }, { html: source.after.html })!
    : { type: 'delete', frameId: source.before.id, snapshot: snapshot(source.before) }
  const canvasId = source.before.canvasId
  const entries: Entry[] = [added, removed]
  if (stack?.after.length) entries.unshift({ type: 'stack', canvasId, before: stack.before, after: stack.after })
  const entry: Entry = { type: 'transfer', canvasId, entries }
  push(entry)
  return entry
}

/** A page duplicated together with its frames: one undo step that removes
 *  the frames before the page (a page with frames cannot be deleted) and
 *  brings the page back before the frames on redo. */
export function recordPageCopy(
  canvasId: string,
  before: CanvasPageInfo[],
  after: CanvasPageInfo[],
  activeBefore: string | null,
  activeAfter: string | null,
  frames: Frame[],
) {
  if (samePages(before, after)) return
  push({
    type: 'group',
    ordered: true,
    entries: [
      {
        type: 'pages',
        canvasId,
        before: before.map((p) => ({ ...p })),
        after: after.map((p) => ({ ...p })),
        activeBefore,
        activeAfter,
      },
      ...frames.map((f): Entry => ({ type: 'create', frameId: f.id, snapshot: snapshot(f) })),
    ],
  })
}

/** Several frames created together (a multi-frame paste): one undo step. */
export function recordCreates(frames: Frame[]) {
  if (!frames.length) return
  const entries: Entry[] = frames.map((f) => ({ type: 'create', frameId: f.id, snapshot: snapshot(f) }))
  const [first] = entries
  push(entries.length === 1 && first ? first : { type: 'group', entries })
}

/** Delete a frame through the API, remembering enough to bring it back. */
export function deleteFrameTracked(frame: Frame) {
  deleteFramesTracked([frame])
}

/** Delete several frames as one undo step. */
export function deleteFramesTracked(frames: Frame[]) {
  const entries: Entry[] = frames.map((f) => ({ type: 'delete', frameId: f.id, snapshot: snapshot(f) }))
  const [first, ...rest] = entries
  if (!first) return
  push(rest.length ? { type: 'group', entries } : first)
  for (const f of frames) api.deleteFrame(f.id).catch(console.error)
}

/* undoing a delete recreates the frame under a fresh server id — every
   other entry that pointed at the old id must follow it */
function remapId(oldId: string, newId: string) {
  const visit = (e: Entry) => {
    if (e.type === 'group' || e.type === 'transfer') e.entries.forEach(visit)
    else if (e.type === 'stack') {
      for (const w of [...e.before, ...e.after]) if (w.id === oldId) w.id = newId
    } else if (e.type !== 'pages' && e.type !== 'guide' && e.type !== 'page-background' && e.frameId === oldId)
      e.frameId = newId
  }
  for (const e of [...undoStack, ...redoStack]) visit(e)
}

async function recreate(e: { frameId: string; snapshot: Snapshot }) {
  const { canvasId, ...rest } = e.snapshot
  const canvas = useStore.getState().canvas
  if (!canvas || canvas.id !== canvasId) throw new Error('Canvas changed')
  const pages = canvasPages(canvas)
  if (!rest.pageId || !pages.some((p) => p.id === rest.pageId)) rest.pageId = pages[0]!.id
  const f = await api.createFrame(canvasId, rest)
  useStore.getState().upsertFrame(f)
  remapId(e.frameId, f.id)
  e.frameId = f.id
}

/* Recreated frames and frames moved between pages become the selection,
   so undo/redo displays the page where the affected designs now live. */
function selectionIds(e: Entry, direction: 'undo' | 'redo'): string[] {
  if (e.type === 'group' || e.type === 'transfer') return e.entries.flatMap((child) => selectionIds(child, direction))
  if (e.type === 'pages' || e.type === 'guide' || e.type === 'page-background' || e.type === 'stack') return []
  if (e.type === 'update' && 'pageId' in (direction === 'redo' ? e.after : e.before)) return [e.frameId]
  const recreated = e.type === (direction === 'redo' ? 'create' : 'delete')
  return recreated ? [e.frameId] : []
}

/* A step whose prerequisite failed is not lost: `remaining` goes back on the
   stack it came from for another try, `applied` (what did land before the
   failure) on the opposite stack so it stays reversible. */
class PrerequisiteFailed extends Error {
  constructor(
    readonly remaining: Entry,
    readonly applied: Entry | null,
    cause: unknown,
    readonly canvasId?: string,
  ) {
    super(cause instanceof Error ? cause.message : 'Could not apply the page change', { cause })
  }
}

/* The canvas a page change belongs to: a pages entry's own, or the one its
   ordered group leads with. */
function pagesCanvasId(e: Entry): string | undefined {
  if (e.type === 'pages') return e.canvasId
  const [first] = e.type === 'group' ? e.entries : []
  return first ? pagesCanvasId(first) : undefined
}

/* The members of a group that took effect, in the group's order. */
async function settle(entries: Entry[], direction: 'undo' | 'redo'): Promise<Entry[]> {
  const results = await Promise.allSettled(entries.map((child) => apply(child, direction)))
  const ok = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) console.error(`${direction} failed for ${entries.length - ok.length} frame(s)`, failed.reason)
  return ok
}

function groupOf(entries: Entry[], ordered: boolean): Entry | null {
  const [first, ...rest] = entries
  if (!first) return null
  return rest.length ? { type: 'group', entries, ...(ordered ? { ordered: true } : {}) } : first
}

/* An ordered group's first member is the prerequisite of the rest (the page
   the frames live on). Redo applies it first and goes no further when it
   fails, so no frame is recreated on the wrong page. Undo removes the frames
   first; a page that then cannot be removed keeps the still-present frames
   with it for the next try. */
async function applyOrdered(entries: Entry[], direction: 'undo' | 'redo'): Promise<Entry | null> {
  const [prerequisite, ...dependents] = entries
  if (!prerequisite) return null
  if (direction === 'redo') {
    let first: Entry | null
    try {
      first = await apply(prerequisite, 'redo')
    } catch (err) {
      throw new PrerequisiteFailed(groupOf(entries, true)!, null, err)
    }
    const ok = await settle(dependents, 'redo')
    return groupOf(first ? [first, ...ok] : ok, true)
  }
  const ok = await settle(dependents, 'undo')
  try {
    const first = await apply(prerequisite, 'undo')
    return groupOf(first ? [first, ...ok] : ok, true)
  } catch (err) {
    const left = dependents.filter((child) => !ok.includes(child))
    throw new PrerequisiteFailed(groupOf([prerequisite, ...left], true)!, groupOf(ok, false), err)
  }
}

/* Apply an entry and report which of its members took effect. A group's
   frames are independent, so every member is attempted even if one fails;
   the survivors are what the opposite stack gets, so a partially failed
   group can still be reversed. Failed members are dropped, exactly as a
   failed single entry is: the frame is gone or the canvas moved on. */
async function apply(e: Entry, direction: 'undo' | 'redo'): Promise<Entry | null> {
  if (e.type === 'transfer') {
    const entries = direction === 'redo' ? e.entries : [...e.entries].reverse()
    const applied: Entry[] = []
    for (const child of entries) {
      try {
        await apply(child, direction)
        applied.push(child)
      } catch (err) {
        // Leave a partially applied transfer reversible and retryable. Never
        // remove the source when saving/recreating its destination failed.
        const remaining = { ...e, entries: e.entries.filter((entry) => !applied.includes(entry)) }
        throw new PrerequisiteFailed(remaining, groupOf(applied, false), err, e.canvasId)
      }
    }
    return e
  }
  if (e.type === 'group') {
    if (e.ordered) return applyOrdered(e.entries, direction)
    return groupOf(await settle(e.entries, direction), false)
  }
  const forward = direction === 'redo'
  if (e.type === 'pages') {
    const state = useStore.getState()
    const canvas = state.canvas
    if (!canvas || canvas.id !== e.canvasId) throw new Error('Canvas changed')
    const expected = canvasPages(canvas)
    const next = applyPageChanges(expected, forward ? e.before : e.after, forward ? e.after : e.before)
    const leaving = guidesLeaving(canvas, next)
    /* the colours the departing pages wear now, so the way back brings
       those, not the ones remembered when the step was recorded */
    rememberBackgrounds(e, expected, next)
    const saved = await api.setPages(canvas.id, next, expected)
    const departing = expected.filter((page) => !next.some((p) => p.id === page.id)).map((page) => page.id)
    if (departing.length) e.guides = rememberGuides(e.guides, departing, leaving)
    const current = useStore.getState()
    if (current.canvas?.id !== e.canvasId) throw new Error('Canvas changed')
    if (samePages(canvasPages(current.canvas), expected) || samePages(canvasPages(current.canvas), saved)) {
      current.setPages(saved, canvas.id)
      const active = forward ? e.activeAfter : e.activeBefore
      if (active) current.setActivePage(active)
    }
    const restored = saved.filter((page) => !expected.some((p) => p.id === page.id))
    if (restored.length) {
      await restoreBackgrounds(canvas.id, forward ? e.after : e.before, restored)
      if (e.guides?.length) await restoreGuides(canvas.id, e.guides, restored)
    }
  } else if (e.type === 'guide') {
    await applyGuide(e, forward ? e.after : e.before)
  } else if (e.type === 'page-background') {
    await applyPageBackground(e, forward ? e.after : e.before)
  } else if (e.type === 'stack') {
    if (useStore.getState().canvas?.id !== e.canvasId) throw new Error('Canvas changed')
    await saveStack(e.canvasId, forward ? e.before : e.after, forward ? e.after : e.before)
  } else if (e.type === 'layer-name') {
    await saveLayerName(
      e.frameId,
      e.elementId ? elementIdSelector(e.elementId) : e.selector,
      forward ? e.after : e.before,
    )
  } else if (e.type === 'update') {
    const patch = { ...(forward ? e.after : e.before) }
    const canvas = useStore.getState().canvas
    if (patch.pageId !== undefined && canvas) {
      const pages = canvasPages(canvas)
      if (!pages.some((page) => page.id === patch.pageId)) patch.pageId = pages[0]!.id
    }
    const frame = canvas?.frames.find((frame) => frame.id === e.frameId)
    const rollback = frame
      ? (Object.fromEntries(Object.keys(patch).map((key) => [key, frame[key as keyof Frame]])) as Patch)
      : forward
        ? e.before
        : e.after
    useStore.getState().patchFrameLocal(e.frameId, patch)
    try {
      await api.updateFrame(e.frameId, patch)
      // Remember the actual fallback so the opposite operation stays reversible.
      if (forward) e.after = patch
      else e.before = patch
    } catch (err) {
      /* the server kept the old value — put the local copy back in step
         with it rather than leave a client-only position behind */
      useStore.getState().patchFrameLocal(e.frameId, rollback)
      throw err
    }
  } else if ((e.type === 'create') === forward) {
    await recreate(e)
  } else {
    await api.deleteFrame(e.frameId)
    useStore.getState().removeFrame(e.frameId)
  }
  return e
}

/* Put a guide where the entry says (or remove it), keeping the local copy
   in step with the server either way. A guide whose page is gone has
   nowhere to go back to. */
async function applyGuide(e: Extract<Entry, { type: 'guide' }>, target: CanvasGuide | null) {
  const canvas = useStore.getState().canvas
  if (!canvas || canvas.id !== e.canvasId) throw new Error('Canvas changed')
  const id = (e.after ?? e.before)!.id
  if (target && !canvasPages(canvas).some((page) => page.id === target.pageId)) throw new Error('Page removed')
  const current = canvas.guides?.find((guide) => guide.id === id) ?? null
  useStore.getState().setGuideLocal(id, target)
  const started = epoch
  try {
    if (target) await api.putGuide(canvas.id, target)
    else await api.deleteGuide(canvas.id, id)
  } catch (err) {
    if (useStore.getState().canvas?.id === canvas.id && epoch === started)
      useStore.getState().setGuideLocal(id, current)
    throw err
  }
}

/* Paint the page the colour the entry says, keeping the local copy in step
   with the server either way. A page that is gone has nothing to paint. */
async function applyPageBackground(e: Extract<Entry, { type: 'page-background' }>, target: string | null) {
  const canvas = useStore.getState().canvas
  if (!canvas || canvas.id !== e.canvasId) throw new Error('Canvas changed')
  if (!canvasPages(canvas).some((page) => page.id === e.pageId)) throw new Error('Page removed')
  const current = pageBackground(canvasPages(canvas).find((page) => page.id === e.pageId))
  useStore.getState().setPageBackgroundLocal(e.pageId, target)
  const started = epoch
  try {
    await api.setPageBackground(canvas.id, e.pageId, target)
  } catch (err) {
    /* the colour goes back only where this step's is still showing: a
       teammate's newer one, or a fresh visit's, is theirs to keep */
    const s = useStore.getState()
    const page = s.canvas?.id === canvas.id && epoch === started && canvasPages(s.canvas).find((p) => p.id === e.pageId)
    if (page && pageBackground(page) === target) s.setPageBackgroundLocal(e.pageId, current)
    throw err
  }
}

async function step(direction: 'undo' | 'redo') {
  if (busy) return
  busy = true
  let entry: Entry | undefined
  try {
    await settleFrames()
    await inflight
    const from = direction === 'undo' ? undoStack : redoStack
    entry = from.pop()
    if (!entry) return
    const applied = await apply(entry, direction)
    if (applied) {
      const to = direction === 'undo' ? redoStack : undoStack
      to.push(applied)
      const ids = selectionIds(applied, direction)
      if (ids.length) useStore.getState().selectMany(ids)
      posthog.capture(direction === 'undo' ? 'canvas_undo' : 'canvas_redo')
    }
  } catch (err) {
    /* a page change that did not land stays on its stack for another try */
    const retry =
      err instanceof PrerequisiteFailed
        ? err
        : entry?.type === 'pages'
          ? new PrerequisiteFailed(entry, null, err)
          : null
    if (retry && (retry.canvasId ?? pagesCanvasId(retry.remaining)) === useStore.getState().canvas?.id) {
      const from = direction === 'undo' ? undoStack : redoStack
      from.push(retry.remaining)
      if (retry.applied) (direction === 'undo' ? redoStack : undoStack).push(retry.applied)
      useStore.getState().pushNotice(retry.message)
    }
    /* the frame is gone or the canvas moved on — drop the entry */
    console.error(`${direction} failed`, err)
  } finally {
    busy = false
  }
}

export function undo() {
  return step('undo')
}

export function redo() {
  return step('redo')
}
