import { Actor, Compute, Emittable, Ephemeral, Persisted, type ActorDatabase, type ActorSocketOf } from 'durable-actors'
import { repairEscapedHtml } from '../server/escapedHtml.js'
import { MAX_FRAME_HTML_BYTES } from '../server/limits.js'
import type { ActivityItem, Actor as Attribution, Frame } from '../shared/types.js'

export type FrameInput = Pick<Frame, 'name'> & Partial<Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'html' | 'demo'>>
export type FramePatch = Partial<Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height' | 'html'>>
export type FrameWrite =
  | { type: 'create'; id?: string; input: FrameInput }
  | { type: 'update'; id: string; patch: FramePatch }
  | { type: 'append'; id: string; chunk: string; start: boolean; done?: boolean }
  | { type: 'delete'; id: string }

export type FrameEdit =
  { type: 'update'; patch: FramePatch } | { type: 'append'; chunk: string; start: boolean; done?: boolean }
export type FrameSnapshot = {
  type: 'frame-snapshot'
  revision: number
  frame: Frame | null
  deleted: boolean
  activity: ActivityItem[]
}
export type FrameChange = {
  type: 'frame-change'
  revision: number
  frame: Frame
  operation: FrameEdit['type']
  actor: Attribution
  requestId?: string
  activity?: ActivityItem
  streaming?: boolean
}
export type FrameDrag = { type: 'drag'; frameId: string } & Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'updatedAt'>
export type FrameCommand = { type: 'snapshot' } | FrameDrag | { type: 'write'; write: FrameEdit; requestId: string }
export type FrameMetadata = { actor: Attribution; readOnly: boolean }
type SyncError = { type: 'error'; requestId: string; message: string }

export type IndexSnapshot = {
  type: 'index-snapshot'
  revision: number
  frameIds: string[]
  initialized: boolean
  deleted: boolean
}
export type IndexCommand = { type: 'snapshot' }

function indexTable(db: ActorDatabase): true {
  db.exec(
    'CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, position INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0)',
  )
  return true
}

/** A canvas owns only frame membership and order. */
@Compute({ cpu: 1, memoryMiB: 256 })
export class CanvasIndex extends Actor<FrameMetadata, IndexCommand, IndexSnapshot> {
  @Persisted private initialized = false
  @Persisted private deleted = false
  @Persisted private revision = 0
  @Ephemeral private ready = false
  @Persisted @Emittable committed: IndexSnapshot | null = null

  override async onConnect(socket: ActorSocketOf<CanvasIndex>) {
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<CanvasIndex>, command: IndexCommand) {
    if (command.type === 'snapshot') return socket.send(await this.snapshot())
  }

  async initialize(frameIds: string[] = []): Promise<IndexSnapshot> {
    if (!this.ready) this.ready = indexTable(this.db)
    if (!this.initialized) {
      for (const [position, id] of frameIds.entries()) {
        if (!id.startsWith(`${this.id}.`)) throw new Error('Frame ID must belong to this canvas')
        this.db.exec('INSERT INTO entries (id, position) VALUES (?, ?)', id, position)
      }
      this.initialized = true
    }
    return this.snapshot()
  }

  async snapshot(): Promise<IndexSnapshot> {
    if (!this.ready) this.ready = indexTable(this.db)
    return {
      type: 'index-snapshot',
      revision: this.revision,
      initialized: this.initialized,
      deleted: this.deleted,
      frameIds: this.db
        .exec<{ id: string }>('SELECT id FROM entries WHERE removed = 0 ORDER BY position')
        .map((row) => row.id),
    }
  }

  async has(id: string): Promise<boolean> {
    if (!this.initialized || this.deleted) return false
    if (!this.ready) this.ready = indexTable(this.db)
    return this.db.exec('SELECT id FROM entries WHERE id = ? AND removed = 0', id).length > 0
  }

