import { and, desc, eq, getTableColumns, inArray, ne, notInArray, sql } from 'drizzle-orm'
import { Actor, Compute, Emittable, Ephemeral, Persisted, type ActorContext, type ActorSocketOf } from 'terse-sdk/actor'
import { drizzle, migrate, type DurableActorsDatabase } from 'terse-sdk/drizzle'
import { repairEscapedHtml } from '../server/escapedHtml.js'
import { validateFrame } from '../shared/frame-validation.js'
import { samePages } from '../shared/pages.js'
import type { StackWrite } from '../shared/frameStack.js'
import type {
  ActivityItem,
  Actor as Attribution,
  CanvasPageInfo,
  Frame,
  FrameVersion,
  FrameVersionInfo,
} from '../shared/types.js'
import migrations from './actor-db/migrations/migrations.js'
import * as schema from './actor-db/schema.js'

const { frames, versions } = schema

export type FrameInput = Pick<Frame, 'name'> &
  Partial<Pick<Frame, 'pageId' | 'x' | 'y' | 'width' | 'height' | 'html' | 'demo' | 'hidden' | 'locked' | 'z'>>
export type FramePatch = Partial<
  Pick<Frame, 'name' | 'pageId' | 'x' | 'y' | 'width' | 'height' | 'html' | 'hidden' | 'locked' | 'approval' | 'z'>
>
/** Rejected writes that a caller can act on, rather than errors. */
export type FrameWriteConflict = { type: 'conflict'; frame: Frame }
export type FrameWrite =
  | { type: 'create'; id?: string; input: FrameInput }
  | { type: 'update'; id: string; patch: FramePatch }
  | { type: 'delete'; id: string }

export type FrameEdit =
  | {
      type: 'update'
      patch: FramePatch
      /** Refuse the write unless the frame is still at this version. */
      expectedUpdatedAt?: number
      /** The HTML change only marks elements up (a `data-doop-id` stamp), so sign-off stands. */
      annotation?: boolean
      /** A deliberate whole-document write: it always opens a design-history burst. */
      replace?: boolean
      /** The document is a stream cut off before its end: viewers heal it before painting. */
      partial?: boolean
    }
  | { type: 'replace'; find: string; replacement: string }
  | { type: 'append'; chunk: string; start: boolean; done?: boolean }
export type CanvasSnapshot = {
  type: 'canvas-snapshot'
  revision: number
  initialized: boolean
  deleted: boolean
  pages: CanvasPageInfo[]
  /** in canvas order */
  frames: Frame[]
  activity: ActivityItem[]
}
export type CanvasSummary = Omit<CanvasSnapshot, 'type' | 'revision' | 'frames'> & { frames: Omit<Frame, 'html'>[] }
export type FrameChange = {
  type: 'frame-change'
  revision: number
  frame: Frame
  /** `insert` is a new frame: created, or the first write of a copy. */
  operation: FrameEdit['type'] | 'insert'
  actor: Attribution
  requestId?: string
  activity?: ActivityItem
  streaming?: boolean
  /** an unfinished stream's document: heal it (shared/frame-html.ts) before painting */
  partial?: boolean
}
export type FrameRemoval = { type: 'frame-removal'; revision: number; frameId: string; actor: Attribution }
export type PagesChange = { type: 'pages-change'; revision: number; pages: CanvasPageInfo[] }
export type CanvasEvent = CanvasSnapshot | FrameChange | FrameRemoval | PagesChange
export type FrameDrag = { type: 'drag'; frameId: string } & Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'updatedAt'>
export type CanvasCommand =
  { type: 'snapshot' } | FrameDrag | { type: 'write'; frameId: string; write: FrameEdit; requestId: string }
export type SocketMetadata = { actor: Attribution; readOnly: boolean; accessVersion?: number }
export type PageUpdate = { pages: CanvasPageInfo[]; error?: 'conflict' | 'occupied' | 'deleted' }
type SyncError = { type: 'error'; requestId: string; message: string }

