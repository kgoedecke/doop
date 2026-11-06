import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import { repairEscapedHtml } from './escapedHtml.ts'
import * as frameRows from './db/frameRows.ts'
import * as persist from './db/persist.ts'
import { validateFrame } from '../shared/frame-validation.ts'
import { samePages } from '../shared/pages.ts'
import { frontOf, type StackWrite } from '../shared/frameStack.ts'
import type {
  CanvasCommand,
  CanvasEvent,
  CanvasSnapshot,
  CanvasSummary,
  FrameChange,
  FrameDrag,
  FrameEdit,
  FramePatch,
  FrameWriteConflict,
  PageUpdate,
  SocketMetadata,
} from '../src/actor.ts'
import type { actors } from '../generated/actors/index.js'
import type { ActivityItem, Actor, CanvasPageInfo, Frame, FrameVersion, FrameVersionInfo } from '../shared/types.ts'

/**
 * A canvas whose pages and frames are not in a Terse canvas actor: the same
 * methods and the same socket protocol as `CanvasActor` (src/actor.ts), run in
 * this process, with frames in the Postgres `frames` table (db/frameRows.ts)
 * and design history in `frame_versions`, as on main. Browsers cannot tell
 * the two apart: they get a socket URL from /api/canvases/:id/actor either way.
 *
 * Calls run one at a time per canvas, like an actor's invocation queue. The
 * frames stay in memory once loaded; edits are written through.
 */
export class PostgresCanvas implements actors.CanvasActor.Stub {
  private initialized = false
  private deleted = false
  /** Starts from the clock, so a browser that reconnects after a restart sees newer revisions. */
  private revision = Date.now() * 1000
  private accessRevision = 0
  private pages: CanvasPageInfo[] = []
  private activity: ActivityItem[] = []
  private bursts = new Map<string, Burst>()
  /** In canvas order: the order they were loaded or created. */
  private frames = new Map<string, Frame>()
  private loaded: Promise<void> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private connections = new Set<FrameConnection>()

  constructor(readonly canvasId: string) {}

  /* ------------------------------------------------------------ sockets */

  /** A browser or the room's feed subscribed; it gets the canvas at once. */
  connect(connection: FrameConnection) {
    this.run(async () => {
      if ((connection.metadata.accessVersion ?? 0) !== this.accessRevision)
        return connection.close(4003, 'Access changed')
      this.connections.add(connection)
      connection.send(this.snapshotNow())
    }).catch((error: unknown) => {
      console.error('[canvas frames] connect failed', this.canvasId, error)
      connection.close(1011, 'canvas unavailable')
    })
  }

  disconnect(connection: FrameConnection) {
    this.connections.delete(connection)
  }

  receive(connection: FrameConnection, command: CanvasCommand) {
    this.run(async () => {
      if ((connection.metadata.accessVersion ?? 0) !== this.accessRevision)
        return connection.close(4003, 'Access changed')
      if (command.type === 'snapshot') return connection.send(this.snapshotNow())
      if (command.type === 'drag') return this.relayDrag(connection, command)
      try {
        if (connection.metadata.readOnly) throw new Error('This connection is read only')
        // Sign-off and annotation writes carry server-checked identity.
        if (command.write.type === 'update' && (command.write.patch.approval !== undefined || command.write.annotation))
          throw new Error('Approval changes must use the frame API')
        const result = await this.writeNow(command.frameId, command.write, connection.metadata.actor, command.requestId)
        if (!result) throw new Error('Frame not found')
        if (result.type === 'conflict') throw new Error('Frame changed. Reload it and try again.')
      } catch (error) {
        connection.send({
          type: 'error',
          requestId: command.requestId,
          message: error instanceof Error ? error.message : 'Frame edit failed',
        })
      }
    }).catch((error: unknown) => console.error('[canvas frames] message failed', this.canvasId, error))
  }

  /* ------------------------------------------------- CanvasActor methods */

  accessVersion(): Promise<number> {
    return this.run(async () => this.accessRevision)
  }

