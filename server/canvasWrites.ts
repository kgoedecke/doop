import type { Actor, Frame } from '../shared/types.ts'
import type { TokenEdit } from '../shared/designTokens.ts'
import type { StackWrite } from '../shared/frameStack.ts'
import * as actions from './actions.ts'
import type { ComponentDef } from '../shared/components.ts'
import {
  catalogEntry,
  ComponentError,
  importComponent,
  pullIntoConsumer,
  syncComponent,
  waitingLibraryUpdates,
  touchedFrames,
  createComponentFromElement,
  createComponentFromHtml,
  deleteComponent,
  changeInstances,
  editFrameHtml,
  insertInstance,
  instancesIn,
  restoreComponent,
  restoreComponentVersion,
  updateComponent,
  unbalancedEdit,
  type Unbalanced,
  type CreateFromElement,
  type CreateFromHtml,
  type FrameEdit,
  type InsertInput,
  type InstanceChange,
  type UpdateInput,
  /* the background queue's frames, and detaching */
  detachAllInstances,
  detachInFrame,
} from './componentActions.ts'
import { componentReuseNotes } from './reuseNotes.ts'
import { WriteRefusedError } from './writeRefusal.ts'
import * as propagation from './propagation.ts'
import {
  EMBEDDED_MIN_LENGTH,
  heldForms,
  inlineDataRefusal,
  storedHtmlOf,
  type Existing,
  type Surface,
} from './inlineData.ts'
import { inTransaction, transaction } from './journal.ts'
import { updateFrameMeta, type FrameMetaPatch } from './pageTools.ts'
import { store } from './store.ts'
import { optional, runOperation, WorkBudgetError } from './workBudget.ts'

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
 * Covered so far: a frame's HTML and its metadata, streams (a chunk appended, an idle stream
 * settled or closed), design tokens and their themes (renames included, with the frames they
 * rewrite), component definitions (made, changed, deleted, brought back), instances (placed,
 * changed), imports and ingest
 * (`runImportWrite`, `landImportFrame`, below), the element ids comments are anchored by
 * (a new comment's, a moved one's and the boot backfill's), what a canvas takes from its
 * workspace library or another canvas (a component imported, one or every waiting update
 * pulled, a library's publication pulled into each canvas using it, and the tokens an adopted
 * component brings), and the background queue: each frame's turn of propagation and detaching
 * (`propagate-frame`, `detach-frame`, routed as this module loads, at the end of the file), and
 * detaching every instance (`detach-instances`). Publishing a library writes the library's
 * publication, not a canvas, and stays outside.
 *
 * A command an agent sends carries the surface it came from (`inline`), and the host checks
 * the HTML it adds for inline data against the frame as the host holds it, by that surface's
 * rule (server/inlineData.ts): the command never depends on the caller's copy of the frame.
 */

/** A frame created on the canvas (actions.createFrame). */
export type CreateFrameCommand = {
  type: 'create-frame'
  input: Parameters<typeof actions.createFrame>[1]
  actor: Actor
  /** an agent's frame: refused, nothing written, if its HTML holds inline data */
  inline?: Surface
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
  /** an agent's write: refused, nothing written, if its HTML adds inline data the frame did
   *  not hold, by that surface's rule (`heldOf`) */
  inline?: Surface
}

/** One exact find-and-replace in a frame's HTML, matched against the frame as the host holds
 *  it (componentActions.editFrameHtml), and refused when the result adds inline data the
 *  frame did not hold (server/inlineData.ts, worded for the surface in `inline`). */
export type EditFrameHtmlCommand = {
  type: 'edit-frame-html'
  frameId: string
  find: string
  replace: string
  actor: Actor
  inline: Surface
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

/** Several elements of one frame made addressable by id at once, in one annotation write
 *  (actions.stampElementIds): the boot backfill of comments anchored before element ids. Answers
 *  each selector's id, or that it is lost or failed; nothing for a frame being streamed into.
 *  Saved and shown when its operation commits, as every write. */
export type StampElementIdsCommand = {
  type: 'stamp-element-ids'
  frameId: string
  selectors: string[]
}

/** The next chunk of a stream into a frame (actions.appendFrameHtml): `start` begins it,
 *  replacing the design, `done` ends and settles it. With `inline`, refused when the chunk
 *  adds inline data, read joined to the end of the stream so far (`appendLocally`). */
export type AppendFrameHtmlCommand = {
  type: 'append-frame-html'
  frameId: string
  chunk: string
  actor: Actor
  start?: boolean
  done?: boolean
  inline?: Surface
}

/** An idle stream settled: its frame's whole-document pass and its close (actions.settleStream).
 *  `lastActivity`: when the stream was found idle, it had last received a chunk then; one that
 *  has received one since, or been begun again, is left open (answered false). */
export type SettleStreamCommand = { type: 'settle-stream'; frameId: string; lastActivity: number }

/** A stream closed without settling, once its settling failed (actions.closeStream); only the
 *  stream found idle, as `settle-stream`. */
export type CloseStreamCommand = { type: 'close-stream'; frameId: string; lastActivity: number }

/** Design tokens added (actions.createTokens): each entry as an agent or the panel sent it,
 *  checked by the host, one result per entry. Answers the results and the canvas's tokens as
 *  this write left them. */
export type CreateTokensCommand = { type: 'create-tokens'; tokens: unknown[]; actor: Actor }

/** Design tokens changed, renamed or deleted, in order (actions.setTokens). A rename rewrites
 *  the frames that name the token, as an annotation. A value change writes no frame where
 *  frames are stored lean (they name the token, and are composed with its value where they are
 *  rendered); one is written only where its source changes (a font face that comes or goes).
 *  Answers the results and the tokens as this write left them. */
export type SetTokensCommand = { type: 'set-tokens'; edits: TokenEdit[]; actor: Actor }

/** The canvas's token themes and their order, after renaming those in `renames`
 *  (actions.setTokenThemes). A theme rename also rewrites the frames that name it
 *  (`data-doop-theme`), as an annotation. Both as sent: the host checks them, and refuses a bad
 *  list by rejecting with `TokenThemesError`, nothing written. Answers the themes and the
 *  tokens as this write left them. */
export type SetTokenThemesCommand = {
  type: 'set-token-themes'
  themes: unknown
  renames?: unknown
  actor: Actor
}

/** A component made: from new markup (its main goes on the Components page) or from an element
 *  already in a frame (it becomes the main). componentActions.createComponentFromHtml / FromElement. */
export type CreateComponentCommand = {
  type: 'create-component'
  from: ({ kind: 'html' } & CreateFromHtml) | ({ kind: 'element' } & CreateFromElement)
  actor: Actor
  /** answer a `ComponentView` too (the agent tools); REST does not ask, and pays nothing for it */
  view?: boolean
}

/** Several components made from new markup, in order, each its own unit: one refused (or one
 *  that nests a component the canvas does not have) is reported and the rest are still made. */
export type CreateComponentsCommand = {
  type: 'create-components'
  entries: CreateFromHtml[]
  actor: Actor
  /** answer each made entry's view, and its reuse notes, as create_components showed them */
  view?: boolean
}

/** A component changed (componentActions.updateComponent): its template by find and replace
 *  or whole, its styles, name, description, props or code. */
export type UpdateComponentCommand = {
  type: 'update-component'
  component: string
  input: UpdateInput
  actor: Actor
  view?: boolean
}

/** A component deleted: no frame is written, its instances stop following it. */
export type DeleteComponentCommand = { type: 'delete-component'; component: string; actor: Actor }

/** A deleted component brought back, its instances linked again (a main written if it had none). */
export type RestoreComponentCommand = { type: 'restore-component'; component: string; actor: Actor; view?: boolean }

/** A component put back to one of its earlier revisions, as a new revision. */
export type RestoreComponentVersionCommand = {
  type: 'restore-component-version'
  component: string
  rev: number
  actor: Actor
  view?: boolean
}

/** An instance of a component placed in a frame (componentActions.insertInstance). */
export type InsertInstanceCommand = { type: 'insert-instance'; input: InsertInput; actor: Actor }

/** Instances in one frame changed in one step: props, overrides, resets, detaching
 *  (componentActions.changeInstances). With `view`, answers the frame's instances too, read
 *  in the write's own step (`undefined` when that is over the work budget). */
export type ChangeInstancesCommand = {
  type: 'change-instances'
  frameId: string
  changes: InstanceChange[]
  actor: Actor
  view?: boolean
}

/* ---- the background queue's frames, and detaching (server/propagation.ts) ---- */

/** One frame's turn in the propagation queue (actions.propagateIntoFrame): the frame rendered
 *  again from the components that changed, or rewritten where what it stores changed too. A
 *  frame mid-stream, out of memory or not using them is left as it is. Answers the queue's
 *  `FrameOutcome`, read in the write's own step. */
export type PropagateFrameCommand = {
  type: 'propagate-frame'
  frameId: string
  componentIds: string[]
  actor: Actor
}

/** One frame's turn in the detach queue (componentActions.detachInFrame): every instance of
 *  these components in it becomes plain markup that keeps its look; a frame mid-stream is
 *  deferred until its stream closes. */
export type DetachFrameCommand = {
  type: 'detach-frame'
  frameId: string
  componentIds: string[]
  actor: Actor
}

/** Every instance of a component cut loose, in the background (componentActions.detachAllInstances):
 *  queued with the commit, a frame per turn. Answers what was queued and the ids of the frames
 *  it will rewrite; with `frames` (the agent tools, which show them), those frames too, read in
 *  the write's own step. REST does not ask. */
export type DetachInstancesCommand = {
  type: 'detach-instances'
  component: string
  actor: Actor
  frames?: boolean
}

export type CanvasWrite =
  | PropagateFrameCommand
  | DetachFrameCommand
  | DetachInstancesCommand
  | InsertInstanceCommand
  | ChangeInstancesCommand
  | LibraryWrite
  | CreateComponentCommand
  | CreateComponentsCommand
  | UpdateComponentCommand
  | DeleteComponentCommand
  | RestoreComponentCommand
  | RestoreComponentVersionCommand
  | CreateTokensCommand
  | SetTokensCommand
  | SetTokenThemesCommand
  | CreateFrameCommand
  | AppendFrameHtmlCommand
  | SettleStreamCommand
  | CloseStreamCommand
  | WriteFrameCommand
  | EditFrameHtmlCommand
  | FrameMetaCommand
  | RestackFramesCommand
  | SetApprovalCommand
  | AgentApprovalCommand
  | DeleteFrameCommand
  | RestoreVersionCommand
  | StampElementIdCommand
  | StampElementIdsCommand

/** What an edit did: the frame as written, or why nothing was. `missing`: the frame (or its
 *  canvas) is not there. */
export type EditFrameHtmlResult =
  | { ok: true; frame: Frame }
  | { ok: false; missing: true }
  | { ok: false; problem: Exclude<FrameEdit, { html: string }> }
  | UnbalancedRefusal
  | InlineRefusal

/** An edit that would leave `<doop-use>` or `<template>` tags unpaired: refused, nothing
 *  written, with what to do instead (componentActions.unbalancedEdit). */
export type UnbalancedRefusal = { ok: false; unbalanced: Unbalanced }

/** A write an agent sent that would add inline data: refused, nothing written. The one shape
 *  of that refusal for every command, and only ever the answer to a command that may carry
 *  `inline` (`CanvasWriteResult`). */
export type InlineRefusal = { ok: false; inline: string }

/** What a chunk did: the frame as it now stands, or why nothing was written. */
export type AppendFrameHtmlResult = { ok: true; frame: Frame } | { ok: false; missing: true } | InlineRefusal

/** What a write of a component shows of it, for a command that asks (`view: true`), read in
 *  the same step as the write so no later write is mixed in: its catalog entry and the frames
 *  it touched (its instances' and its main's, and any others the write named). Absent when it
 *  could not be read (the canvas gone): the write stands all the same. What it should have
 *  reused (server/reuseNotes.ts) is the caller's to read, after the write, as it always was. */
export type ComponentView = {
  entry: ReturnType<typeof catalogEntry>
  frames: Frame[]
}

/** One entry of `create-components`: made, or refused with why. A made entry carries its view
 *  and its reuse notes when the command asked: each read when create_components always read
 *  them (the entry and the notes right after that entry was made, before the next; the frames
 *  once every entry was made, so a later entry nesting it counts). */
export type CreatedEntry =
  | { ok: true; component: ComponentDef; inferred: string[]; view?: ComponentView; notes?: string[] }
  | { ok: false; name: string; error: string }

/** What a stale version check answers with, over REST as before (409). */
export const FRAME_CHANGED = 'The frame changed while you were editing. Please try again.'

/** A command carried `ifUpdatedAt` and the frame has moved past it: nothing was written. */
export class FrameVersionConflict extends Error {
  readonly frame: Frame

  constructor(frame: Frame) {
    super(FRAME_CHANGED)
    this.frame = frame

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

/* ------------------------------------------------------------------ */
/* The workspace library, and components copied from another canvas:  */
/* what a canvas takes up from elsewhere, and pulls when it moves on.  */
/* ------------------------------------------------------------------ */

/** A component taken up from another canvas, with what it is built from
 *  (componentActions.importComponent): from a workspace library of this canvas, linked to what
 *  it published (and the library's tokens it names, carried along); from any other canvas, a
 *  copy with a main of its own. Who may read `from` is the caller's check. */
export type ImportComponentCommand = {
  type: 'import-component'
  /** the canvas it comes from */
  from: string
  /** its name or id there */
  component: string
  actor: Actor
  /** answer its `ComponentView` too (the agent tools) */
  view?: boolean
}

/** One component brought up to its origin (componentActions.syncComponent): what its workspace
 *  library last published, or a copied one's source canvas as it is now. */
export type SyncComponentCommand = {
  type: 'sync-component'
  component: string
  /** the canvases the caller may read (`readableSources`): a copied component is pulled only
   *  from one of these */
  readable: readonly string[]
  actor: Actor
  view?: boolean
}

/** Every workspace-library update waiting on the canvas pulled, all or none. */
export type SyncLibraryUpdatesCommand = {
  type: 'sync-library-updates'
  /** the canvases the caller may read, as `sync-component` */
  readable: readonly string[]
  actor: Actor
  /** answer the frames the pulls touched, read once every pull is made */
  view?: boolean
}

/** A library's latest publication pulled into one canvas using it (`updateLibraryConsumers`,
 *  server/libraryUpdates.ts, sends one per canvas, and commits each before the next). A
 *  refusal part of the way keeps what was pulled before it and is answered as `refusal`;
 *  anything else takes back the whole pull. */
export type PullLibraryCommand = { type: 'pull-library'; library: string; actor: Actor }

/** The library's tokens these linked components name, created where the canvas lacks them
 *  (actions.carryLibraryTokens): what a frame write that took components up sends once it
 *  has landed (`carryAdoptedTokensWith`). Answers the tokens it created. */
export type CarryLibraryTokensCommand = { type: 'carry-library-tokens'; components: readonly string[]; actor: Actor }

export type LibraryWrite =
  | ImportComponentCommand
  | SyncComponentCommand
  | SyncLibraryUpdatesCommand
  | PullLibraryCommand
  | CarryLibraryTokensCommand

/** The library's commands on the local host. Each view is read in the write's own step, and
 *  only when asked; one that cannot be read (the canvas gone, the work budget spent) is left
 *  out, and the write stands. */
const libraryHost = {
  'import-component': (canvasId, command) => {
    const component = importComponent(canvasId, command.from, command.component, command.actor)
    return { component, ...optionalView(command.view, canvasId, component) }
  },
  'sync-component': (canvasId, command) => {
    const readable = new Set(command.readable)
    const { component, updated } = syncComponent(canvasId, command.component, command.actor, (id) => readable.has(id))
    return { component, updated, ...optionalView(command.view, canvasId, component) }
  },
  'sync-library-updates': (canvasId, command) => {
    const canvas = store.getCanvas(canvasId)
    if (!canvas) throw new ComponentError('canvas not found')
    const waiting = waitingLibraryUpdates(canvas)
    const readable = new Set(command.readable)
    /* all of them or none, as sync_component always pulled them. One pulled with an earlier
       one (that one is built from it) has nothing left to pull */
    const updated = transaction(() =>
      waiting.flatMap((def) => {
        const result = syncComponent(canvasId, def.id, command.actor, (id) => readable.has(id))
        return result.updated ? [result.component] : []
      }),
    )
    if (!command.view) return { waiting: waiting.length, updated }
    /* after every pull, so building it spends nothing ahead of a write */
    const frames = optional(() => {
      const touched = new Map<string, Frame>()
      for (const def of updated) for (const frame of touchedFrames(canvas, def)) touched.set(frame.id, frame)
      return [...touched.values()]
    })
    return { waiting: waiting.length, updated, ...(frames ? { frames } : {}) }
  },
  'pull-library': (canvasId, command) => {
    const canvas = store.getCanvas(canvasId)
    const library = store.getCanvas(command.library)
    if (!canvas || !library) return { update: undefined, refusal: undefined }
    /* one unit: anything that is not a refusal takes back this canvas's whole pull. Committing
       it is the caller's decision (updateLibraryConsumers commits between canvases) */
    return transaction(() => pullIntoConsumer(canvas, library, command.actor))
  },
  'carry-library-tokens': (canvasId, command) => {
    const wanted = new Set(command.components)
    const adopted = store.getComponents(canvasId).filter((def) => wanted.has(def.id))
    return actions.carryLibraryTokens(canvasId, adopted, command.actor)
  },
} satisfies {
  [Type in LibraryWrite['type']]: (canvasId: string, command: Extract<LibraryWrite, { type: Type }>) => unknown
}

/** A component's view when asked, unless it cannot be read: never the write's failure. */
function optionalView(asked: boolean | undefined, canvasId: string, def: ComponentDef): { view?: ComponentView } {
  if (!asked) return {}
  return optional(() => viewIf(true, canvasId, def)) ?? {}
}

/** The canvases the components on `canvasId` came from that the caller may read: every
 *  canvas a pull there could ask about (`syncComponent` asks only of a component's source),
 *  so a sync command carries the caller's read check as data, answering as it would have. */
export function readableSources(canvasId: string, canRead: (canvasId: string) => boolean): string[] {
  const sources = new Set(store.getComponents(canvasId).flatMap((def) => (def.source ? [def.source.canvasId] : [])))
  return [...sources].filter((id) => canRead(id))
}

/** Carry the tokens of components a frame write took up, through the entry, once that write
 *  has landed. It runs as work of its own after a commit (actions.announceAdopted), where
 *  nothing awaits it: a rejection is logged. The carry creates its tokens in one unit
 *  (createTokens is atomic), so a failure leaves nothing of it behind. */
function carryAdoptedTokens(canvasId: string, components: string[], actor: Actor) {
  runCanvasWrite(canvasId, { type: 'carry-library-tokens', components, actor }).catch((error: unknown) =>
    console.error(`[library] could not carry the tokens of components taken up on ${canvasId}`, error),
  )
}

/* ------------------------------------------------------------------ */

/** The local host: each command's handler, the server's own actions. What a command answers
 *  is whatever its handler returns (`CanvasWriteResults`), so the two cannot drift apart. */
const local = {
  ...libraryHost,
  'create-component': (canvasId, command) => {
    const { from, actor } = command
    if (from.kind === 'html') {
      const { kind: _kind, ...input } = from
      const created = createComponentFromHtml(canvasId, input, actor)
      return {
        ...created,
        changed: [] as Frame[],
        ...viewIf(command.view, canvasId, created.component),
      }
    }
    const { kind: _kind, ...input } = from
    const created = createComponentFromElement(canvasId, input, actor)
    return {
      ...created,
      /* the frame the element was in, as this write left it: what an editor needs to undo it */
      changed: store.getFrame(input.frameId) ? [store.getFrame(input.frameId)!] : [],
      ...viewIf(command.view, canvasId, created.component, [input.frameId]),
    }
  },
  'insert-instance': (canvasId, command) => insertInstance(canvasId, command.input, command.actor),
  'change-instances': (canvasId, command) => {
    const changed = changeInstances(canvasId, command.frameId, command.changes, command.actor)
    /* the change is in: reading the instances back is a courtesy the budget may not cover (and
       undefined, so left out of an answer, unless asked for) */
    return { ...changed, instances: command.view ? optional(() => instancesIn(changed.frame)) : undefined }
  },
  'propagate-frame': (canvasId, command) =>
    actions.propagateIntoFrame(canvasId, command.frameId, command.componentIds, command.actor),
  'detach-frame': (canvasId, command) => detachInFrame(canvasId, command.frameId, command.componentIds, command.actor),
  'detach-instances': (canvasId, command) => {
    const queued = detachAllInstances(canvasId, command.component, command.actor)
    if (!command.frames) return { ...queued, touched: undefined }
    const ids = new Set(queued.frameIds)
    return { ...queued, touched: (store.getCanvas(canvasId)?.frames ?? []).filter((frame) => ids.has(frame.id)) }
  },
  'create-components': (canvasId, command) => createComponentsLocally(canvasId, command),
  'update-component': (canvasId, command) => {
    const result = updateComponent(canvasId, command.component, command.input, command.actor)
    return { ...result, ...viewIf(command.view, canvasId, result.component) }
  },
  'delete-component': (canvasId, command) => deleteComponent(canvasId, command.component, command.actor),
  'restore-component': (canvasId, command) => {
    const restored = restoreComponent(canvasId, command.component, command.actor)
    return { ...restored, ...viewIf(command.view, canvasId, restored.component) }
  },
  'restore-component-version': (canvasId, command) => {
    const result = restoreComponentVersion(canvasId, command.component, command.rev, command.actor)
    return { ...result, ...viewIf(command.view, canvasId, result.component) }
  },
  'create-frame': (canvasId, command): Frame | InlineRefusal | undefined => {
    const inline = command.inline && inlineDataRefusal(command.input.html, '', command.inline)
    if (inline) return { ok: false, inline }
    return actions.createFrame(canvasId, command.input, command.actor)
  },
  'write-frame': (_canvasId, command): Frame | InlineRefusal | undefined => {
    /* a frame that is not there holds nothing: the check never depends on the lookup */
    const frame = store.getFrame(command.frameId)
    const inline =
      command.inline &&
      inlineDataRefusal(command.patch.html, frame ? heldOf(frame, command.inline) : '', command.inline)
    if (inline) return { ok: false, inline }
    return actions.updateFrame(command.frameId, command.patch, command.actor, command.replace ? { replace: true } : {})
  },
  'append-frame-html': (_canvasId, command) => appendLocally(command),
  'settle-stream': (_canvasId, command) => actions.settleStream(command.frameId, command.lastActivity),
  'close-stream': (_canvasId, command) => actions.closeStream(command.frameId, command.lastActivity),
  /* the tokens are read in the same step as the write, so no other write can come between */
  'create-tokens': (canvasId, command) => {
    const results = actions.createTokens(canvasId, command.tokens, command.actor)
    return results && { results, tokens: store.getTokens(canvasId) }
  },
  'set-tokens': (canvasId, command) => {
    const results = actions.setTokens(canvasId, command.edits, command.actor)
    return results && { results, tokens: store.getTokens(canvasId) }
  },
  'set-token-themes': (canvasId, command) => {
    const themes = actions.setTokenThemes(canvasId, command.themes, command.actor, command.renames ?? [])
    return themes && { themes, tokens: store.getTokens(canvasId) }
  },
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
  'stamp-element-ids': (_canvasId, command) => actions.stampElementIds(command.frameId, command.selectors),
} satisfies {
  [Type in CanvasWrite['type']]: (canvasId: string, command: Extract<CanvasWrite, { type: Type }>) => unknown
}

/** What each command answers, as its handler answers it. `undefined` is "no such frame (or
 *  canvas)", as the actions say it; `restore-version`'s `null` is "no such version". */
export type CanvasWriteResults = { [Type in keyof typeof local]: Awaited<ReturnType<(typeof local)[Type]>> }

/** Can this command carry `inline`, a surface that may be defined? Not when it has no such
 *  field, or one that is only ever undefined. */
type MayCheckInline<C> = 'inline' extends keyof C
  ? [Exclude<C['inline' & keyof C], undefined>] extends [never]
    ? false
    : true
  : false

/** What this command answers: an inline-data refusal exactly when it may carry `inline`. */
export type CanvasWriteResult<C extends CanvasWrite> =
  MayCheckInline<C> extends true ? CanvasWriteResults[C['type']] : Exclude<CanvasWriteResults[C['type']], InlineRefusal>

/** Run a write on a canvas's frames, on the host that owns that canvas's writes (today always
 *  the local one). `canvasId` is the canvas the command writes to. Always a promise; a failure
 *  is its rejection. */
export function runCanvasWrite<const C extends CanvasWrite>(
  canvasId: string,
  command: C,
): Promise<CanvasWriteResult<C>> {
  try {
    checkCommand(canvasId, command)
    /* refused alike wherever it runs: it depends on the command alone */
    const unbalanced = command.type === 'edit-frame-html' && unbalancedEdit(command.find, command.replace)
    if (unbalanced) return Promise.resolve({ ok: false, unbalanced } as CanvasWriteResult<C>)
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
  const inline = inlineDataRefusal(edit.html, () => heldForms(frame), command.inline)
  if (inline) return { ok: false, inline }
  const written = actions.updateFrame(command.frameId, { html: edit.html }, command.actor)
  return written ? { ok: true, frame: written } : { ok: false, missing: true }
}

/** A component's view (`ComponentView`), when the command asked and the canvas is there to read
 *  it from; nothing otherwise, which never fails the write it follows. */
function viewIf(
  asked: boolean | undefined,
  canvasId: string,
  def: ComponentDef,
  extra: readonly string[] = [],
): { view?: ComponentView } {
  if (!asked) return {}
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return {}
  return { view: { entry: catalogEntry(canvas, def), frames: touchedFrames(canvas, def, extra) } }
}

/** The components a new main names in a <doop-use> that resolved to nothing, by the name it gave. */
function missingNested(def: ComponentDef): string[] {
  if (!def.mainFrameId) return []
  const refs = actions
    .peekComponentIssues(def.mainFrameId)
    .filter((issue) => issue.code === 'unknown_component')
    .map((issue) => /“([^”]*)”/.exec(issue.message)?.[1] ?? '')
  return [...new Set(refs)]
}

/** `create-components`: each entry its own unit (a savepoint of the caller's operation), so a
 *  refused one leaves nothing behind and the rest go on, as create_components always made them.
 *  A spent work budget is not an entry's refusal: it rejects the whole command. */
function createComponentsLocally(canvasId: string, command: CreateComponentsCommand): CreatedEntry[] {
  const refused: string[] = []
  const results = command.entries.map((entry): CreatedEntry => {
    try {
      const created = transaction(() => {
        const made = createComponentFromHtml(canvasId, entry, command.actor)
        /* a <doop-use> naming nothing renders as nothing: saved, the entry would lose that part
           for good, so it is refused (undone with this unit) and can be sent again once that
           one exists */
        const missing = missingNested(made.component)
        if (missing.length)
          throw new ComponentError(
            `it nests ${missing.map((ref) => (ref ? `“${ref}”` : 'a <doop-use> that could not be read')).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not a component on this canvas${refused.length ? ' (an entry this call refused, or one never made)' : ''}; nothing was made for it`,
          )
        return made
      })
      const canvas = command.view ? store.getCanvas(canvasId) : undefined
      if (!canvas) return { ok: true, component: created.component, inferred: created.inferred }
      /* where create_components read them: right after this entry, before the next is made */
      const notes = optional(() => componentReuseNotes(canvas, created.component, entry.autoProps)) ?? []
      return {
        ok: true,
        component: created.component,
        inferred: created.inferred,
        notes,
        view: { entry: catalogEntry(canvas, created.component), frames: [] },
      }
    } catch (error) {
      if (!(error instanceof ComponentError || error instanceof WriteRefusedError)) throw error
      refused.push(entry.name)
      return { ok: false, name: entry.name, error: error.message }
    }
  })
  /* the frames each one touched, once every entry is made, as create_components read them */
  const canvas = command.view ? store.getCanvas(canvasId) : undefined
  if (canvas)
    for (const result of results)
      if (result.ok && result.view) result.view.frames = touchedFrames(canvas, result.component)
  return results
}

/** What a surface counts as already in a frame when it rewrites it whole: over MCP every form
 *  the agent may have read it in (`heldForms`), for the resident its stored HTML alone. Read
 *  lazily: only once the incoming HTML holds a candidate. */
function heldOf(frame: Frame, surface: Surface): Existing {
  if (surface === 'mcp') return () => heldForms(frame)
  return () => storedHtmlOf(frame)
}

/** A stream's chunk: the inline-data check the MCP tool made, then the append. */
function appendLocally(command: AppendFrameHtmlCommand): AppendFrameHtmlResult {
  const current = store.getFrame(command.frameId)
  if (!current) return { ok: false, missing: true }
  if (command.inline) {
    /* the agent's own text: the end of its stream so far joined to this chunk, so a data:
       URI's prefix split across chunks is caught, and so is a block of base64 text sent in
       pieces each too short to be one. Never the stored HTML of a stream in progress, where
       a component's image expanded mid-stream would read as an upload; but a chunk appended
       after its stream ended is joined to the frame as stored, so the end of that is what it
       is read with. Compared with the design the stream replaced: a rework may carry over
       what the frame had. */
    /* read once for both checks below, and only if one finds a candidate */
    let read: string | undefined
    const base = () => (read ??= actions.streamBase(command.frameId) ?? current.html)
    const before = command.start
      ? ''
      : (actions.streamTail(command.frameId) ?? current.html.slice(-EMBEDDED_MIN_LENGTH))
    const refusal = inlineDataRefusal(before + command.chunk, base, command.inline)
    /* refused only for what it completes: the earlier pieces are in the frame already */
    const completes = refusal && before && !inlineDataRefusal(command.chunk, base, command.inline)
    const inline = completes
      ? `${refusal.replace('Refused, nothing was written:', 'Refused, this chunk was not written:')}\nThe size above counts what your earlier chunks sent too: the start of that block is already in the frame. Begin the frame again (start=true) and stream it without the block.`
      : refusal
    if (inline) return { ok: false, inline }
  }
  const frame = actions.appendFrameHtml(command.frameId, command.chunk, command.actor, {
    ...(command.start !== undefined ? { start: command.start } : {}),
    ...(command.done !== undefined ? { done: command.done } : {}),
  })
  return frame ? { ok: true, frame } : { ok: false, missing: true }
}

/* ------------------------------------------------------------------ */
/* Imports and ingest: frames brought in from elsewhere (a webpage,    */
/* Meta, the design-sync snippet, a GitHub repo).                      */
/* They use the commands above; this is how they call the entry.       */
/* ------------------------------------------------------------------ */

/** How an import that takes its frame maker as a dependency (a webpage) makes a frame: as
 *  the entry makes it, always a promise, a failure only its rejection. */
export type CreateImportedFrame = (
  canvasId: string,
  input: CreateFrameCommand['input'],
  actor: Actor,
) => Promise<Frame | undefined>

/** The rejections of imports' own writes, told apart from the imports' own failures */
const importWriteFailures = new WeakSet<Error>()

/**
 * A frame write an import makes, through the entry. Inside a transaction (a request, an MCP or
 * resident tool call) it is a savepoint of it: a rejection leaves nothing of this write and goes
 * on to undo the rest. Outside one (an import that answered its request first and goes on, an
 * automation, a timer) it is an operation of its own, committed by itself, as such an import's
 * writes always were. A rejection is marked (`isImportWriteFailure`) so that an import's catch,
 * which answers a capture or a download that failed, passes it on to the operation instead.
 */
export async function runImportWrite<const C extends CanvasWrite>(
  name: string,
  canvasId: string,
  command: C,
): Promise<CanvasWriteResult<C>> {
  try {
    if (inTransaction()) return await transaction(() => runCanvasWrite(canvasId, command))
    return await runOperation(name, canvasId, () => runCanvasWrite(canvasId, command))
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    importWriteFailures.add(failure)
    throw failure
  }
}

/** Did this error come from an import's write (`runImportWrite`), not from the import itself? */
export function isImportWriteFailure(error: unknown): error is Error {
  return error instanceof Error && importWriteFailures.has(error)
}

/** One frame of an import that lands frame after frame (a website's pages, Meta): each
 *  frame its own unit (`runImportWrite`), and one refused is answered as `{ ok: false }`, not
 *  rejected, with nothing of it left behind. The frames before it stand, the import reports this
 *  one as failed and goes on, and it never rejects after landing some. A spent work budget
 *  inside a request or tool call is not a frame's refusal: it rejects, and the call is undone
 *  (outside one, each frame has a budget of its own, so it is that frame's). */
export async function landImportFrame<const C extends CanvasWrite>(
  name: string,
  canvasId: string,
  command: C,
): Promise<{ ok: true; result: CanvasWriteResult<C> } | { ok: false; error: Error }> {
  const inside = inTransaction()
  try {
    return { ok: true, result: await runImportWrite(name, canvasId, command) }
  } catch (error) {
    if (!(error instanceof Error) || (inside && error instanceof WorkBudgetError)) throw error
    return { ok: false, error }
  }
}

/* ------------------------------------------------------------------ */
/* What the server runs through this entry by itself: idle streams on  */
/* a clock.                                                            */
/* ------------------------------------------------------------------ */

let settling = false

/** How often a stream's settling may fail for something other than its work budget before
 *  the stream is closed unsettled, as one refused for its budget is. */
export const SETTLE_ATTEMPTS = 3
/** How long after a failed settling the next try waits: 1 s after the first, 5 s after the
 *  second; the third failure closes the stream. */
export const SETTLE_RETRY_MS = [1_000, 5_000] as const
/** frame id → the failed settlings of the stream found idle (its `lastActivity`), and when
 *  it may be tried again */
const failedSettles = new Map<string, { lastActivity: number; attempts: number; retryAt: number }>()

/** How many streams are waiting to retry a failed settling (for tests). */
export function settleRetriesPending(): number {
  return failedSettles.size
}

/** Settle every stream nobody has sent to for a while (actions.idleStreams), each in an
 *  operation of its own through the entry, and only while it is still the stream found idle
 *  (a chunk that arrives while an earlier one settles keeps it open). One refused for its work
 *  budget is closed instead, so it does not stay open; the frame's next write settles it. One
 *  that fails otherwise is tried again after `SETTLE_RETRY_MS`, its error logged once, and
 *  closed the same way after `SETTLE_ATTEMPTS`. One pass at a time. Never rejects: it runs on a
 *  timer, where a rejection would be unhandled. */
export async function settleIdleStreams(now = Date.now()): Promise<void> {
  if (settling) return
  settling = true
  try {
    /* a stream that failed once and has closed another way since needs no retry */
    for (const frameId of failedSettles.keys()) if (!actions.isFrameMidStream(frameId)) failedSettles.delete(frameId)
    for (const idle of actions.idleStreams(now)) await settleOne(idle, now)
  } catch (error) {
    console.error('[streams] settling idle streams failed', error)
  } finally {
    settling = false
  }
}

async function settleOne({ frameId, canvasId, lastActivity }: actions.IdleStream, now: number) {
  const failed = failedSettles.get(frameId)
  if (failed?.lastActivity === lastActivity && now < failed.retryAt) return
  /* a frame that is gone has no canvas to route by; its stream only closes */
  const route = canvasId ?? ''
  try {
    await runOperation(`settle stream of frame ${frameId}`, canvasId, () =>
      runCanvasWrite(route, { type: 'settle-stream', frameId, lastActivity }),
    )
    failedSettles.delete(frameId)
  } catch (error) {
    if (error instanceof WorkBudgetError) {
      failedSettles.delete(frameId)
      console.error(`[streams] ${error.message}`)
      return closeUnsettled(frameId, canvasId, lastActivity, 'its settling ran out of work budget')
    }
    const attempts = failed?.lastActivity === lastActivity ? failed.attempts + 1 : 1
    if (attempts === 1) console.error(`[streams] settling the stream of frame ${frameId} failed`, error)
    if (attempts < SETTLE_ATTEMPTS) {
      const wait = SETTLE_RETRY_MS[attempts - 1] ?? SETTLE_RETRY_MS[1]
      failedSettles.set(frameId, { lastActivity, attempts, retryAt: now + wait })
      return
    }
    failedSettles.delete(frameId)
    return closeUnsettled(frameId, canvasId, lastActivity, `its settling failed ${attempts} times`)
  }
}

/** Close a stream without settling it; never throws, whatever goes wrong. */
async function closeUnsettled(frameId: string, canvasId: string | undefined, lastActivity: number, why: string) {
  try {
    const closed = await runOperation(`close stream of frame ${frameId}`, canvasId, () =>
      runCanvasWrite(canvasId ?? '', { type: 'close-stream', frameId, lastActivity }),
    )
    if (closed) console.error(`[streams] closed the stream of frame ${frameId} unsettled: ${why}`)
  } catch (error) {
    console.error('[streams] could not close', frameId, error)
  }
}

let wired = false

/**
 * Hand the server's own write work to this entry: idle streams settled on the playback tick
 * (actions.ts), and the tokens a library adoption carries. Called once at boot by the server (server/index.ts), and by a test that runs
 * it. Until it is called, idle streams do not settle.
 */
export function wireCanvasWrites() {
  if (wired) return
  wired = true
  actions.settleIdleStreamsWith((now) => void settleIdleStreams(now))
  actions.carryAdoptedTokensWith(carryAdoptedTokens)
}

/* The queue's frames go through the entry as this module loads, so every caller of the queue
   (a changed main, a detach) has its frame writes routed wherever the server runs, not only
   once `wireCanvasWrites` is called. Each turn is its own operation (propagation.visit), so a
   rejected command undoes that frame alone; the queue says so and goes on. */
propagation.routeFrameTask('propagate', (canvasId, frameId, componentIds, actor) =>
  runCanvasWrite(canvasId, { type: 'propagate-frame', frameId, componentIds, actor }),
)
propagation.routeFrameTask('detach', (canvasId, frameId, componentIds, actor) =>
  runCanvasWrite(canvasId, { type: 'detach-frame', frameId, componentIds, actor }),
)
