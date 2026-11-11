import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { Actor, Compute, Emittable, Ephemeral, Persisted, type ActorContext, type ActorSocketOf } from 'terse-sdk/actor'
import { drizzle, migrate, type DurableActorsDatabase } from 'terse-sdk/drizzle'
import { MAX_FRAME_HTML_BYTES } from '../server/limits.js'
import migrations from './actor-db/migrations/migrations.js'
import * as schema from './actor-db/schema.js'

/**
 * One canvas whose owner has the canvas-actors feature flag
 * (server/actorFrames.ts): its frames and their design history. The Doop
 * server reads them from here when the canvas is opened and saves them here
 * instead of the Postgres frames and frame_versions tables. Browsers on the
 * canvas send their frame edits straight here; the server follows the actor's
 * socket and folds those edits into its copy.
 */
@Compute({ idleTimeoutMs: 5000 })
export class CanvasActor extends Actor<SocketMetadata, FrameCommand, FramesSnapshot | EditError> {
  @Persisted private revision = 0
  @Persisted private accessRevision = 0
  /** set while the canvas moves back to Postgres: no browser connects or edits */
  @Persisted private closed = false
  @Ephemeral private orm: Orm
  @Persisted @Emittable committed: FramesEvent | null = null

  constructor(context: ActorContext) {
    super(context)
    migrate(this.db, migrations)
    this.orm = drizzle(this.db, { schema })
  }

  override async onConnect(socket: ActorSocketOf<CanvasActor>) {
    if (this.closed || socket.metadata.accessVersion !== this.accessRevision)
      return socket.reject(4003, 'Access changed')
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<CanvasActor>, command: FrameCommand) {
    if (this.closed || socket.metadata.accessVersion !== this.accessRevision)
      return socket.close(4003, 'Access changed')
    if (command.type === 'snapshot') return socket.send(await this.snapshot())
    try {
      if (socket.metadata.readOnly) throw new Error('This connection is read only')
      await this.edit(command.frameId, command.patch, socket.metadata.by, command.requestId)
    } catch (error) {
      socket.send({
        type: 'error',
        requestId: command.requestId,
        message: error instanceof Error ? error.message : 'Frame edit failed',
      })
    }
  }

  async snapshot(): Promise<FramesSnapshot> {
    const rows = await this.orm
      .select()
      .from(frames)
      .orderBy(sql`rowid`)
    return { type: 'frames-snapshot', revision: this.revision, frames: rows.map(toFrame) }
  }

  async frame(id: string): Promise<ActorFrame | null> {
    const row = await this.orm.select().from(frames).where(eq(frames.id, id)).get()
    return row ? toFrame(row) : null
  }

  async accessVersion(): Promise<number> {
    return this.accessRevision
  }

  /** Close every socket and void tickets issued before (an access change). */
  async revokeAccess(): Promise<void> {
    this.accessRevision++
    for (const socket of await this.getConnections()) socket.close(4003, 'Access changed')
  }

  /** Stop taking browsers' edits and close their sockets, so what `snapshot`
   *  returns next is final (the canvas is moving back to Postgres). The
   *  server's own calls still work. */
  async close(): Promise<void> {
    this.closed = true
    await this.revokeAccess()
  }

  /** Take browsers' edits again (the move back failed). */
  async reopen(): Promise<void> {
    this.closed = false
  }

  /** The server's writes, in order and in one transaction; returns the revision they landed at. */
  async save(writes: ServerWrite[]): Promise<number> {
    return this.db.transaction(async () => {
      for (const write of writes) {
        if (write.type === 'delete') {
          await this.orm.delete(frames).where(eq(frames.id, write.id))
          await this.orm.delete(frameVersions).where(eq(frameVersions.frameId, write.id))
          continue
        }
        if (write.type === 'put') {
          const frame = validFrame(write.frame)
          const { id: _id, createdAt: _createdAt, ...set } = toRow(frame)
          await this.orm.insert(frames).values(toRow(frame)).onConflictDoUpdate({ target: frames.id, set })
          continue
        }
        const row = await this.orm.select().from(frames).where(eq(frames.id, write.id)).get()
        /* the server saves a frame whole before it patches it; a patch for a deleted frame has nothing to change */
        if (!row) continue
        const before = toFrame(row)
        const next = validFrame({
          ...before,
          ...(write.patch as Partial<ActorFrame>),
          updatedAt: Math.max(write.patch.updatedAt ?? Date.now(), before.updatedAt + 1),
        })
        const { id: _id, createdAt: _createdAt, ...set } = toRow(next)
        await this.orm.update(frames).set(set).where(eq(frames.id, write.id))
      }
      this.committed = {
        type: 'server-save',
        revision: ++this.revision,
        frameIds: writes.map((write) => (write.type === 'put' ? write.frame.id : write.id)),
      }
      return this.revision
    })
  }

