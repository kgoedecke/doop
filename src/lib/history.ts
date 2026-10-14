import { applyPageChanges, canvasPages, samePages } from '../../shared/pages'
import type { CanvasPageInfo, Frame } from '../../shared/types'
import { api } from './api'
import { useStore } from './store'
import { posthog } from './posthog'

/** Local undo/redo for this client's own frame edits. Undo re-issues the
 *  inverse through the normal API, so every collaborator sees it live —
 *  remote actors' work is never undone from here. */

type Patch = Partial<Pick<Frame, 'name' | 'pageId' | 'html' | 'x' | 'y' | 'width' | 'height'>>
type Snapshot = Pick<Frame, 'canvasId' | 'pageId' | 'name' | 'html' | 'x' | 'y' | 'width' | 'height'>

type Entry =
  | {
      type: 'pages'
      canvasId: string
      before: CanvasPageInfo[]
      after: CanvasPageInfo[]
      activeBefore: string | null
      activeAfter: string | null
    }
  | { type: 'update'; frameId: string; before: Patch; after: Patch; at: number }
  | { type: 'create'; frameId: string; snapshot: Snapshot }
  | { type: 'delete'; frameId: string; snapshot: Snapshot }
  /* one multi-frame action (a group move, a group delete): undone and
     redone as a unit */
  | { type: 'group'; entries: Entry[] }

const MAX = 100
/* consecutive edits to the same fields land as one entry within this window
   (the Inspector autosaves every 700ms while typing) */
const COALESCE_MS = 1500

let undoStack: Entry[] = []
let redoStack: Entry[] = []
let historyQueue: Promise<void> = Promise.resolve()
let historyVersion = 0
/* saves still in flight from a drag: undo/redo wait for them so the inverse
   write never lands before (and gets overwritten by) the original */
let inflight: Promise<unknown> = Promise.resolve()

export function trackSave(p: Promise<unknown>) {
  inflight = inflight.then(() => p.catch(() => undefined))
}

export function clearHistory() {
  historyVersion++
  undoStack = []
  redoStack = []
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

export function recordUpdate(frameId: string, before: Patch, after: Patch) {
  const entry = updateEntry(frameId, before, after)
  if (!entry) return
  const keys = Object.keys(entry.after) as (keyof Patch)[]
  const top = undoStack[undoStack.length - 1]
  if (
    top?.type === 'update' &&
    top.frameId === frameId &&
    Date.now() - top.at < COALESCE_MS &&
    keys.every((k) => k in top.after)
  ) {
    /* merge a burst of saves: keep the oldest before, the newest after */
    top.after = { ...top.after, ...entry.after }
    top.at = Date.now()
    redoStack = []
    return
  }
  push(entry)
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
) {
  if (samePages(before, after)) return
  push({
    type: 'pages',
    canvasId,
    before: before.map((p) => ({ ...p })),
    after: after.map((p) => ({ ...p })),
    activeBefore,
    activeAfter,
  })
}

export function recordCreate(frame: Frame) {
  push({ type: 'create', frameId: frame.id, snapshot: snapshot(frame) })
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
    if (e.type === 'group') e.entries.forEach(visit)
    else if (e.type !== 'pages' && e.frameId === oldId) e.frameId = newId
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
  if (e.type === 'group') return e.entries.flatMap((child) => selectionIds(child, direction))
  if (e.type === 'pages') return []
  if (e.type === 'update' && 'pageId' in (direction === 'redo' ? e.after : e.before)) return [e.frameId]
  const recreated = e.type === (direction === 'redo' ? 'create' : 'delete')
  return recreated ? [e.frameId] : []
}

/* Apply an entry and report which of its members took effect. A group's
   frames are independent, so every member is attempted even if one fails;
   the survivors are what the opposite stack gets, so a partially failed
   group can still be reversed. Failed members are dropped, exactly as a
   failed single entry is: the frame is gone or the canvas moved on. */
async function apply(e: Entry, direction: 'undo' | 'redo'): Promise<Entry | null> {
  if (e.type === 'group') {
    const results = await Promise.allSettled(e.entries.map((child) => apply(child, direction)))
    const ok = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) console.error(`${direction} failed for ${e.entries.length - ok.length} frame(s)`, failed.reason)
    const [first, ...rest] = ok
    if (!first) return null
    return rest.length ? { type: 'group', entries: ok } : first
  }
  const forward = direction === 'redo'
  if (e.type === 'pages') {
    const state = useStore.getState()
    const canvas = state.canvas
    if (!canvas || canvas.id !== e.canvasId) throw new Error('Canvas changed')
    const expected = canvasPages(canvas)
    const next = applyPageChanges(expected, forward ? e.before : e.after, forward ? e.after : e.before)
    const saved = await api.setPages(canvas.id, next, expected)
    const current = useStore.getState()
    if (current.canvas?.id !== e.canvasId) throw new Error('Canvas changed')
    if (samePages(canvasPages(current.canvas), expected) || samePages(canvasPages(current.canvas), saved)) {
      current.setPages(saved, canvas.id)
      const active = forward ? e.activeAfter : e.activeBefore
      if (active) current.setActivePage(active)
    }
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
  }
  return e
}

async function applyStep(direction: 'undo' | 'redo', version: number) {
  let entry: Entry | undefined
  try {
    await inflight
    if (version !== historyVersion) return
    const from = direction === 'undo' ? undoStack : redoStack
    entry = from.pop()
    if (!entry) return
    const applied = await apply(entry, direction)
    if (version !== historyVersion) return
    if (applied) {
      const to = direction === 'undo' ? redoStack : undoStack
      to.push(applied)
      const ids = selectionIds(applied, direction)
      if (ids.length) useStore.getState().selectMany(ids)
      posthog.capture(direction === 'undo' ? 'canvas_undo' : 'canvas_redo')
    }
  } catch (err) {
    if (entry?.type === 'pages' && useStore.getState().canvas?.id === entry.canvasId) {
      const from = direction === 'undo' ? undoStack : redoStack
      from.push(entry)
      useStore.getState().pushNotice(err instanceof Error ? err.message : 'Could not undo page change')
    }
    /* the frame is gone or the canvas moved on — drop the entry */
    console.error(`${direction} failed`, err)
  }
}

function step(direction: 'undo' | 'redo') {
  // Actor updates can paint before the API confirms a save; keep quick keyboard steps in order.
  const version = historyVersion
  historyQueue = historyQueue.then(() => applyStep(direction, version))
  return historyQueue
}

export function undo() {
  return step('undo')
}

export function redo() {
  return step('redo')
}
