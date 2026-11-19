import type { Actor, Frame } from '../shared/types.ts'
import type { StackWrite } from '../shared/frameStack.ts'
import * as actions from './actions.ts'
import { editFrameHtml, type FrameEdit } from './componentActions.ts'
import { heldForms, inlineDataRefusal, type Surface } from './inlineData.ts'
import { updateFrameMeta, type FrameMetaPatch } from './pageTools.ts'
import { store } from './store.ts'

/**
 * The one way the server writes a canvas's frames: a command, carrying what the writer wants
 * (a find-and-replace, a whole document, a move), never a document worked out from the
 * server's copy, run by the host that owns the canvas's writes: the server's own actions
 * (server/actions.ts). A command is shaped so that a host answering asynchronously could run
 * it as it stands.
 *
 * The contract every host keeps: `runCanvasWrite` always returns a promise, and reports a
 * failure only by rejecting it. Every caller awaits it inside an operation that awaits too
 * (an HTTP request through `writeRoute`, an MCP or resident tool call), so a rejection undoes the operation as a thrown error always did
 * (server/journal.ts).
 *
 * The local host may still write synchronously, when it is called, inside the caller's
 * operation: the write, its undo record and its `afterCommit` effects are made at the same
 * moment and in the same journal as before this entry existed. Only the error channel is the
 * promise's.
 *
 * Before a command runs, the entry checks what the caller asserts: a frame-scoped command's
 * frame is on `canvasId` (a routing key, so a frame of another canvas is refused:
 * `CanvasMismatchError`), and is still at `ifUpdatedAt` where the command carries one
 * (`FrameVersionConflict`, checked in the same synchronous step as the write).
 *
 * This first part covers a frame's HTML and its metadata. Streams, tokens, components and
 * the library still call their actions directly, and so do imports and ingest; they move
 * here next.
 */

/** A frame created on the canvas (actions.createFrame). */
export type CreateFrameCommand = {
  type: 'create-frame'
  input: Parameters<typeof actions.createFrame>[1]
  actor: Actor
}

/** A frame's HTML and metadata written as given (actions.updateFrame). `replace` marks a
 *  deliberate whole-document write (set_frame_html), which always opens a history burst. */
export type WriteFrameCommand = {
  type: 'write-frame'
  frameId: string
  patch: Parameters<typeof actions.updateFrame>[1]
  actor: Actor
  replace?: boolean
  /** written only while the frame is still at this version */
  ifUpdatedAt?: number
}

/** One exact find-and-replace in a frame's HTML, matched against the frame as the host holds
 *  it (componentActions.editFrameHtml), and refused when the result adds inline data the
 *  frame did not hold (server/inlineData.ts, worded for `surface`). */
export type EditFrameHtmlCommand = {
  type: 'edit-frame-html'
  frameId: string
  find: string
  replace: string
  actor: Actor
  surface: Surface
}

/** Rename, move, resize, turn or (un)lock a frame, or move it to another page
 *  (pageTools.updateFrameMeta, which checks the patch first). */
export type FrameMetaCommand = {
  type: 'frame-meta'
  frameId: string
  patch: FrameMetaPatch
  actor: Actor
}

/** Several frames' places in their page's stack, all or none (actions.restackFrames). */
export type RestackFramesCommand = {
  type: 'restack-frames'
  frames: StackWrite[]
  actor: Actor
}

/** A person's sign-off, or its withdrawal (actions.setFrameApproval). */
export type SetApprovalCommand = {
  type: 'set-approval'
  frameId: string
  ready: boolean
  user: { id: string; name: string }
  /** the version the person reviewed: signed off only while the frame is still at it */
  ifUpdatedAt?: number
}

/** An agent's sign-off for the person it works for (actions.agentSetFrameApproval). */
export type AgentApprovalCommand = {
  type: 'agent-approval'
  frameId: string
  status: 'ready_for_dev' | 'draft'
  user: { id: string; name: string }
  actor: Actor
}

/** A frame deleted (actions.deleteFrame). */
export type DeleteFrameCommand = {
  type: 'delete-frame'
  frameId: string
  actor: Actor
  /** deleted only while the frame is still at this version */
  ifUpdatedAt?: number
}

/** A frame put back to one of its recorded versions (actions.restoreFrameVersion). */
export type RestoreVersionCommand = {
  type: 'restore-version'
  frameId: string
  versionId: string
  actor: Actor
}

/** The stable id of an element in a frame, stamped into it if it has none
 *  (actions.ensureElementId). `like`: the live element's excerpt, when known. */
export type StampElementIdCommand = {
  type: 'stamp-element-id'
  frameId: string
  selector: string
  by: string
  like?: string
}

export type CanvasWrite =
  | CreateFrameCommand
  | WriteFrameCommand
  | EditFrameHtmlCommand
  | FrameMetaCommand
  | RestackFramesCommand
  | SetApprovalCommand
  | AgentApprovalCommand
  | DeleteFrameCommand
  | RestoreVersionCommand
  | StampElementIdCommand

/** What an edit did: the frame as written, or why nothing was. `missing`: the frame (or its
 *  canvas) is not there. */
export type EditFrameHtmlResult =
  | { ok: true; frame: Frame }
  | { ok: false; missing: true }
  | { ok: false; problem: Exclude<FrameEdit, { html: string }> }
  | { ok: false; inline: string }