  /** File the state a frame had before a burst of edits, unless the newest
   *  version already holds it; the oldest beyond MAX_FRAME_VERSIONS go. */
  async addVersion(version: ActorFrameVersion): Promise<void> {
    await this.db.transaction(() => this.fileVersion(version))
  }

  /** A frame's history, newest first, without the HTML. */
  async versions(frameId: string): Promise<ActorFrameVersionInfo[]> {
    const rows = await this.orm
      .select({
        id: frameVersions.id,
        frameId: frameVersions.frameId,
        width: frameVersions.width,
        height: frameVersions.height,
        savedAt: frameVersions.savedAt,
        savedBy: frameVersions.savedBy,
        savedByKind: frameVersions.savedByKind,
        htmlBytes: sql<number>`length(${frameVersions.html})`,
      })
      .from(frameVersions)
      .where(eq(frameVersions.frameId, frameId))
      .orderBy(desc(frameVersions.savedAt))
    return rows.map(({ savedByKind, ...row }) => ({ ...row, ...versionKind(savedByKind) }))
  }

  /** One version in full; null when the frame has none by that id. */
  async version(frameId: string, versionId: string): Promise<ActorFrameVersion | null> {
    const row = await this.orm
      .select()
      .from(frameVersions)
      .where(and(eq(frameVersions.id, versionId), eq(frameVersions.frameId, frameId)))
      .get()
    return row ? toVersion(row) : null
  }

  /** The whole history in id order, a page at a time, for the move back to
   *  Postgres: the versions after `after`, up to about `maxBytes` of HTML. */
  async exportVersions(after: string | null, maxBytes: number): Promise<ActorFrameVersion[]> {
    const ids = await this.orm
      .select({ id: frameVersions.id, bytes: sql<number>`length(${frameVersions.html})` })
      .from(frameVersions)
      .where(after === null ? undefined : gt(frameVersions.id, after))
      .orderBy(frameVersions.id)
      .limit(EXPORT_PAGE_ROWS)
    const page: string[] = []
    let size = 0
    for (const { id, bytes } of ids) {
      if (page.length && size + bytes > maxBytes) break
      page.push(id)
      size += bytes
    }
    if (!page.length) return []
    const rows = await this.orm
      .select()
      .from(frameVersions)
      .where(inArray(frameVersions.id, page))
      .orderBy(frameVersions.id)
    return rows.map(toVersion)
  }

  /** Delete every frame and its history (the canvas was deleted, or moved
   *  back to Postgres) and close every socket. What comes next starts clean. */
  async destroy(): Promise<void> {
    this.closed = false
    await this.db.transaction(async () => {
      await this.orm.delete(frames)
      await this.orm.delete(frameVersions)
      this.committed = { type: 'server-save', revision: ++this.revision, frameIds: [] }
    })
    await this.revokeAccess()
  }

  /** Inside a transaction: insert the version unless the newest already
   *  holds that state, then drop the oldest beyond MAX_FRAME_VERSIONS. */
  private async fileVersion(version: ActorFrameVersion): Promise<void> {
    const latest = await this.orm
      .select({ html: frameVersions.html, width: frameVersions.width, height: frameVersions.height })
      .from(frameVersions)
      .where(eq(frameVersions.frameId, version.frameId))
      .orderBy(desc(frameVersions.savedAt))
      .limit(1)
      .get()
    if (latest && latest.html === version.html && latest.width === version.width && latest.height === version.height)
      return
    await this.orm.insert(frameVersions).values(toVersionRow(version)).onConflictDoNothing()
    const kept = await this.orm
      .select({ id: frameVersions.id })
      .from(frameVersions)
      .where(eq(frameVersions.frameId, version.frameId))
      .orderBy(desc(frameVersions.savedAt))
    const excess = kept.slice(MAX_FRAME_VERSIONS)
    if (excess.length)
      await this.orm.delete(frameVersions).where(
        inArray(
          frameVersions.id,
          excess.map((row) => row.id),
        ),
      )
  }