type Orm = DurableActorsDatabase<typeof schema>
const { position: _position, ...frameColumns } = getTableColumns(frames)
const { html: _html, ...summaryColumns } = frameColumns
/** Frames leave out the flags they do not carry, as they do everywhere else. */
function toFrame<T extends Omit<typeof frames.$inferSelect, 'position' | 'html'>>({
  demo,
  hidden,
  locked,
  approval,
  z,
  ...row
}: T) {
  return {
    ...row,
    ...(z === null ? {} : { z }),
    ...(demo === null ? {} : { demo }),
    ...(hidden ? { hidden: true } : {}),
    ...(locked ? { locked: true } : {}),
    ...(approval === null ? {} : { approval }),
  }
}
function toRow(frame: Frame) {
  return {
    id: frame.id,
    canvasId: frame.canvasId,
    pageId: frame.pageId!,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    createdAt: frame.createdAt,
    updatedAt: frame.updatedAt,
    updatedBy: frame.updatedBy,
    demo: frame.demo ?? null,
    hidden: frame.hidden ? true : null,
    locked: frame.locked ? true : null,
    approval: frame.approval ?? null,
    z: frame.z ?? null,
    html: frame.html,
  }
}
async function readFrame(orm: Orm, id: string): Promise<Frame | null> {
  const row = await orm.select(frameColumns).from(frames).where(eq(frames.id, id)).get()
  return row ? toFrame(row) : null
}
/** The `z` that puts a frame in front of every other one on its page, or
 *  undefined on an empty page (shared/frameStack.ts `frontOf`). */
async function frontOfPage(orm: Orm, pageId: string, except?: string): Promise<number | undefined> {
  const row = await orm
    .select({ top: sql<number | null>`MAX(COALESCE(${frames.z}, ${frames.createdAt}))` })
    .from(frames)
    .where(except === undefined ? eq(frames.pageId, pageId) : and(eq(frames.pageId, pageId), ne(frames.id, except)))
    .get()
  return row?.top === null || row?.top === undefined ? undefined : row.top + 1
}

/** Add a frame after every other one; the caller has validated it and checked its page. */
async function insertFrame(orm: Orm, frame: Frame) {
  await orm
    .insert(frames)
    .values({ ...toRow(frame), position: sql`(SELECT COALESCE(MAX(${frames.position}), -1) + 1 FROM ${frames})` })
}

/* Design history: a frame's HTML history is kept per BURST of edits, not per
   write — a stream's chunks, an agent's tweak right after its redesign, a
   human typing in the Inspector are each one burst. What gets filed is the
   state a burst starts from, so a one-shot replace or stream can never leave
   itself as the only copy of a design. A full replace always opens a burst;
   a small tweak joins the open one when the same actor made it within
   BURST_IDLE_MS. Browser edits reach the actor directly, so it keeps this. */
type Burst = { actorName: string; actorKind: Attribution['kind']; lastAt: number }
const BURST_IDLE_MS = 2 * 60_000
const MAX_FRAME_VERSIONS = 50
const { html: _versionHtml, ...versionInfoColumns } = getTableColumns(versions)
const newestFirst = [desc(versions.savedAt), desc(sql`rowid`)]
/** The frame's author keeps editing the design it was created with. */
const creatorBurst = (frame: Frame, kind: Attribution['kind']): Burst => ({
  actorName: frame.updatedBy,
  actorKind: kind,
  lastAt: frame.createdAt,
})

/** Where two documents diverge, and how much they share at the start plus the
 *  end. An edit in one spot leaves nearly everything shared; only a rewrite
 *  scores low. */
function sharedSpan(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < n && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < n - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  return prefix + suffix
}

/** A write that may join the open burst: a stream's later chunks, or a replace
 *  that keeps most of both documents. */
function isTweak(write: FrameEdit, before: string, after: string): boolean {
  if (write.type === 'append') return !write.start
  if (write.type === 'update' && write.replace) return false
  const shared = sharedSpan(before, after)
  return shared >= after.length * 0.5 && shared >= before.length * 0.5
}

/** File the state a new burst replaces; a tweak by the burst's actor joins it.
 *  Returns the burst the write leaves open. */
