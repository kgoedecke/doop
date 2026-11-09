import { eq, sql } from 'drizzle-orm'
import { Actor, Compute, Emittable, Ephemeral, Persisted, type ActorContext, type ActorSocketOf } from 'terse-sdk/actor'
import { drizzle, migrate, type DurableActorsDatabase } from 'terse-sdk/drizzle'
import { MAX_FRAME_HTML_BYTES } from '../server/limits.js'
import migrations from './actor-db/migrations/migrations.js'
import * as schema from './actor-db/schema.js'

/**
 * The frames of one canvas whose owner has the canvas-actors feature flag
 * (server/actorFrames.ts). The Doop server stays the hub, as on main: it keeps
 * the canvas in memory, saves its frames here instead of the Postgres frames
 * table, and owns pages, history and activity. Browsers on the canvas send
 * their frame edits straight here; the server follows the actor's socket and
 * folds those edits into its copy.
 */
@Compute({ idleTimeoutMs: 5000 })
export class CanvasActor extends Actor<SocketMetadata, FrameCommand, FramesSnapshot | EditError> {
  @Persisted private revision = 0
  @Persisted private accessRevision = 0
  @Ephemeral private orm: Orm
  @Persisted @Emittable committed: FramesEvent | null = null

  constructor(context: ActorContext) {
    super(context)
    migrate(this.db, migrations)
    this.orm = drizzle(this.db, { schema })
  }

  override async onConnect(socket: ActorSocketOf<CanvasActor>) {
    if (socket.metadata.accessVersion !== this.accessRevision) return socket.reject(4003, 'Access changed')
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<CanvasActor>, command: FrameCommand) {
    if (socket.metadata.accessVersion !== this.accessRevision) return socket.close(4003, 'Access changed')
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

  /** The server's writes, in order and in one transaction; returns the revision they landed at. */
  async save(writes: ServerWrite[]): Promise<number> {
    return this.db.transaction(async () => {
      for (const write of writes) {
        if (write.type === 'delete') {
          await this.orm.delete(frames).where(eq(frames.id, write.id))
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

  /** Delete every frame (the canvas was deleted) and close every socket. */
  async destroy(): Promise<void> {
    await this.db.transaction(async () => {
      await this.orm.delete(frames)
      this.committed = { type: 'server-save', revision: ++this.revision, frameIds: [] }
    })
    await this.revokeAccess()
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
  approval?: FrameApproval | null
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
const { frames } = schema
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
    approval: frame.approval ?? null,
  }
}

/** Frames leave out the flags they do not carry, as they do everywhere else. */
function toFrame({ pageId, demo, hidden, locked, z, approval, ...row }: typeof frames.$inferSelect): ActorFrame {
  return {
    ...row,
    ...(pageId === null ? {} : { pageId }),
    ...(demo === null ? {} : { demo }),
    ...(hidden ? { hidden: true } : {}),
    ...(locked ? { locked: true } : {}),
    ...(z === null ? {} : { z }),
    ...(approval ? { approval } : {}),
  }
}