  revokeAccess(): Promise<void> {
    return this.run(async () => {
      this.accessRevision++
      for (const connection of [...this.connections]) connection.close(4003, 'Access changed')
      this.connections.clear()
    })
  }

  /** Bring copied frames in before the canvas opens. Repeats are ignored. */
  importFrames(input: Frame[], creator: Actor['kind'] | null = null): Promise<void> {
    return this.run(async () => {
      if (this.initialized) throw new Error('Frames are imported before the canvas opens')
      for (const entry of input) {
        if (this.frames.has(entry.id)) continue
        const frame = { ...entry, html: repairEscapedHtml(entry.html) }
        validateFrame(frame)
        await frameRows.insertFrameRow(frame)
        this.frames.set(frame.id, frame)
        if (creator) this.bursts.set(frame.id, creatorBurst(frame, creator))
      }
    })
  }

  /** Open the canvas with its pages; frames on a page that no longer exists land on the first. */
  initialize(pages: CanvasPageInfo[]): Promise<CanvasSnapshot> {
    return this.run(async () => {
      if (!this.initialized) {
        if (!pages.length) throw new Error('A canvas must have a page')
        const known = new Set(pages.map((page) => page.id))
        for (const frame of this.frames.values()) {
          if (frame.pageId && known.has(frame.pageId)) continue
          const moved = { ...frame, pageId: pages[0]!.id }
          frameRows.saveFrameRow(moved)
          this.frames.set(moved.id, moved)
        }
        this.pages = pages
        this.initialized = true
        this.revision++
        this.commit(this.snapshotNow())
      }
      return this.snapshotNow()
    })
  }

  snapshot(): Promise<CanvasSnapshot> {
    return this.run(async () => this.snapshotNow())
  }

  summary(): Promise<CanvasSummary> {
    return this.run(async () => ({
      initialized: this.initialized,
      deleted: this.deleted,
      pages: this.pages,
      frames: [...this.frames.values()].map(({ html: _html, ...frame }) => frame),
      activity: this.activity,
    }))
  }

  frame(id: string): Promise<Frame | null> {
    return this.run(async () => (this.deleted ? null : (this.frames.get(id) ?? null)))
  }

  pageOf(id: string): Promise<string | null> {
    return this.run(async () => (this.deleted ? null : (this.frames.get(id)?.pageId ?? null)))
  }

  /** Add a frame; `automatic` places it right of the page's other frames. A retried create returns the frame. */
  createFrame(input: Frame, by: Actor, automatic: boolean): Promise<Frame | null> {
    return this.run(async () => {
      if (!this.initialized || this.deleted || !this.pages.some((page) => page.id === input.pageId)) return null
      const existing = this.frames.get(input.id)
      if (existing) return existing
      let frame: Frame = { ...input, html: repairEscapedHtml(input.html) }
      const onPage = this.pageFrames(frame.pageId!)
      if (automatic) frame = { ...frame, x: onPage.length ? Math.max(...onPage.map((f) => f.x + f.width)) + 80 : 120 }
      if (frame.z === undefined) frame = { ...frame, z: frontOf(onPage) ?? frame.createdAt }
      validateFrame(frame)
      await frameRows.insertFrameRow(frame)
      this.frames.set(frame.id, frame)
      this.bursts.set(frame.id, creatorBurst(frame, by.kind))
      this.commit({ type: 'frame-change', revision: ++this.revision, frame, operation: 'insert', actor: by })
      return frame
    })
  }

  write(
    frameId: string,
    write: FrameEdit,
    by: Actor,
    requestId?: string,
  ): Promise<FrameChange | FrameWriteConflict | null> {
    return this.run(() => this.writeNow(frameId, write, by, requestId))
  }