  async add(id: string): Promise<boolean> {
    if (!this.initialized || this.deleted) return false
    if (!id.startsWith(`${this.id}.`)) throw new Error('Frame ID must belong to this canvas')
    if (!this.ready) this.ready = indexTable(this.db)
    const [existing] = this.db.exec<{ removed: number }>('SELECT removed FROM entries WHERE id = ?', id)
    if (existing) return existing.removed === 0
    this.db.exec('INSERT INTO entries (id, position) SELECT ?, COALESCE(MAX(position), -1) + 1 FROM entries', id)
    this.revision++
    this.committed = await this.snapshot()
    return true
  }

  async remove(id: string): Promise<boolean> {
    if (!(await this.has(id))) return false
    // Keep tombstones so retrying a create cannot resurrect a deleted ID.
    this.db.exec('UPDATE entries SET removed = 1 WHERE id = ?', id)
    this.revision++
    this.committed = await this.snapshot()
    return true
  }

  async pendingDeletes(): Promise<string[]> {
    if (!this.ready) this.ready = indexTable(this.db)
    return this.db.exec<{ id: string }>('SELECT id FROM entries WHERE removed = 1').map((row) => row.id)
  }

  async confirmDelete(id: string): Promise<void> {
    if (!this.ready) this.ready = indexTable(this.db)
    this.db.exec('UPDATE entries SET removed = 2 WHERE id = ? AND removed = 1', id)
  }

  async destroy(): Promise<void> {
    if (this.deleted) return
    if (!this.ready) this.ready = indexTable(this.db)
    this.db.exec('UPDATE entries SET removed = 1 WHERE removed = 0')
    this.deleted = true
    this.initialized = true
    this.revision++
    this.committed = await this.snapshot()
  }
}

type FrameRow = Omit<Frame, 'demo'> & { demo: number | null }
const SUMMARY_COLUMNS = 'id, canvasId, name, x, y, width, height, createdAt, updatedAt, updatedBy, demo'
const COLUMNS = `${SUMMARY_COLUMNS}, html`
function frameTable(db: ActorDatabase): true {
  db.exec(
    'CREATE TABLE IF NOT EXISTS frame (id TEXT PRIMARY KEY, canvasId TEXT NOT NULL, name TEXT NOT NULL, ' +
      'x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, html TEXT NOT NULL, ' +
      'createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, updatedBy TEXT NOT NULL, demo INTEGER)',
  )
  return true
}
function decodeRow<T extends { demo: number | null }>({ demo, ...row }: T) {
  return { ...row, ...(demo === null ? {} : { demo: demo === 1 }) }
}
function readFrame(db: ActorDatabase): Frame | null {
  const [row] = db.exec<FrameRow>(`SELECT ${COLUMNS} FROM frame`)
  return row ? decodeRow(row) : null
}
function validateFrame(frame: Frame) {
  if (typeof frame.name !== 'string' || frame.name.length > 1024) throw new Error('Frame name is too long')
  if (typeof frame.html !== 'string' || new TextEncoder().encode(frame.html).length > MAX_FRAME_HTML_BYTES)
    throw new Error('Frame HTML is too large')
  for (const key of ['x', 'y', 'width', 'height'] as const)
    if (!Number.isFinite(frame[key]) || ((key === 'width' || key === 'height') && frame[key] <= 0))
      throw new Error(`Invalid frame ${key}`)
}

/** The whole frame has one writer, one invocation queue, and one revision. */
@Compute({ cpu: 1, memoryMiB: 256 })
export class FrameActor extends Actor<FrameMetadata, FrameCommand, FrameSnapshot | FrameDrag | SyncError> {
  @Persisted private initialized = false
  @Persisted private deleted = false
  @Persisted private revision = 0
  @Persisted private activity: ActivityItem[] = []
  @Ephemeral private ready = false
  @Persisted @Emittable committed: FrameChange | FrameSnapshot | null = null

