import WebSocket from 'ws'
import { actors, type SocketGrant } from '../generated/actors/index.js'
import { env } from './env.ts'
import { CANVAS_ACTORS, featureFlags } from './featureFlags.ts'
import { sortByStack } from '../shared/frameStack.ts'
import { colorFor } from '../shared/types.ts'
import type { ActorFrame, FramesEvent, FramesSnapshot, ServerWrite, SocketMetadata } from '../src/actor.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'

/**
 * Canvases on Terse canvas actors: the ones made by an owner with the
 * canvas-actors feature flag. Everything here runs for those canvases only;
 * every other canvas never reaches this file and works exactly as on main.
 *
 * The server stays the hub, as on main. It keeps these canvases in memory
 * like any other and saves their frames to the actor where main writes the
 * Postgres frames table (db/persist.ts calls in here). Pages, history,
 * activity and the room stay where main keeps them. Browsers on these
 * canvases send their frame edits straight to the actor (src/lib/actorFrames.ts);
 * the server follows the actor's socket and folds those edits into its copy
 * through actions.updateFrame, so the room, history and activity see them.
 *
 * While one of the server's own writes to a frame is on its way, browser edits
 * to that frame are not folded in: they would put back a state the server has
 * moved past. Once the write lands, the frame is read back from the actor.
 */

/** Wire the store in; actions does this when it loads. */
export function wireActorFrames(hooks: ActorFrameHooks) {
  storeHooks = hooks
}

export function isActorCanvas(canvasId: string): boolean {
  return followed.has(canvasId)
}

/** A frame of a canvas on an actor (deletions name only the frame). */
export function isActorFrame(frameId: string): boolean {
  return frameCanvas.has(frameId)
}

/** Decide, at creation, whether a new canvas keeps its frames on an actor. */
export function placeCanvas(canvas: Canvas) {
  if (!env.TERSE_ACTOR_URL || !featureFlags.has(canvas.ownerId, CANVAS_ACTORS)) return
  canvas.frameStore = 'actor'
  follow(canvas.id)
}

/** At boot, before the store takes the canvases: fill the frames of those on
 *  actors. One that cannot be read in time starts empty and fills in when its
 *  actor answers, so an actor outage never holds up the server. */
export async function loadActorCanvases(canvases: readonly Canvas[]): Promise<void> {
  const onActors = canvases.filter((canvas) => canvas.frameStore === 'actor')
  await Promise.all(
    onActors.map(async (canvas) => {
      const state = followed.get(canvas.id) ?? track(canvas.id)
      try {
        const snapshot = await withTimeout(stub(canvas.id).snapshot(), BOOT_TIMEOUT_MS)
        state.revision = snapshot.revision
        canvas.frames = sortByStack(snapshot.frames.map((frame) => remember(toFrame(frame))))
      } catch (error) {
        console.error('[canvas actors] could not load', canvas.id, error)
        state.missing = true
      }
      /* only now: the socket's first snapshot then fills in a canvas the read above missed */
      void connect(state)
    }),
  )
}

/** main's persist.saveFrame for a canvas on an actor. */
export function saveActorFrame(frame: Frame) {
  frameCanvas.set(frame.id, frame.canvasId)
  const entry = outgoing(frame.id, frame.canvasId)
  entry.frame = frame
  send(frame.id)
}

/** main's persist.saveFrameNow: resolves once the actor holds the frame. */
export function saveActorFrameNow(frame: Frame): Promise<void> {
  saveActorFrame(frame)
  return settled(frame.id)
}

/** main's persist.deleteFrame for a frame of a canvas on an actor. */
export function deleteActorFrame(frameId: string) {
  const canvasId = frameCanvas.get(frameId)
  if (!canvasId) return
  outgoing(frameId, canvasId).frame = null
  send(frameId)
}

/** Copied frames (a canvas or page copy), stored before the copy is published. */
export async function insertActorFrames(canvasId: string, frames: readonly Frame[]): Promise<void> {
  for (const batch of batches(frames)) {
    await stub(canvasId).save(batch.map((frame) => ({ type: 'put', frame: toActorFrame(frame) })))
    for (const frame of batch) {
      frameCanvas.set(frame.id, canvasId)
      remember({ ...frame })
    }
  }
}