async function noteHtmlChange(
  orm: Orm,
  open: Burst | null,
  prior: Frame,
  by: Attribution,
  tweak: boolean,
  versionId: string,
): Promise<Burst> {
  const now = Date.now()
  const burst = { actorName: by.name, actorKind: by.kind, lastAt: now }
  const joins =
    tweak &&
    open !== null &&
    open.actorName === by.name &&
    open.actorKind === by.kind &&
    now - open.lastAt < BURST_IDLE_MS
  if (joins || !prior.html) return burst
  /* a burst that ended where it began would file the same state twice. Size
     counts: the same document at another frame size is a state of its own */
  const latest = await orm
    .select({ html: versions.html, width: versions.width, height: versions.height })
    .from(versions)
    .where(eq(versions.frameId, prior.id))
    .orderBy(...newestFirst)
    .get()
  if (latest && latest.html === prior.html && latest.width === prior.width && latest.height === prior.height)
    return burst
  await orm.insert(versions).values({
    id: versionId,
    frameId: prior.id,
    html: prior.html,
    width: prior.width,
    height: prior.height,
    /* the open burst wrote this state; without one the frame's own stamp is the best attribution */
    savedAt: open?.lastAt ?? prior.updatedAt,
    savedBy: open?.actorName ?? prior.updatedBy,
    savedByKind: open?.actorKind ?? null,
  })
  const kept = orm
    .select({ id: versions.id })
    .from(versions)
    .where(eq(versions.frameId, prior.id))
    .orderBy(...newestFirst)
    .limit(MAX_FRAME_VERSIONS)
  await orm.delete(versions).where(and(eq(versions.frameId, prior.id), notInArray(versions.id, kept)))
  return burst
}

/** One canvas: its pages, its frames and their history share one writer, one
 *  invocation queue and one revision. A method that writes runs as one
 *  transaction, so every change to the canvas lands whole or not at all. */
@Compute({ idleTimeoutMs: 5000 })
export class CanvasActor extends Actor<SocketMetadata, CanvasCommand, CanvasSnapshot | FrameDrag | SyncError> {
  @Persisted private initialized = false
  @Persisted private deleted = false
  @Persisted private revision = 0
  @Persisted private accessRevision = 0
  @Persisted private pages: CanvasPageInfo[] = []
  @Persisted private activity: ActivityItem[] = []
  @Persisted private bursts: Record<string, Burst> = {}
  @Ephemeral private orm: Orm
  @Persisted @Emittable committed: CanvasEvent | null = null

  constructor(context: ActorContext) {
    super(context)
    migrate(this.db, migrations)
    this.orm = drizzle(this.db, { schema })
  }

  override async onConnect(socket: ActorSocketOf<CanvasActor>) {
    if ((socket.metadata.accessVersion ?? 0) !== this.accessRevision) return socket.reject(4003, 'Access changed')
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<CanvasActor>, command: CanvasCommand) {
    if ((socket.metadata.accessVersion ?? 0) !== this.accessRevision) return socket.close(4003, 'Access changed')
    if (command.type === 'snapshot') return socket.send(await this.snapshot())
    if (command.type === 'drag') {
      const current = await this.orm
        .select({ updatedAt: frames.updatedAt })
        .from(frames)
        .where(eq(frames.id, command.frameId))
        .get()
      if (
        socket.metadata.readOnly ||
        this.deleted ||
        !current ||
        current.updatedAt !== command.updatedAt ||
        ![command.x, command.y, command.width, command.height].every(Number.isFinite) ||
        command.width <= 0 ||
        command.height <= 0
      )
        return
      const { frameId, x, y, width, height, updatedAt } = command
      this.broadcast({ type: 'drag', frameId, x, y, width, height, updatedAt }, { except: socket })
      return
    }
    try {
      if (socket.metadata.readOnly) throw new Error('This connection is read only')
      // Sign-off and annotation writes carry server-checked identity.
      if (command.write.type === 'update' && (command.write.patch.approval !== undefined || command.write.annotation))
        throw new Error('Approval changes must use the frame API')
      const result = await this.write(command.frameId, command.write, socket.metadata.actor, command.requestId)
      if (!result) throw new Error('Frame not found')
      if (result.type === 'conflict') throw new Error('Frame changed. Reload it and try again.')
    } catch (error) {
      socket.send({
        type: 'error',
        requestId: command.requestId,
        message: error instanceof Error ? error.message : 'Frame edit failed',
      })
    }
  }

  async accessVersion(): Promise<number> {
    return this.accessRevision
  }

  async revokeAccess(): Promise<void> {
    this.accessRevision++
    for (const socket of await this.getConnections()) socket.close(4003, 'Access changed')
  }