  override async onConnect(socket: ActorSocketOf<FrameActor>) {
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<FrameActor>, command: FrameCommand) {
    if (command.type === 'snapshot') return socket.send(await this.snapshot())
    if (command.type === 'drag') {
      if (!this.ready) this.ready = frameTable(this.db)
      const [current] = this.db.exec<{ updatedAt: number }>('SELECT updatedAt FROM frame')
      if (
        socket.metadata.readOnly ||
        this.deleted ||
        command.frameId !== this.id ||
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
      if (!(await this.write(command.write, socket.metadata.actor, command.requestId)))
        throw new Error('Frame not found')
    } catch (error) {
      socket.send({
        type: 'error',
        requestId: command.requestId,
        message: error instanceof Error ? error.message : 'Frame edit failed',
      })
    }
  }

  async initialize(frame: Frame): Promise<boolean> {
    if (this.initialized) return false
    if (frame.id !== this.id) throw new Error('Frame ID mismatch')
    if (!frame.id.startsWith(`${frame.canvasId}.`)) throw new Error('Canvas ID mismatch')
    frame = { ...frame, html: repairEscapedHtml(frame.html) }
    validateFrame(frame)
    if (!this.ready) this.ready = frameTable(this.db)
    this.db.exec(
      `INSERT INTO frame (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      frame.id,
      frame.canvasId,
      frame.name,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      frame.createdAt,
      frame.updatedAt,
      frame.updatedBy,
      frame.demo === undefined ? null : frame.demo ? 1 : 0,
      frame.html,
    )
    this.initialized = true
    return true
  }

  async snapshot(): Promise<FrameSnapshot> {
    if (!this.ready) this.ready = frameTable(this.db)
    return {
      type: 'frame-snapshot',
      revision: this.revision,
      frame: readFrame(this.db),
      deleted: this.deleted,
      activity: this.activity,
    }
  }

  /** Dashboard/activity responses omit HTML. */
  async summary(): Promise<{ frame: Omit<Frame, 'html'> | null; activity: ActivityItem[] }> {
    if (!this.ready) this.ready = frameTable(this.db)
    const [row] = this.db.exec<Omit<FrameRow, 'html'>>(`SELECT ${SUMMARY_COLUMNS} FROM frame`)
    return { frame: row ? decodeRow(row) : null, activity: this.activity }
  }

  async write(write: FrameEdit, by: Attribution, requestId?: string): Promise<FrameChange | null> {
    if (!this.initialized || this.deleted) return null
    if (!this.ready) this.ready = frameTable(this.db)
    const before = readFrame(this.db)
    if (!before) return null
    const patch: FramePatch =
      write.type === 'append'
        ? { html: (write.start ? '' : before.html) + write.chunk }
        : Object.fromEntries(
            Object.entries(write.patch).filter(
              ([key, value]) => ['name', 'x', 'y', 'width', 'height', 'html'].includes(key) && value !== undefined,
            ),
          )
    if (write.type === 'update' && patch.html !== undefined) patch.html = repairEscapedHtml(patch.html)
    const frame = { ...before, ...patch, updatedAt: Math.max(Date.now(), before.updatedAt + 1), updatedBy: by.name }
    validateFrame(frame)
    const { name, html } = frame
    this.db.exec(
      'UPDATE frame SET name = ?, x = ?, y = ?, width = ?, height = ?, html = ?, updatedAt = ?, updatedBy = ? WHERE id = ?',
      name,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      html,
      frame.updatedAt,
      by.name,
      this.id,
    )
    const change: FrameChange = {
      type: 'frame-change',
      revision: ++this.revision,
      frame,
      operation: write.type,
      actor: by,
      ...(requestId ? { requestId } : {}),
      ...(write.type === 'append' ? { streaming: !write.done } : {}),
    }
    if (requestId && (html !== before.html || name !== before.name)) {
      change.activity = {
        id: requestId,
        actorName: by.name,
        actorKind: by.kind,
        actorColor: by.color,
        frameId: this.id,
        at: frame.updatedAt,
        message: html !== before.html ? `updated the design of “${name}”` : `renamed “${before.name}” to “${name}”`,
      }
      this.activity = [change.activity, ...this.activity].slice(0, 100)
    }
    this.committed = change
    return change
  }

  async destroy(): Promise<void> {
    if (this.deleted) return
    if (!this.ready) this.ready = frameTable(this.db)
    this.db.exec('DELETE FROM frame')
    this.initialized = true
    this.deleted = true
    this.revision++
    this.committed = await this.snapshot()
  }
}