  /** Remove a frame; returns what was removed. Its history goes with it (actions.deleteFrame). */
  deleteFrame(frameId: string, by: Actor): Promise<Frame | null> {
    return this.run(async () => {
      if (this.deleted) return null
      const frame = this.frames.get(frameId)
      if (!frame) return null
      await frameRows.deleteFrameRow(frameId)
      this.frames.delete(frameId)
      this.bursts.delete(frameId)
      this.commit({ type: 'frame-removal', revision: ++this.revision, frameId, actor: by })
      return frame
    })
  }

  /** Rename, reorder, add or delete pages. A page that still holds frames stays. */
  setPages(pages: CanvasPageInfo[], expectedPages: CanvasPageInfo[]): Promise<PageUpdate> {
    return this.run(async () => {
      const current = this.pages
      if (this.deleted) return { pages: current, error: 'deleted' as const }
      if (!samePages(expectedPages, current)) return { pages: current, error: 'conflict' as const }
      if (!pages.length || new Set(pages.map((page) => page.id)).size !== pages.length)
        throw new Error('Provide at least one page with unique IDs')
      const kept = new Set(pages.map((page) => page.id))
      if ([...this.frames.values()].some((frame) => !kept.has(frame.pageId!)))
        return { pages: current, error: 'occupied' as const }
      /* a page-list save never moves a flow start or recolours a page */
      this.pages = pages.map(({ startFrameId: _start, background: _background, ...page }) => {
        const previous = current.find((existing) => existing.id === page.id)
        return {
          ...page,
          ...(previous?.startFrameId ? { startFrameId: previous.startFrameId } : {}),
          ...(previous?.background ? { background: previous.background } : {}),
        }
      })
      this.commit({ type: 'pages-change', revision: ++this.revision, pages: this.pages })
      return { pages: this.pages }
    })
  }

  /** Add a page after `afterPageId` (or last) together with its frames, for page copies. */
  addPage(page: CanvasPageInfo, afterPageId: string, input: Frame[], by: Actor): Promise<PageUpdate> {
    return this.run(async () => {
      const current = this.pages
      if (this.deleted) return { pages: current, error: 'deleted' as const }
      if (current.some((existing) => existing.id === page.id)) return { pages: current, error: 'conflict' as const }
      const copies = input.map((frame) => ({ ...frame, pageId: page.id, html: repairEscapedHtml(frame.html) }))
      for (const frame of copies) {
        validateFrame(frame)
        if (this.frames.has(frame.id)) throw new Error(`Frame ${frame.id} already exists`)
      }
      for (const frame of copies) await frameRows.insertFrameRow(frame)
      for (const frame of copies) {
        this.frames.set(frame.id, frame)
        this.bursts.set(frame.id, creatorBurst(frame, by.kind))
      }
      const at = current.findIndex((existing) => existing.id === afterPageId)
      const pages = [...current]
      pages.splice(at === -1 ? current.length : at + 1, 0, page)
      this.pages = pages
      this.revision++
      this.commit(this.snapshotNow())
      return { pages }
    })
  }

  setFlowStart(pageId: string, frameId: string | null): Promise<CanvasPageInfo[] | null> {
    return this.updatePage(pageId, (page) => {
      const { startFrameId: _previous, ...rest } = page
      return frameId ? { ...rest, startFrameId: frameId } : rest
    })
  }

  setPageBackground(pageId: string, background: string | null): Promise<CanvasPageInfo[] | null> {
    return this.updatePage(pageId, (page) => {
      const { background: _previous, ...rest } = page
      return background ? { ...rest, background } : rest
    })
  }

  /** Several frames' places in their page's stack: all checked before any is written. */
  restack(writes: StackWrite[], by: Actor): Promise<Frame[] | null> {
    return this.run(async () => {
      if (!this.initialized || this.deleted) return null
      if (!writes.every((write) => Number.isFinite(write.z))) throw new Error('Each z must be a finite number')
      if (!writes.every((write) => this.frames.has(write.id))) return null
      const now = Date.now()
      const restacked = writes.map(({ id, z }) => {
        const before = this.frames.get(id)!
        const frame: Frame = { ...before, z, updatedAt: Math.max(now, before.updatedAt + 1), updatedBy: by.name }
        this.frames.set(id, frame)
        frameRows.saveFrameRow(frame)
        return frame
      })
      if (restacked.length === 1)
        this.commit({
          type: 'frame-change',
          revision: ++this.revision,
          frame: restacked[0]!,
          operation: 'update',
          actor: by,
        })
      else if (restacked.length) {
        this.revision++
        this.commit(this.snapshotNow())
      }
      return restacked
    })
  }

