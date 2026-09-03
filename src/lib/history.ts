import type { Frame } from '../../shared/types'
import { api } from './api'
import { useStore } from './store'
import { posthog } from './posthog'

/** Local undo/redo for this client's own frame edits. Undo re-issues the
 *  inverse through the normal API, so every collaborator sees it live —
 *  remote actors' work is never undone from here. */

type Patch = Partial<Pick<Frame, 'name' | 'html' | 'x' | 'y' | 'width' | 'height'>>
type Snapshot = Pick<Frame, 'canvasId' | 'name' | 'html' | 'x' | 'y' | 'width' | 'height'>

type Entry =
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
let busy = false
/* saves still in flight from a drag: undo/redo wait for them so the inverse
   write never lands before (and gets overwritten by) the original */
let inflight: Promise<unknown> = Promise.resolve()

export function trackSave(p: Promise<unknown>) {
  inflight = inflight.then(() => p.catch(() => undefined))
}

export function clearHistory() {
  undoStack = []
  redoStack = []
}

function push(entry: Entry) {
  undoStack.push(entry)
  if (undoStack.length > MAX) undoStack.shift()
  redoStack = []
}

function snapshot(f: Frame): Snapshot {
  return { canvasId: f.canvasId, name: f.name, html: f.html, x: f.x, y: f.y, width: f.width, height: f.height }
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
  if (entries.length === 1) push(entries[0])
  else if (entries.length) push({ type: 'group', entries })
}

export function recordCreate(frame: Frame) {
  push({ type: 'create', frameId: frame.id, snapshot: snapshot(frame) })
}

/** Delete a frame through the API, remembering enough to bring it back. */
export function deleteFrameTracked(frame: Frame) {
  deleteFramesTracked([frame])
}

/** Delete several frames as one undo step. */
export function deleteFramesTracked(frames: Frame[]) {
  if (!frames.length) return
  const entries: Entry[] = frames.map((f) => ({ type: 'delete', frameId: f.id, snapshot: snapshot(f) }))
  push(entries.length === 1 ? entries[0] : { type: 'group', entries })
  for (const f of frames) api.deleteFrame(f.id).catch(console.error)
}

/* undoing a delete recreates the frame under a fresh server id — every
   other entry that pointed at the old id must follow it */
function remapId(oldId: string, newId: string) {
  const visit = (e: Entry) => {
    if (e.type === 'group') e.entries.forEach(visit)
    else if (e.frameId === oldId) e.frameId = newId
  }
  for (const e of [...undoStack, ...redoStack]) visit(e)
}

async function recreate(e: { frameId: string; snapshot: Snapshot }) {
  const { canvasId, ...rest } = e.snapshot
  const f = await api.createFrame(canvasId, rest)
  remapId(e.frameId, f.id)
  e.frameId = f.id
  useStore.getState().select(f.id)
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
    return ok.length === 0 ? null : ok.length === 1 ? ok[0] : { type: 'group', entries: ok }
  }
  const forward = direction === 'redo'
  if (e.type === 'update') {
    const patch = forward ? e.after : e.before
    useStore.getState().patchFrameLocal(e.frameId, patch)
    try {
      await api.updateFrame(e.frameId, patch)
    } catch (err) {
      /* the server kept the old value — put the local copy back in step
         with it rather than leave a client-only position behind */
      useStore.getState().patchFrameLocal(e.frameId, forward ? e.before : e.after)
      throw err
    }
  } else if ((e.type === 'create') === forward) {
    await recreate(e)
  } else {
    await api.deleteFrame(e.frameId)
  }
  return e
}

async function step(direction: 'undo' | 'redo') {
  if (busy) return
  const [from, to] = direction === 'undo' ? [undoStack, redoStack] : [redoStack, undoStack]
  const e = from.pop()
  if (!e) return
  busy = true
  try {
    await inflight
    const applied = await apply(e, direction)
    if (applied) {
      to.push(applied)
      posthog.capture(direction === 'undo' ? 'canvas_undo' : 'canvas_redo')
    }
  } catch (err) {
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