  /** A browser's edit: only the fields it may change, sign-off invalidated by a design change. */
  private async edit(frameId: string, patch: BrowserPatch, by: Attribution, requestId: string) {
    await this.db.transaction(async () => {
      const row = await this.orm.select().from(frames).where(eq(frames.id, frameId)).get()
      if (!row) throw new Error('Frame not found')
      const before = toFrame(row)
      const refused = Object.keys(patch).find((key) => !BROWSER_EDITABLE.includes(key as keyof BrowserPatch))
      if (refused) throw new Error(`${refused} changes go through the app API`)
      const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
      const next: ActorFrame = {
        ...before,
        ...changes,
        updatedAt: Math.max(Date.now(), before.updatedAt + 1),
        updatedBy: by.name,
      }
      if (!next.hidden) delete next.hidden
      if (!next.locked) delete next.locked
      /* The server files history for the edits it sees (actions.noteHtmlChange),
         but it is not always following. So the state a new burst of edits
         replaces is filed here too: another author, or the same one after a
         pause. The server's copy of the same state is then skipped as a duplicate. */
      const startsBurst = before.updatedBy !== next.updatedBy || next.updatedAt - before.updatedAt >= BURST_IDLE_MS
      if (next.html !== before.html && before.html && startsBurst)
        await this.fileVersion({
          id: `${frameId}-${before.updatedAt}`,
          frameId,
          html: before.html,
          width: before.width,
          height: before.height,
          savedAt: before.updatedAt,
          savedBy: before.updatedBy,
        })
      const designChanged = next.html !== before.html || next.width !== before.width || next.height !== before.height
      if (designChanged && next.approval?.status === 'ready_for_dev')
        next.approval = { ...next.approval, status: 'needs_review' }
      const { id: _id, createdAt: _createdAt, ...set } = toRow(validFrame(next))
      await this.orm.update(frames).set(set).where(eq(frames.id, frameId))
      this.committed = { type: 'frame-edit', revision: ++this.revision, frame: next, by, requestId }
    })
  }
}

/** A frame as the actor keeps it: shared/types.ts `Frame`, field for field (kept here so the actor deploys alone). */
export type ActorFrame = {
  id: string
  canvasId: string
  pageId?: string
  name: string
  x: number
  y: number
  width: number
  height: number
  html: string
  createdAt: number
  updatedAt: number
  updatedBy: string
  demo?: boolean
  hidden?: boolean
  locked?: boolean
  z?: number
  rotation?: number
  approval?: FrameApproval | null
}

/** One entry of a frame's design history: shared/types.ts `FrameVersion`, less the canvas (this actor is it). */
export type ActorFrameVersion = ActorFrameVersionInfo & { html: string }

export type ActorFrameVersionInfo = {
  id: string
  frameId: string
  width: number
  height: number
  savedAt: number
  savedBy: string
  savedByKind?: 'user' | 'agent'
  /** set on listings, which leave the HTML out */
  htmlBytes?: number
}

export type FrameApproval = {
  status: 'ready_for_dev' | 'needs_review'
  approvedBy: string
  approvedByUserId: string
  approvedAt: number
  approvedFrameUpdatedAt: number
}

/** Who made a change: shared/types.ts `Actor`. */
export type Attribution = { name: string; kind: 'user' | 'agent'; color: string; clientId?: string }

/** What a browser may change directly; pages, sign-off and everything else go through the app API. */
export type BrowserPatch = Partial<
  Pick<ActorFrame, 'name' | 'x' | 'y' | 'width' | 'height' | 'html' | 'hidden' | 'locked' | 'z'>
>

/** The server's writes: a whole frame, the fields that changed since its last save, or a deletion. */
export type ServerWrite =
  { type: 'put'; frame: ActorFrame } | { type: 'patch'; id: string; patch: FramePatch } | { type: 'delete'; id: string }