  /** Design history is read from frame_versions by actions.listFrameVersions. */
  async listVersions(_frameId: string): Promise<FrameVersionInfo[]> {
    return []
  }

  async getVersion(_frameId: string, _versionId: string): Promise<FrameVersion | null> {
    return null
  }

  /** Delete the canvas's frames; the store removes the rest of its rows. */
  destroy(): Promise<void> {
    return this.run(async () => {
      if (this.deleted) return
      await frameRows.deleteCanvasFrameRows(this.canvasId, [...this.frames.keys()])
      this.frames.clear()
      this.activity = []
      this.bursts.clear()
      this.initialized = true
      this.deleted = true
      this.revision++
      this.commit(this.snapshotNow())
    })
  }

  /* ------------------------------------------------------------ internals */

  /** One call at a time, after the canvas's frames are loaded. */
  private run<T>(work: () => Promise<T>): Promise<T> {
    this.loaded ??= frameRows.loadFrameRows(this.canvasId).then(
      (frames) => {
        for (const frame of frames) if (!this.frames.has(frame.id)) this.frames.set(frame.id, frame)
      },
      (error: unknown) => {
        /* the next call tries again */
        this.loaded = undefined
        throw error
      },
    )
    const loaded = this.loaded
    const result = this.queue
      .catch(() => {})
      .then(async () => {
        await loaded
        return work()
      })
    this.queue = result
    return result
  }

  private snapshotNow(): CanvasSnapshot {
    return {
      type: 'canvas-snapshot',
      revision: this.revision,
      initialized: this.initialized,
      deleted: this.deleted,
      pages: this.pages,
      frames: [...this.frames.values()],
      activity: this.activity,
    }
  }

  private pageFrames(pageId: string, except?: string): Frame[] {
    return [...this.frames.values()].filter((frame) => frame.pageId === pageId && frame.id !== except)
  }

  /** Tell every subscriber, as an actor's committed state update does. */
  private commit(event: CanvasEvent) {
    for (const connection of this.connections) connection.send({ type: 'state_update', changes: { committed: event } })
  }

  private relayDrag(from: FrameConnection, command: FrameDrag) {
    const current = this.frames.get(command.frameId)
    if (
      from.metadata.readOnly ||
      this.deleted ||
      !current ||
      current.updatedAt !== command.updatedAt ||
      ![command.x, command.y, command.width, command.height].every(Number.isFinite) ||
      command.width <= 0 ||
      command.height <= 0
    )
      return
    const { frameId, x, y, width, height, updatedAt } = command
    for (const connection of this.connections)
      if (connection !== from) connection.send({ type: 'drag', frameId, x, y, width, height, updatedAt })
  }

  private updatePage(
    pageId: string,
    change: (page: CanvasPageInfo) => CanvasPageInfo,
  ): Promise<CanvasPageInfo[] | null> {
    return this.run(async () => {
      if (this.deleted || !this.pages.some((page) => page.id === pageId)) return null
      this.pages = this.pages.map((page) => (page.id === pageId ? change(page) : page))
      this.commit({ type: 'pages-change', revision: ++this.revision, pages: this.pages })
      return this.pages
    })
  }