/** A copy that failed: its frames come off the actor, retried like any write. */
export function removeActorFrames(canvasId: string, frames: readonly Frame[]) {
  for (const frame of frames) {
    frameCanvas.set(frame.id, canvasId)
    deleteActorFrame(frame.id)
  }
}

/** The canvas was deleted: its actor drops every frame and closes its sockets. */
export function destroyActorCanvas(canvasId: string) {
  const state = followed.get(canvasId)
  if (state) {
    state.stopped = true
    clearTimeout(state.retry)
    state.socket?.close()
    followed.delete(canvasId)
  }
  for (const [frameId, owner] of frameCanvas) {
    if (owner !== canvasId) continue
    frameCanvas.delete(frameId)
    saved.delete(frameId)
    outbox.delete(frameId)
  }
  stub(canvasId)
    .destroy()
    .catch((error: unknown) => console.error('[canvas actors] destroy failed', canvasId, error))
}

/** Every write still on its way has landed (shutdown). */
export async function flushActorFrames(): Promise<void> {
  await Promise.allSettled([...outbox.keys()].map(settled))
}

/** A socket to the canvas's actor, or undefined when `access` finds none.
 *  `access` is asked only after the actor's access version is read: rights
 *  that change in between are either seen here or void the ticket. */
export async function actorFrameGrant(
  canvasId: string,
  access: () => Omit<SocketMetadata, 'accessVersion'> | undefined,
): Promise<SocketGrant | undefined> {
  const accessVersion = await stub(canvasId).accessVersion()
  const metadata = access()
  if (!metadata) return undefined
  return actors.CanvasActor.prepareWebsocket({ actorId: canvasId, metadata: { ...metadata, accessVersion } })
}

/** Someone's access to the canvas changed: its actor closes open sockets and
 *  voids older tickets. Retried until the actor confirms, since only it can. */
export function revokeActorAccess(canvasId: string) {
  if (!followed.has(canvasId)) return
  let revocation = revocations.get(canvasId)
  if (!revocation) revocations.set(canvasId, (revocation = { running: false, again: false, attempts: 0 }))
  revocation.again = true
  revoke(canvasId, revocation)
}

/** How the store takes frames in from an actor without saving them back. */
export interface ActorFrameHooks {
  /** a browser's edit, as the actor committed it */
  adopt(frame: Frame, by: Actor): void
  /** frames of a canvas whose actor answered after boot; false while the store does not have the canvas yet */
  restore(canvasId: string, frames: Frame[], by: Actor): boolean
}

type Followed = {
  canvasId: string
  socket?: WebSocket
  retry?: ReturnType<typeof setTimeout>
  attempts: number
  stopped: boolean
  revision: number
  /** boot could not read its frames; they are restored on the next snapshot */
  missing: boolean
}

type Revocation = {
  running: boolean
  /** an access change came after the running call started, or the call failed */
  again: boolean
  attempts: number
}

type Outgoing = {
  canvasId: string
  /** the frame as it should end up; null deletes it */
  frame: Frame | null
  sending: boolean
  /** a browser edit arrived meanwhile: read the frame back once this settles */
  skipped: boolean
  attempts: number
  waiters: (() => void)[]
}

let storeHooks: ActorFrameHooks | undefined
const followed = new Map<string, Followed>()
const frameCanvas = new Map<string, string>()
/** each frame as its actor last confirmed it */
const saved = new Map<string, Frame>()
/** frames with a write pending or on its way, at most one write each */
const outbox = new Map<string, Outgoing>()
const revocations = new Map<string, Revocation>()

const BOOT_TIMEOUT_MS = 5000
const RESTORE_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000
const BATCH_BYTES = 4_000_000
const SERVER: Actor = { name: 'Doop', kind: 'user', color: '#9c9b99' }
/** every field a frame carries besides its identity */
const FIELDS = [
  'pageId',
  'name',
  'x',
  'y',
  'width',
  'height',
  'html',
  'updatedAt',
  'updatedBy',
  'demo',
  'hidden',
  'locked',
  'z',
  'approval',
] as const satisfies readonly (keyof Frame)[]