  /** Bring legacy or copied frames in before the canvas opens, in batches that
   *  keep each call small. Repeats are ignored, so an interrupted import can
   *  run again. `creator` continues the copier's design history. */
  async importFrames(input: Frame[], creator: Attribution['kind'] | null = null): Promise<void> {
    if (this.initialized) throw new Error('Frames are imported before the canvas opens')
    await this.db.transaction(async () => {
      const bursts = { ...this.bursts }
      for (const entry of input) {
        if (await readFrame(this.orm, entry.id)) continue
        const frame = { ...entry, html: repairEscapedHtml(entry.html) }
        validateFrame(frame)
        await insertFrame(this.orm, frame)
        if (creator) bursts[frame.id] = creatorBurst(frame, creator)
      }
      this.bursts = bursts
    })
  }

  /** Open the canvas once its frames are in. Frames on a page that no longer
   *  exists land on the first page. Repeats change nothing. */
  async initialize(pages: CanvasPageInfo[]): Promise<CanvasSnapshot> {
    if (!this.initialized) {
      if (!pages.length) throw new Error('A canvas must have a page')
      await this.db.transaction(async () => {
        const known = pages.map((page) => page.id)
        await this.orm.update(frames).set({ pageId: pages[0]!.id }).where(notInArray(frames.pageId, known))
        // Persisted fields save on assignment, not on mutation.
        this.pages = pages
        this.initialized = true
        this.revision++
        this.committed = await this.snapshot()
      })
    }
    return this.snapshot()
  }

  async snapshot(): Promise<CanvasSnapshot> {
    const rows = await this.orm.select(frameColumns).from(frames).orderBy(frames.position)
    return {
      type: 'canvas-snapshot',
      revision: this.revision,
      initialized: this.initialized,
      deleted: this.deleted,
      pages: this.pages,
      frames: rows.map(toFrame),
      activity: this.activity,
    }
  }

  /** Dashboard, membership and activity reads omit HTML. */
  async summary(): Promise<CanvasSummary> {
    const rows = await this.orm.select(summaryColumns).from(frames).orderBy(frames.position)
    return {
      initialized: this.initialized,
      deleted: this.deleted,
      pages: this.pages,
      frames: rows.map(toFrame),
      activity: this.activity,
    }
  }

  async frame(id: string): Promise<Frame | null> {
    return this.deleted ? null : readFrame(this.orm, id)
  }

  /** The page a frame is on, or null when the canvas has no such frame. */
  async pageOf(id: string): Promise<string | null> {
    if (this.deleted) return null
    const row = await this.orm.select({ pageId: frames.pageId }).from(frames).where(eq(frames.id, id)).get()
    return row?.pageId ?? null
  }

  /** Add a frame. `automatic` places it right of the page's other frames,
   *  checked in this queue so frames created together never overlap. A retried
   *  create returns the frame it already made. */
  async createFrame(input: Frame, by: Attribution, automatic: boolean): Promise<Frame | null> {
    if (!this.initialized || this.deleted || !this.pages.some((page) => page.id === input.pageId)) return null
    return this.db.transaction(async () => {
      const existing = await readFrame(this.orm, input.id)
      if (existing) return existing
      let frame: Frame = { ...input, html: repairEscapedHtml(input.html) }
      if (automatic) {
        const placed = await this.orm
          .select({ edge: sql<number | null>`MAX(${frames.x} + ${frames.width})` })
          .from(frames)
          .where(eq(frames.pageId, frame.pageId!))
          .get()
        const edge = placed?.edge ?? null
        frame = { ...frame, x: edge === null ? 120 : edge + 80 }
      }
      if (frame.z === undefined)
        frame = { ...frame, z: (await frontOfPage(this.orm, frame.pageId!)) ?? frame.createdAt }
      validateFrame(frame)
      await insertFrame(this.orm, frame)
      this.bursts = { ...this.bursts, [frame.id]: creatorBurst(frame, by.kind) }
      this.committed = { type: 'frame-change', revision: ++this.revision, frame, operation: 'insert', actor: by }
      return frame
    })
  }

