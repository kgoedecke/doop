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

const MAX = 100
/* consecutive edits to the same fields land as one entry within this window
   (the Inspector autosaves every 700ms while typing) */
const COALESCE_MS = 1500

let undoStack: Entry[] = []
let redoStack: Entry[] = []
let busy = false

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

export function recordUpdate(frameId: string, before: Patch, after: Patch) {
  const keys = (Object.keys(after) as (keyof Patch)[]).filter((k) => before[k] !== after[k])
  if (!keys.length) return
  const b: Patch = {}
  const a: Patch = {}
  for (const k of keys) {
    b[k] = before[k] as never
    a[k] = after[k] as never
  }
  const top = undoStack[undoStack.length - 1]
  if (
    top?.type === 'update' &&
    top.frameId === frameId &&
    Date.now() - top.at < COALESCE_MS &&
    keys.every((k) => k in top.after)
  ) {
    /* merge a burst of saves: keep the oldest before, the newest after */
    top.after = { ...top.after, ...a }
    top.at = Date.now()
    redoStack = []
    return
  }
  push({ type: 'update', frameId, before: b, after: a, at: Date.now() })
}

export function recordCreate(frame: Frame) {
  push({ type: 'create', frameId: frame.id, snapshot: snapshot(frame) })
}

/** Delete a frame through the API, remembering enough to bring it back. */
export async function deleteFrameTracked(frame: Frame) {
  try {
    await api.deleteFrame(frame.id)
    push({ type: 'delete', frameId: frame.id, snapshot: snapshot(frame) })
  } catch (err) {
    console.error('delete failed', err)
  }
}

/* undoing a delete recreates the frame under a fresh server id — every
   other entry that pointed at the old id must follow it */
function remapId(oldId: string, newId: string) {
  for (const e of [...undoStack, ...redoStack]) {
    if (e.frameId === oldId) e.frameId = newId
  }
}

async function recreate(e: { frameId: string; snapshot: Snapshot }) {
  const { canvasId, ...rest } = e.snapshot
  const f = await api.createFrame(canvasId, rest)
  remapId(e.frameId, f.id)
  e.frameId = f.id
  useStore.getState().select(f.id)
}

export async function undo() {
  if (busy) return
  const e = undoStack.pop()
  if (!e) return
  busy = true
  try {
    if (e.type === 'update') {
      useStore.getState().patchFrameLocal(e.frameId, e.before)
      await api.updateFrame(e.frameId, e.before)
    } else if (e.type === 'create') {
      await api.deleteFrame(e.frameId)
    } else {
      await recreate(e)
    }
    redoStack.push(e)
    posthog.capture('canvas_undo')
  } catch (err) {
    /* the frame is gone or the canvas moved on — drop the entry */
    console.error('undo failed', err)
  } finally {
    busy = false
  }
}

export async function redo() {
  if (busy) return
  const e = redoStack.pop()
  if (!e) return
  busy = true
  try {
    if (e.type === 'update') {
      useStore.getState().patchFrameLocal(e.frameId, e.after)
      await api.updateFrame(e.frameId, e.after)
    } else if (e.type === 'create') {
      await recreate(e)
    } else {
      await api.deleteFrame(e.frameId)
    }
    undoStack.push(e)
    posthog.capture('canvas_redo')
  } catch (err) {
    console.error('redo failed', err)
  } finally {
    busy = false
  }
}