function stub(canvasId: string) {
  return actors.CanvasActor.get(canvasId)
}

function outgoing(frameId: string, canvasId: string): Outgoing {
  let entry = outbox.get(frameId)
  if (!entry) {
    entry = { canvasId, frame: null, sending: false, skipped: false, attempts: 0, waiters: [] }
    outbox.set(frameId, entry)
  }
  return entry
}

/** Send what changed since the actor's last confirmation; repeat until nothing has. */
function send(frameId: string) {
  const entry = outbox.get(frameId)
  if (!entry || entry.sending) return
  const write = nextWrite(frameId, entry.frame)
  if (!write) return finish(frameId, entry)
  const sentFrame = entry.frame && { ...entry.frame }
  entry.sending = true
  stub(entry.canvasId)
    .save([write])
    .then(
      () => {
        entry.attempts = 0
        if (sentFrame) saved.set(frameId, sentFrame)
        else {
          saved.delete(frameId)
          /* gone from the actor: unless it was saved again meanwhile (an undo), nothing is left to send */
          if (!entry.frame) frameCanvas.delete(frameId)
        }
      },
      (error: unknown) => {
        console.error('[canvas actors] save failed; retrying', frameId, error)
        entry.attempts++
      },
    )
    .finally(() => {
      entry.sending = false
      if (!entry.attempts) return send(frameId)
      setTimeout(() => send(frameId), Math.min(MAX_RETRY_MS, 500 * 2 ** entry.attempts))
    })
}

function nextWrite(frameId: string, frame: Frame | null): ServerWrite | undefined {
  const known = saved.get(frameId)
  if (!frame) return known || frameCanvas.has(frameId) ? { type: 'delete', id: frameId } : undefined
  if (!known) return { type: 'put', frame: toActorFrame(frame) }
  const patch: Record<string, unknown> = {}
  for (const field of FIELDS)
    if (JSON.stringify(frame[field] ?? null) !== JSON.stringify(known[field] ?? null))
      patch[field] = frame[field] ?? null
  return Object.keys(patch).length ? { type: 'patch', id: frameId, patch } : undefined
}

function finish(frameId: string, entry: Outgoing) {
  outbox.delete(frameId)
  for (const resolve of entry.waiters.splice(0)) resolve()
  if (!entry.frame) {
    frameCanvas.delete(frameId)
    return
  }
  if (!entry.skipped) return
  stub(entry.canvasId)
    .frame(frameId)
    .then((latest) => latest && consider(latest, undefined))
    .catch((error: unknown) => console.error('[canvas actors] read back failed', frameId, error))
}

function revoke(canvasId: string, revocation: Revocation) {
  if (revocation.running) return
  if (!followed.has(canvasId)) return void revocations.delete(canvasId)
  revocation.running = true
  revocation.again = false
  stub(canvasId)
    .revokeAccess()
    .then(
      () => (revocation.attempts = 0),
      (error: unknown) => {
        console.error('[canvas actors] revoke failed; retrying', canvasId, error)
        revocation.again = true
        revocation.attempts++
      },
    )
    .finally(() => {
      revocation.running = false
      if (!revocation.again) return void revocations.delete(canvasId)
      if (!revocation.attempts) return revoke(canvasId, revocation)
      setTimeout(() => revoke(canvasId, revocation), Math.min(MAX_RETRY_MS, 500 * 2 ** revocation.attempts))
    })
}

function settled(frameId: string): Promise<void> {
  const entry = outbox.get(frameId)
  return entry ? new Promise((resolve) => entry.waiters.push(resolve)) : Promise.resolve()
}

/** Follow a canvas's actor for the edits browsers write to it directly. */
function follow(canvasId: string): Followed {
  let state = followed.get(canvasId)
  if (state) return state
  state = track(canvasId)
  void connect(state)
  return state
}