  private async writeNow(
    frameId: string,
    write: FrameEdit,
    by: Actor,
    requestId?: string,
  ): Promise<FrameChange | FrameWriteConflict | null> {
    if (!this.initialized || this.deleted) return null
    const before = this.frames.get(frameId)
    if (!before) return null
    // Checked in this queue, so two saves from the same version cannot both land.
    if (
      write.type === 'update' &&
      write.expectedUpdatedAt !== undefined &&
      write.expectedUpdatedAt !== before.updatedAt
    )
      return { type: 'conflict', frame: before }
    // A page deleted while the move was in flight cannot receive it.
    if (write.type === 'update' && write.patch.pageId !== undefined) {
      if (!this.pages.some((page) => page.id === write.patch.pageId)) return null
    }
    if (write.type === 'replace') {
      if (!write.find) throw new Error('find must be a non-empty exact HTML string')
      const count = before.html.split(write.find).length - 1
      if (count === 0) throw new Error('find text not found in the frame HTML. Read the current HTML and retry.')
      if (count > 1) throw new Error('find text occurs more than once. Include more surrounding context.')
    }
    const patch: FramePatch =
      write.type === 'append'
        ? { html: (write.start ? '' : before.html) + write.chunk }
        : write.type === 'replace'
          ? { html: before.html.replace(write.find, write.replacement) }
          : Object.fromEntries(
              Object.entries(write.patch).filter(
                ([key, value]) => PATCHABLE.includes(key as keyof FramePatch) && value !== undefined,
              ),
            )
    if (write.type !== 'append' && patch.html !== undefined) patch.html = repairEscapedHtml(patch.html)
    /* a frame moved to another page lands in front there, as Figma does */
    if (patch.pageId !== undefined && patch.pageId !== before.pageId && patch.z === undefined) {
      const front = frontOf(this.pageFrames(patch.pageId, frameId))
      if (front !== undefined) patch.z = front
    }
    const frame: Frame = {
      ...before,
      ...patch,
      updatedAt: Math.max(Date.now(), before.updatedAt + 1),
      updatedBy: by.name,
    }
    if (!frame.hidden) delete frame.hidden
    if (!frame.locked) delete frame.locked
    if (frame.approval === null) delete frame.approval
    // Every design writer (streams, syncs and restores included) invalidates sign-off.
    const annotation = write.type === 'update' && write.annotation
    const designChanged =
      !annotation && (frame.html !== before.html || frame.width !== before.width || frame.height !== before.height)
    if (designChanged && frame.approval?.status === 'ready_for_dev')
      frame.approval = { ...frame.approval, status: 'needs_review' }
    validateFrame(frame)
    this.frames.set(frameId, frame)
    frameRows.saveFrameRow(frame) // debounced: a stream's chunks land as one write per burst
    if (!annotation && frame.html !== before.html)
      this.bursts.set(
        frameId,
        noteHtmlChange(this.bursts.get(frameId) ?? null, before, by, isTweak(write, before.html, frame.html)),
      )
    const change: FrameChange = {
      type: 'frame-change',
      revision: ++this.revision,
      frame,
      operation: write.type,
      actor: by,
      ...(requestId ? { requestId } : {}),
      ...(write.type === 'append' ? { streaming: !write.done } : {}),
      ...(write.type === 'update' && write.partial ? { partial: true } : {}),
    }
    if (requestId && !annotation && (frame.html !== before.html || frame.name !== before.name)) {
      change.activity = {
        id: requestId,
        actorName: by.name,
        actorKind: by.kind,
        actorColor: by.color,
        frameId,
        at: frame.updatedAt,
        message:
          frame.html !== before.html
            ? `updated the design of “${frame.name}”`
            : `renamed “${before.name}” to “${frame.name}”`,
      }
      this.activity = [change.activity, ...this.activity].slice(0, 100)
      persist.saveActivity(this.canvasId, change.activity)
    }
    this.commit(change)
    return change
  }
}

/** One subscriber to a canvas: a browser's socket, or the room's feed in this process. */
export interface FrameConnection {
  readonly metadata: SocketMetadata
  send(message: FrameSocketMessage): void
  close(code: number, reason: string): void
}

/** What a canvas sends its subscribers, as a canvas actor's socket does. */
export type FrameSocketMessage =
  | CanvasSnapshot
  | FrameDrag
  | { type: 'state_update'; changes: { committed: CanvasEvent } }
  | { type: 'error'; requestId: string; message: string }