/** What a stale version check answers with, over REST as before (409). */
export const FRAME_CHANGED = 'The frame changed while you were editing. Please try again.'

/** A command carried `ifUpdatedAt` and the frame has moved past it: nothing was written. */
export class FrameVersionConflict extends Error {
  constructor(readonly frame: Frame) {
    super(FRAME_CHANGED)
    this.name = 'FrameVersionConflict'
  }
}

/** A command named a frame on another canvas than the one it was sent for: nothing was written. */
export class CanvasMismatchError extends Error {
  constructor(canvasId: string, frameId: string) {
    super(`frame ${frameId} is not on canvas ${canvasId}`)
    this.name = 'CanvasMismatchError'
  }
}

/** The local host: each command's handler, the server's own actions. What a command answers
 *  is whatever its handler returns (`CanvasWriteResults`), so the two cannot drift apart. */
const local = {
  'create-frame': (canvasId, command) => actions.createFrame(canvasId, command.input, command.actor),
  'write-frame': (_canvasId, command) =>
    actions.updateFrame(command.frameId, command.patch, command.actor, command.replace ? { replace: true } : {}),
  'edit-frame-html': (_canvasId, command) => editLocally(command),
  'frame-meta': (canvasId, command) => {
    const canvas = store.getCanvas(canvasId)
    if (!canvas) return { ok: false as const, error: 'canvas not found' }
    return updateFrameMeta(canvas, command.frameId, command.patch, command.actor)
  },
  'restack-frames': (canvasId, command) => actions.restackFrames(canvasId, command.frames, command.actor),
  'set-approval': (_canvasId, command) => actions.setFrameApproval(command.frameId, command.ready, command.user),
  'agent-approval': (_canvasId, command) =>
    actions.agentSetFrameApproval(command.frameId, command.status, command.user, command.actor),
  'delete-frame': (_canvasId, command) => actions.deleteFrame(command.frameId, command.actor),
  'restore-version': (_canvasId, command) =>
    actions.restoreFrameVersion(command.frameId, command.versionId, command.actor),
  'stamp-element-id': (_canvasId, command) =>
    actions.ensureElementId(command.frameId, command.selector, command.by, command.like),
} satisfies {
  [Type in CanvasWrite['type']]: (canvasId: string, command: Extract<CanvasWrite, { type: Type }>) => unknown
}

/** What each command answers, as its handler answers it. `undefined` is "no such frame (or
 *  canvas)", as the actions say it; `restore-version`'s `null` is "no such version". */
export type CanvasWriteResults = { [Type in keyof typeof local]: Awaited<ReturnType<(typeof local)[Type]>> }

export type CanvasWriteResult<C extends CanvasWrite> = CanvasWriteResults[C['type']]

/** Run a write on a canvas's frames, on the host that owns that canvas's writes (today always
 *  the local one). `canvasId` is the canvas the command writes to. Always a promise; a failure
 *  is its rejection. */
export function runCanvasWrite<const C extends CanvasWrite>(
  canvasId: string,
  command: C,
): Promise<CanvasWriteResult<C>> {
  try {
    checkCommand(canvasId, command)
    /* the dispatch is the one place types are asserted: TypeScript cannot follow a command's
       type into the handler of that type (a correlated union). `satisfies` above checks each
       handler against its command, and `CanvasWriteResults` is read off the handlers, so what
       is asserted here is only that `local[command.type]` is the handler of `command.type` */
    const handler = local[command.type] as (canvasId: string, command: CanvasWrite) => unknown
    return Promise.resolve(handler(canvasId, command)) as Promise<CanvasWriteResult<C>>
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/** What the caller asserts, checked as the write starts: the frame is on `canvasId`, and still
 *  at `ifUpdatedAt`. A frame that is not there is the handler's to answer, as before. */
function checkCommand(canvasId: string, command: CanvasWrite) {
  if (!('frameId' in command)) return
  const frame = store.getFrame(command.frameId)
  if (!frame) return
  if (frame.canvasId !== canvasId) throw new CanvasMismatchError(canvasId, command.frameId)
  if ('ifUpdatedAt' in command && command.ifUpdatedAt !== undefined && frame.updatedAt !== command.ifUpdatedAt)
    throw new FrameVersionConflict(frame)
}

/** The find-and-replace, the inline-data check on its result and the write, in the order the
 *  MCP tool and the resident ran them. */
function editLocally(command: EditFrameHtmlCommand): EditFrameHtmlResult {
  const frame = store.getFrame(command.frameId)
  if (!frame) return { ok: false, missing: true }
  /* in whichever form the text was copied from: compact, stored, or the full form */
  const edit = editFrameHtml(frame, command.find, command.replace)
  if ('problem' in edit) return { ok: false, problem: edit }
  /* the edited document, so a URI completed across the replacement's edges is caught too.
     Every form it may have been made in counts as what the frame already held */
  const inline = inlineDataRefusal(edit.html, heldForms(frame), command.surface)
  if (inline) return { ok: false, inline }
  const written = actions.updateFrame(command.frameId, { html: edit.html }, command.actor)
  return written ? { ok: true, frame: written } : { ok: false, missing: true }
}