function track(canvasId: string): Followed {
  const state: Followed = { canvasId, attempts: 0, stopped: false, revision: -1, missing: false }
  followed.set(canvasId, state)
  return state
}

async function connect(state: Followed) {
  try {
    const grant = await actorFrameGrant(state.canvasId, () => ({ by: SERVER, readOnly: true }))
    if (state.stopped || !grant) return
    const socket = new WebSocket(grant.websocketUrl)
    state.socket = socket
    socket.on('open', () => (state.attempts = 0))
    socket.on('message', (data) => {
      if (state.socket === socket) receive(state, JSON.parse(String(data)) as Received)
    })
    socket.on('error', () => socket.close())
    // An access change closes actor sockets; reconnecting takes a fresh grant.
    socket.on('close', () => {
      if (state.socket === socket) reconnect(state)
    })
  } catch (error) {
    console.error('[canvas actors] follow failed', state.canvasId, error)
    reconnect(state)
  }
}

function reconnect(state: Followed) {
  if (state.stopped || state.retry) return
  state.attempts++
  state.retry = setTimeout(
    () => {
      state.retry = undefined
      void connect(state)
    },
    Math.min(MAX_RETRY_MS, 500 * 2 ** state.attempts),
  )
}

type Received =
  FramesSnapshot | { type: 'state_update'; changes: { committed?: FramesEvent | null } } | { type: string }

function receive(state: Followed, message: Received) {
  if (message.type === 'frames-snapshot') return reconcile(state, message as FramesSnapshot)
  if (message.type !== 'state_update') return
  const event = (message as { changes: { committed?: FramesEvent | null } }).changes.committed
  if (!event || event.revision <= state.revision) return
  if (event.revision > state.revision + 1) {
    state.socket?.send(JSON.stringify({ type: 'snapshot' }))
    return
  }
  state.revision = event.revision
  if (event.type === 'frame-edit') consider(event.frame, event.by)
}

/** A snapshot (on connect, or after a missed change): fold in what changed meanwhile. */
function reconcile(state: Followed, snapshot: FramesSnapshot) {
  if (snapshot.revision < state.revision) return
  state.revision = snapshot.revision
  if (state.missing) {
    const frames = snapshot.frames.map(toFrame)
    /* the store takes the canvas in after boot: until it has, ask again */
    if (!storeHooks?.restore(state.canvasId, frames, SERVER)) {
      setTimeout(() => {
        if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'snapshot' }))
      }, RESTORE_RETRY_MS).unref()
      return
    }
    state.missing = false
    for (const frame of frames) remember(frame)
    return
  }
  for (const frame of snapshot.frames) consider(frame, undefined)
}

/** A frame as the actor holds it: take it in unless the server has it already or is mid-write. */
function consider(actorFrame: ActorFrame, by: Actor | undefined) {
  const entry = outbox.get(actorFrame.id)
  if (entry) {
    entry.skipped = true
    return
  }
  const known = saved.get(actorFrame.id)
  if (!known || known.updatedAt >= actorFrame.updatedAt) return
  const frame = remember(toFrame(actorFrame))
  storeHooks?.adopt(frame, by ?? { name: frame.updatedBy, kind: 'user', color: colorFor(frame.updatedBy) })
}

function remember(frame: Frame): Frame {
  frameCanvas.set(frame.id, frame.canvasId)
  saved.set(frame.id, { ...frame })
  return frame
}

/** The actor's frame type is shared/types.ts `Frame` field for field. */
function toFrame(frame: ActorFrame): Frame {
  return frame
}

function toActorFrame(frame: Frame): ActorFrame {
  return frame
}

/** Copies in calls small enough for the actor's request limit. */
function batches(frames: readonly Frame[]): Frame[][] {
  const out: Frame[][] = []
  let size = Infinity
  for (const frame of frames) {
    if (size + frame.html.length > BATCH_BYTES) {
      out.push([])
      size = 0
    }
    out.at(-1)!.push(frame)
    size += frame.html.length
  }
  return out
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms).unref()),
  ])
}