  async write(
    frameId: string,
    write: FrameEdit,
    by: Attribution,
    requestId?: string,
  ): Promise<FrameChange | FrameWriteConflict | null> {
    if (!this.initialized || this.deleted) return null
    return this.db.transaction(async () => {
      const before = await readFrame(this.orm, frameId)
      if (!before) return null
      // Checked in the actor's queue, so two saves from the same version cannot both land.
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
                  ([key, value]) =>
                    [
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
                    ].includes(key) && value !== undefined,
                ),
              )
      if (write.type !== 'append' && patch.html !== undefined) patch.html = repairEscapedHtml(patch.html)
      /* a frame moved to another page lands in front there, as Figma does */
      if (patch.pageId !== undefined && patch.pageId !== before.pageId && patch.z === undefined) {
        const front = await frontOfPage(this.orm, patch.pageId, frameId)
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
      const { id: _id, canvasId: _canvasId, createdAt: _createdAt, demo: _demo, ...changes } = toRow(frame)
      await this.orm.update(frames).set(changes).where(eq(frames.id, frameId))
      const { name, html } = frame
      if (!annotation && html !== before.html)
        this.bursts = {
          ...this.bursts,
          [frameId]: await noteHtmlChange(
            this.orm,
            this.bursts[frameId] ?? null,
            before,
            by,
            isTweak(write, before.html, html),
            `${frameId}.v${this.revision + 1}`,
          ),
        }
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
      if (requestId && !annotation && (html !== before.html || name !== before.name)) {
        change.activity = {
          id: requestId,
          actorName: by.name,
          actorKind: by.kind,
          actorColor: by.color,
          frameId,
          at: frame.updatedAt,
          message: html !== before.html ? `updated the design of “${name}”` : `renamed “${before.name}” to “${name}”`,
        }
        this.activity = [change.activity, ...this.activity].slice(0, 100)
      }
      this.committed = change
      return change
    })
  }

  /** Remove a frame and its history; returns what was removed. */
  async deleteFrame(frameId: string, by: Attribution): Promise<Frame | null> {
    if (this.deleted) return null
    return this.db.transaction(async () => {
      const frame = await readFrame(this.orm, frameId)
      if (!frame) return null
      await this.orm.delete(frames).where(eq(frames.id, frameId))
      await this.orm.delete(versions).where(eq(versions.frameId, frameId))
      if (this.bursts[frameId]) {
        const { [frameId]: _gone, ...bursts } = this.bursts
        this.bursts = bursts
      }
      this.committed = { type: 'frame-removal', revision: ++this.revision, frameId, actor: by }
      return frame
    })
  }

  /** Rename, reorder, add or delete pages. A page that still holds frames stays. */
  async setPages(pages: CanvasPageInfo[], expectedPages: CanvasPageInfo[]): Promise<PageUpdate> {
    const current = this.pages
    if (this.deleted) return { pages: current, error: 'deleted' }
    if (!samePages(expectedPages, current)) return { pages: current, error: 'conflict' }
    if (!pages.length || new Set(pages.map((page) => page.id)).size !== pages.length)
      throw new Error('Provide at least one page with unique IDs')
    const kept = new Set(pages.map((page) => page.id))
    const occupied = await this.orm.selectDistinct({ pageId: frames.pageId }).from(frames)
    if (occupied.some(({ pageId }) => !kept.has(pageId))) return { pages: current, error: 'occupied' }
    /* a page-list save renames, reorders, adds or deletes pages — it never
       moves a flow start or recolours a page, which only setFlowStart and
       setPageBackground change */
    this.pages = pages.map(({ startFrameId: _start, background: _background, ...page }) => {
      const kept = current.find((existing) => existing.id === page.id)
      return {
        ...page,
        ...(kept?.startFrameId ? { startFrameId: kept.startFrameId } : {}),
        ...(kept?.background ? { background: kept.background } : {}),
      }
    })
    this.committed = { type: 'pages-change', revision: ++this.revision, pages: this.pages }
    return { pages: this.pages }
  }

  /** Add a page after `afterPageId` (or last) together with its frames, for page copies. */
  async addPage(page: CanvasPageInfo, afterPageId: string, input: Frame[], by: Attribution): Promise<PageUpdate> {
    const current = this.pages
    if (this.deleted) return { pages: current, error: 'deleted' }
    if (current.some((existing) => existing.id === page.id)) return { pages: current, error: 'conflict' }
    const copies = input.map((frame) => ({ ...frame, pageId: page.id, html: repairEscapedHtml(frame.html) }))
    for (const frame of copies) validateFrame(frame)
    return this.db.transaction(async () => {
      const bursts = { ...this.bursts }
      for (const frame of copies) {
        if (await readFrame(this.orm, frame.id)) throw new Error(`Frame ${frame.id} already exists`)
        await insertFrame(this.orm, frame)
        bursts[frame.id] = creatorBurst(frame, by.kind)
      }
      const at = current.findIndex((existing) => existing.id === afterPageId)
      const pages = [...current]
      pages.splice(at === -1 ? current.length : at + 1, 0, page)
      this.pages = pages
      this.bursts = bursts
      this.revision++
      this.committed = await this.snapshot()
      return { pages }
    })
  }

  /** Set (frameId) or clear (null) the frame a page's prototype starts on. */
  async setFlowStart(pageId: string, frameId: string | null): Promise<CanvasPageInfo[] | null> {
    if (this.deleted || !this.pages.some((page) => page.id === pageId)) return null
    this.pages = this.pages.map((page) => {
      if (page.id !== pageId) return page
      const { startFrameId: _previous, ...rest } = page
      return frameId ? { ...rest, startFrameId: frameId } : rest
    })
    this.committed = { type: 'pages-change', revision: ++this.revision, pages: this.pages }
    return this.pages
  }

  /** Set (a `#rrggbb`) or clear (null) a page's own canvas colour. */
  async setPageBackground(pageId: string, background: string | null): Promise<CanvasPageInfo[] | null> {
    if (this.deleted || !this.pages.some((page) => page.id === pageId)) return null
    this.pages = this.pages.map((page) => {
      if (page.id !== pageId) return page
      const { background: _previous, ...rest } = page
      return background ? { ...rest, background } : rest
    })
    this.committed = { type: 'pages-change', revision: ++this.revision, pages: this.pages }
    return this.pages
  }

  /** Several frames' places in their page's stack, in one transaction: every
   *  frame is checked before any is written. Null when one is gone. */
  async restack(writes: StackWrite[], by: Attribution): Promise<Frame[] | null> {
    if (!this.initialized || this.deleted) return null
    if (!writes.length) return []
    if (!writes.every((write) => Number.isFinite(write.z))) throw new Error('Each z must be a finite number')
    return this.db.transaction(async () => {
      const ids = writes.map((write) => write.id)
      const found = await this.orm.select({ id: frames.id }).from(frames).where(inArray(frames.id, ids))
      if (found.length !== new Set(ids).size) return null
      const now = Date.now()
      const restacked: Frame[] = []
      for (const { id, z } of writes) {
        const before = (await readFrame(this.orm, id))!
        const frame: Frame = { ...before, z, updatedAt: Math.max(now, before.updatedAt + 1), updatedBy: by.name }
        await this.orm
          .update(frames)
          .set({ z, updatedAt: frame.updatedAt, updatedBy: frame.updatedBy })
          .where(eq(frames.id, id))
        restacked.push(frame)
      }
      /* one change for one frame; a renumbered page arrives whole */
      if (restacked.length === 1)
        this.committed = {
          type: 'frame-change',
          revision: ++this.revision,
          frame: restacked[0]!,
          operation: 'update',
          actor: by,
        }
      else {
        this.revision++
        this.committed = await this.snapshot()
      }
      return restacked
    })
  }

  /** Newest first, without the HTML. */
  async listVersions(frameId: string): Promise<FrameVersionInfo[]> {
    const frame = await this.frame(frameId)
    if (!frame) return []
    const rows = await this.orm
      .select({ ...versionInfoColumns, htmlBytes: sql<number>`length(${versions.html})` })
      .from(versions)
      .where(eq(versions.frameId, frameId))
      .orderBy(...newestFirst)
    return rows.map(({ savedByKind, ...row }) => ({
      ...row,
      canvasId: frame.canvasId,
      ...(savedByKind ? { savedByKind } : {}),
    }))
  }

  async getVersion(frameId: string, versionId: string): Promise<FrameVersion | null> {
    const frame = await this.frame(frameId)
    if (!frame) return null
    const row = await this.orm
      .select()
      .from(versions)
      .where(and(eq(versions.id, versionId), eq(versions.frameId, frameId)))
      .get()
    if (!row) return null
    const { savedByKind, ...version } = row
    return {
      ...version,
      canvasId: frame.canvasId,
      htmlBytes: row.html.length,
      ...(savedByKind ? { savedByKind } : {}),
    }
  }

  /** Delete the canvas and everything in it. */
  async destroy(): Promise<void> {
    if (this.deleted) return
    await this.db.transaction(async () => {
      await this.orm.delete(frames)
      await this.orm.delete(versions)
      this.activity = []
      this.bursts = {}
      this.initialized = true
      this.deleted = true
      this.revision++
      this.committed = await this.snapshot()
    })
  }
}