/** Fields that changed since the server's last save; null clears an optional one. */
export type FramePatch = {
  [Field in keyof Omit<ActorFrame, 'id' | 'canvasId' | 'createdAt'>]?: ActorFrame[Field] | null
}

export type FrameCommand =
  { type: 'snapshot' } | { type: 'edit'; frameId: string; patch: BrowserPatch; requestId: string }

export type FramesSnapshot = { type: 'frames-snapshot'; revision: number; frames: ActorFrame[] }

/** A browser's committed edit, with the whole frame after it. */
export type FrameEdit = { type: 'frame-edit'; revision: number; frame: ActorFrame; by: Attribution; requestId: string }

/** The server's own writes; the server already has them. */
export type ServerSave = { type: 'server-save'; revision: number; frameIds: string[] }

export type FramesEvent = FrameEdit | ServerSave

export type SocketMetadata = { by: Attribution; readOnly: boolean; accessVersion: number }

type EditError = { type: 'error'; requestId: string; message: string }
type Orm = DurableActorsDatabase<typeof schema>
const { frames, frameVersions } = schema
const MAX_FRAME_VERSIONS = 50
/** actions.ts BURST_IDLE_MS: edits by one author closer together than this are one burst */
const BURST_IDLE_MS = 2 * 60_000
const EXPORT_PAGE_ROWS = 200
const BROWSER_EDITABLE: readonly (keyof BrowserPatch)[] = [
  'name',
  'x',
  'y',
  'width',
  'height',
  'html',
  'hidden',
  'locked',
  'z',
]
const MAX_NAME_LENGTH = 200

function validFrame(frame: ActorFrame): ActorFrame {
  if (typeof frame.html !== 'string' || new TextEncoder().encode(frame.html).length > MAX_FRAME_HTML_BYTES)
    throw new Error('Frame HTML is too large')
  if (typeof frame.name !== 'string' || frame.name.length > MAX_NAME_LENGTH) throw new Error('Invalid frame name')
  if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0)
    throw new Error('Invalid frame geometry')
  if (frame.z != null && !Number.isFinite(frame.z)) throw new Error('Invalid frame stacking order')
  if (frame.rotation != null && !Number.isFinite(frame.rotation)) throw new Error('Invalid frame rotation')
  return frame
}

function toRow(frame: ActorFrame): typeof frames.$inferInsert {
  return {
    id: frame.id,
    canvasId: frame.canvasId,
    pageId: frame.pageId ?? null,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    html: frame.html,
    createdAt: frame.createdAt,
    updatedAt: frame.updatedAt,
    updatedBy: frame.updatedBy,
    demo: frame.demo ?? null,
    hidden: frame.hidden ? true : null,
    locked: frame.locked ? true : null,
    z: frame.z ?? null,
    rotation: frame.rotation || null,
    approval: frame.approval ?? null,
  }
}

/** Frames leave out the flags they do not carry, as they do everywhere else. */
function toFrame({
  pageId,
  demo,
  hidden,
  locked,
  z,
  rotation,
  approval,
  ...row
}: typeof frames.$inferSelect): ActorFrame {
  return {
    ...row,
    ...(pageId === null ? {} : { pageId }),
    ...(demo === null ? {} : { demo }),
    ...(hidden ? { hidden: true } : {}),
    ...(locked ? { locked: true } : {}),
    ...(z === null ? {} : { z }),
    ...(rotation ? { rotation } : {}),
    ...(approval ? { approval } : {}),
  }
}

function toVersionRow(version: ActorFrameVersion): typeof frameVersions.$inferInsert {
  if (typeof version.html !== 'string' || new TextEncoder().encode(version.html).length > MAX_FRAME_HTML_BYTES)
    throw new Error('Frame HTML is too large')
  return {
    id: version.id,
    frameId: version.frameId,
    html: version.html,
    width: version.width,
    height: version.height,
    savedAt: version.savedAt,
    savedBy: version.savedBy,
    savedByKind: version.savedByKind ?? null,
  }
}

function toVersion({ savedByKind, ...row }: typeof frameVersions.$inferSelect): ActorFrameVersion {
  return { ...row, ...versionKind(savedByKind) }
}

function versionKind(kind: string | null): Pick<ActorFrameVersionInfo, 'savedByKind'> {
  return kind === 'user' || kind === 'agent' ? { savedByKind: kind } : {}
}