/** The canvas's in-process stand-in for its actor. */
export function postgresCanvas(canvasId: string): PostgresCanvas {
  let canvas = canvases.get(canvasId)
  if (!canvas) {
    canvas = new PostgresCanvas(canvasId)
    canvases.set(canvasId, canvas)
  }
  return canvas
}

/** A one-time, short-lived ticket a browser trades for a socket at /ws/frames. */
export function issueFrameTicket(canvasId: string, metadata: SocketMetadata): { ticket: string; expiresAt: number } {
  const now = Date.now()
  for (const [key, entry] of tickets) if (entry.expiresAt < now) tickets.delete(key)
  const ticket = randomBytes(24).toString('base64url')
  const expiresAt = now + TICKET_TTL_MS
  tickets.set(ticket, { canvasId, metadata, expiresAt })
  return { ticket, expiresAt }
}

/** The canvas and metadata a ticket was issued for; each ticket works once. */
export function redeemFrameTicket(ticket: string): { canvasId: string; metadata: SocketMetadata } | undefined {
  const entry = tickets.get(ticket)
  tickets.delete(ticket)
  if (!entry || entry.expiresAt < Date.now()) return undefined
  return { canvasId: entry.canvasId, metadata: entry.metadata }
}

/** Forget every loaded canvas (tests). */
export function resetPostgresCanvases() {
  canvases.clear()
  tickets.clear()
}

const canvases = new Map<string, PostgresCanvas>()
const tickets = new Map<string, { canvasId: string; metadata: SocketMetadata; expiresAt: number }>()
const TICKET_TTL_MS = 60_000
const PATCHABLE: readonly (keyof FramePatch)[] = [
  'name',
  'pageId',
  'x',
  'y',
  'width',
  'height',
  'html',
  'hidden',
  'locked',
  'approval',
  'z',
]

/* Design history, as the canvas actor keeps it: per BURST of edits, filing the
   state a burst starts from. A full replace always opens a burst; a small
   tweak joins the open one when the same actor made it within BURST_IDLE_MS. */
type Burst = { actorName: string; actorKind: Actor['kind']; lastAt: number }
const BURST_IDLE_MS = 2 * 60_000

/** The frame's author keeps editing the design it was created with. */
function creatorBurst(frame: Frame, kind: Actor['kind']): Burst {
  return { actorName: frame.updatedBy, actorKind: kind, lastAt: frame.createdAt }
}

/** File the state a new burst replaces (frame_versions); a tweak by the burst's actor joins it. */
function noteHtmlChange(open: Burst | null, prior: Frame, by: Actor, tweak: boolean): Burst {
  const now = Date.now()
  const burst = { actorName: by.name, actorKind: by.kind, lastAt: now }
  const joins =
    tweak &&
    open !== null &&
    open.actorName === by.name &&
    open.actorKind === by.kind &&
    now - open.lastAt < BURST_IDLE_MS
  if (joins || !prior.html) return burst
  /* persist skips a state identical to the newest one it holds */
  persist.saveFrameVersion({
    id: nanoid(12),
    frameId: prior.id,
    canvasId: prior.canvasId,
    html: prior.html,
    width: prior.width,
    height: prior.height,
    htmlBytes: prior.html.length,
    savedAt: open?.lastAt ?? prior.updatedAt,
    savedBy: open?.actorName ?? prior.updatedBy,
    ...(open?.actorKind ? { savedByKind: open.actorKind } : {}),
  })
  return burst
}

/** A write that may join the open burst: a stream's later chunks, or a replace that keeps most of both documents. */
function isTweak(write: FrameEdit, before: string, after: string): boolean {
  if (write.type === 'append') return !write.start
  if (write.type === 'update' && write.replace) return false
  const shared = sharedSpan(before, after)
  return shared >= after.length * 0.5 && shared >= before.length * 0.5
}

function sharedSpan(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < n && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < n - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  return prefix + suffix
}
