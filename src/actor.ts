import { Actor, Compute, Emittable, Ephemeral, Persisted, type ActorDatabase, type ActorSocketOf } from 'durable-actors'
import type { ActivityItem, Actor as Attribution, Frame } from '../shared/types.js'
import { repairEscapedHtml } from '../server/escapedHtml.js'
import { MAX_FRAME_HTML_BYTES } from '../server/limits.js'
import type { FrameContent, FrameLayout, LayoutPatch } from '../shared/frame-state.js'
import { contentOf, layoutOf } from '../shared/frame-state.js'

export type FrameInput = Pick<Frame, 'name'> & Partial<Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'html' | 'demo'>>
export type FramePatch = Partial<Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height' | 'html'>>
export type FrameWrite =
  | { type: 'create'; id?: string; input: FrameInput }
  | { type: 'update'; id: string; patch: FramePatch }
  | { type: 'append'; id: string; chunk: string; start: boolean; done?: boolean }
  | { type: 'delete'; id: string }

export type FrameSnapshot = {
  type: 'snapshot'
  revision: number
  frames: Frame[]
  initialized: boolean
  deleted: boolean
  activity: ActivityItem[]
}
export type FrameChange = {
  type: 'change'
  revision: number
  operation: FrameWrite['type']
  frame: Frame
  actor: Attribution
  requestId?: string
  activity?: ActivityItem
  streaming?: boolean
}

export type FrameDrag = { type: 'drag'; frameId: string } & Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'updatedAt'>
export type FrameCommand = { type: 'write'; requestId: string; write: FrameWrite } | { type: 'snapshot' } | FrameDrag
export type FrameMetadata = { actor: Attribution; readOnly: boolean }
export type FrameMessage = FrameSnapshot | FrameDrag | { type: 'error'; requestId: string; message: string }

/** A frame's canvas is always its actor, so canvasId is derived, not stored. */
type FrameRow = Omit<Frame, 'canvasId' | 'demo'> & { demo: number | null }
const COLUMNS = 'id, name, x, y, width, height, html, createdAt, updatedAt, updatedBy, demo'

/* Actor methods must all be async, so the row helpers live out here: they are
   synchronous SQLite calls and reading them as such keeps the writes obvious. */

function ensureTable(db: ActorDatabase): true {
  db.exec(
    'CREATE TABLE IF NOT EXISTS frames (id TEXT PRIMARY KEY, name TEXT NOT NULL, x REAL NOT NULL, ' +
      'y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, html TEXT NOT NULL, ' +
      'createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, updatedBy TEXT NOT NULL, ' +
      // NULL, 0 and 1 keep `demo` absent, false and true distinct across a round trip.
      'demo INTEGER)',
  )
  return true
}

function toFrame(canvasId: string, { demo, ...row }: FrameRow): Frame {
  return { ...row, canvasId, ...(demo === null ? {} : { demo: demo === 1 }) }
}

function findFrame(db: ActorDatabase, canvasId: string, id: string): Frame | undefined {
  const [row] = db.exec<FrameRow>(`SELECT ${COLUMNS} FROM frames WHERE id = ?`, id)
  return row && toFrame(canvasId, row)
}

function insertFrame(db: ActorDatabase, frame: Frame) {
  db.exec(
    `INSERT INTO frames (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    frame.id,
    frame.name,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    frame.html,
    frame.createdAt,
    frame.updatedAt,
    frame.updatedBy,
    frame.demo === undefined ? null : frame.demo ? 1 : 0,
  )
}

/** One writer for a canvas's frames. Accounts, canvas metadata and AI stay in Doop. */
@Compute({ cpu: 1, memoryMiB: 512 })
export class CanvasFrames extends Actor<FrameMetadata, FrameCommand, FrameMessage> {
  /* Frames are SQLite rows, not a @Persisted array. The runtime re-serializes
     every persisted field after each successful call, so holding the array here
     made editing one frame rewrite — and replicate — every frame on the canvas,
     which is quadratic over a streaming append. A row keeps an edit proportional
     to the frame it touches. Scalars and the capped activity log stay fields:
     they are small, and `committed` must be one to reach browsers. */
  @Persisted private revision = 0
  @Persisted private initialized = false
  @Persisted private deleted = false
  @Persisted private migrating = false
  @Persisted private activity: ActivityItem[] = []
  /* A failed call rolls the database back and rebuilds the instance, resetting
     this with it, so the table is never assumed into existence. */
  @Ephemeral private ready = false
  // Emitted by the runtime after persistence. broadcast()/send() are live output,
  // so they must not be used as an acknowledgment of a durable frame edit.
  @Persisted @Emittable committed: FrameChange | FrameSnapshot | null = null

  override async onConnect(socket: ActorSocketOf<CanvasFrames>) {
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<CanvasFrames>, command: FrameCommand) {
    if (command.type === 'snapshot') return socket.send(await this.snapshot())
    if (command.type === 'drag') {
      if (!this.ready) this.ready = ensureTable(this.db)
      // Drags arrive at pointer rate: read the one column the guard needs.
      const [current] = this.db.exec<{ updatedAt: number }>(
        'SELECT updatedAt FROM frames WHERE id = ?',
        command.frameId,
      )
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
      // Preview only: no persisted mutation or revision. A committed edit
      // invalidates any delayed preview based on the previous frame version.
      const { frameId, x, y, width, height, updatedAt } = command
      this.broadcast({ type: 'drag', frameId, x, y, width, height, updatedAt }, { except: socket })
      return
    }
    try {
      if (socket.metadata.readOnly) throw new Error('This connection is read only')
      const change = await this.write(command.write, socket.metadata.actor, command.requestId)
      if (!change) throw new Error('Canvas or frame not found')
    } catch (error) {
      socket.send({
        type: 'error',
        requestId: command.requestId,
        message: error instanceof Error ? error.message : 'Frame edit failed',
      })
    }
  }

  async initialize(frames: Frame[]): Promise<FrameSnapshot> {
    if (this.migrating) throw new Error('Canvas moved to frame actors; reload the application')
    if (!this.ready) this.ready = ensureTable(this.db)
    if (!this.initialized) {
      if (frames.some((frame) => frame.canvasId !== this.id)) throw new Error('Canvas ID mismatch')
      for (const frame of frames) insertFrame(this.db, frame)
      this.initialized = true
    }
    return this.snapshot()
  }

  async snapshot(): Promise<FrameSnapshot> {
    if (this.migrating) throw new Error('Canvas moved to frame actors; reload the application')
    if (!this.ready) this.ready = ensureTable(this.db)
    // rowid breaks createdAt ties in insertion order, matching the SQL source.
    const rows = this.db.exec<FrameRow>(`SELECT ${COLUMNS} FROM frames ORDER BY createdAt, rowid`)
    return {
      type: 'snapshot',
      revision: this.revision,
      frames: rows.map((row) => toFrame(this.id, row)),
      initialized: this.initialized,
      deleted: this.deleted,
      activity: this.activity,
    }
  }

  async write(write: FrameWrite, by: Attribution, requestId?: string): Promise<FrameChange | null> {
    if (this.migrating) throw new Error('Canvas moved to frame actors; reload the application')
    if (!this.initialized || this.deleted) return null
    if (!this.ready) this.ready = ensureTable(this.db)
    const id = write.type === 'create' ? (write.id ?? `${this.id}.${crypto.randomUUID()}`) : write.id
    const before = findFrame(this.db, this.id, id)
    let frame = before
    const input = write.type === 'create' ? write.input : write.type === 'update' ? write.patch : undefined
    if (input) {
      for (const key of ['x', 'y', 'width', 'height'] as const)
        if (
          input[key] !== undefined &&
          (!Number.isFinite(input[key]) || ((key === 'width' || key === 'height') && input[key]! <= 0))
        )
          throw new Error(`Invalid frame ${key}`)
      if (input.html !== undefined) input.html = repairEscapedHtml(input.html)
    }
    const html = write.type === 'append' ? (write.start ? '' : (frame?.html ?? '')) + write.chunk : input?.html
    if (html !== undefined && new TextEncoder().encode(html).length > MAX_FRAME_HTML_BYTES)
      throw new Error('Frame HTML is too large')
    const [clock] = this.db.exec<{ latest: number | null }>('SELECT MAX(updatedAt) AS latest FROM frames')
    const now = clock?.latest == null ? Date.now() : Math.max(Date.now(), clock.latest + 1)
    if (write.type === 'create') {
      if (frame) throw new Error('Frame already exists')
      if (!id.startsWith(`${this.id}.`)) throw new Error('New frame IDs must belong to this canvas')
      const input = write.input
      const [placement] = this.db.exec<{ total: number; edge: number | null }>(
        'SELECT COUNT(*) AS total, MAX(x + width) AS edge FROM frames',
      )
      frame = {
        id,
        canvasId: this.id,
        name: input.name,
        x: input.x ?? (placement?.total ? placement.edge! + 80 : 120),
        y: input.y ?? 120,
        width: input.width ?? 640,
        height: input.height ?? 480,
        html: input.html ?? '',
        createdAt: now,
        updatedAt: now,
        updatedBy: by.name,
        ...(input.demo ? { demo: true } : {}),
      }
      insertFrame(this.db, frame)
    } else {
      if (!frame) return null
      if (write.type === 'delete') this.db.exec('DELETE FROM frames WHERE id = ?', id)
      else {
        const patch =
          write.type === 'append'
            ? { html: html! }
            : Object.fromEntries(
                Object.entries(write.patch).filter(([key]) =>
                  ['name', 'x', 'y', 'width', 'height', 'html'].includes(key),
                ),
              )
        frame = { ...frame, ...patch, updatedAt: now, updatedBy: by.name }
        this.db.exec(
          'UPDATE frames SET name = ?, x = ?, y = ?, width = ?, height = ?, html = ?, updatedAt = ?, ' +
            'updatedBy = ? WHERE id = ?',
          frame.name,
          frame.x,
          frame.y,
          frame.width,
          frame.height,
          frame.html,
          frame.updatedAt,
          frame.updatedBy,
          id,
        )
      }
    }
    const change: FrameChange = {
      type: 'change',
      revision: ++this.revision,
      operation: write.type,
      frame,
      actor: by,
      ...(write.type === 'append' ? { streaming: !write.done } : {}),
      ...(requestId ? { requestId } : {}),
    }
    if (requestId) {
      const message =
        write.type === 'create'
          ? `created frame “${frame.name}”`
          : write.type === 'delete'
            ? `deleted frame “${frame.name}”`
            : frame.html !== before?.html
              ? `updated the design of “${frame.name}”`
              : frame.name !== before?.name
                ? `renamed “${before?.name}” to “${frame.name}”`
                : undefined
      if (message) {
        change.activity = {
          id: requestId,
          actorName: by.name,
          actorKind: by.kind,
          actorColor: by.color,
          message,
          frameId: frame.id,
          at: now,
        }
        this.activity = [change.activity, ...this.activity].slice(0, 100)
      }
    }
    this.committed = change
    return change
  }

  async destroy(): Promise<void> {
    if (this.migrating) throw new Error('Canvas moved to frame actors; reload the application')
    if (!this.ready) this.ready = ensureTable(this.db)
    this.db.exec('DELETE FROM frames')
    this.deleted = true
    this.initialized = true
    this.revision++
    this.committed = await this.snapshot()
  }

  /** Freeze legacy writers before copying. Export metadata and one payload at a
   * time; migrating a large canvas must never call the old full snapshot. */
  async migrationIndex(): Promise<IndexSnapshot> {
    if (!this.ready) this.ready = ensureTable(this.db)
    this.migrating = true
    this.committed = null
    const rows = this.db.exec<Omit<FrameRow, 'name' | 'html'>>(
      'SELECT id, x, y, width, height, createdAt, updatedAt, updatedBy, demo FROM frames ORDER BY createdAt, rowid',
    )
    return {
      type: 'index-snapshot',
      revision: this.revision,
      initialized: this.initialized,
      deleted: this.deleted,
      activity: this.activity,
      frames: rows.map(({ demo, ...row }) => ({
        ...row,
        canvasId: this.id,
        ...(demo === null ? {} : { demo: demo === 1 }),
      })),
    }
  }

  async migrationFrame(id: string): Promise<Frame | null> {
    if (!this.migrating) throw new Error('Freeze the legacy canvas before copying frames')
    if (!this.ready) this.ready = ensureTable(this.db)
    return findFrame(this.db, this.id, id) ?? null
  }
}

export type IndexSnapshot = {
  type: 'index-snapshot'
  revision: number
  frames: FrameLayout[]
  initialized: boolean
  deleted: boolean
  activity: ActivityItem[]
}
export type IndexChange = {
  type: 'index-change'
  revision: number
  operation: 'create' | 'update' | 'delete'
  frame: FrameLayout
  actor: Attribution
  requestId?: string
}
export type IndexCommand =
  | { type: 'snapshot' }
  | FrameDrag
  | {
      type: 'layout'
      id: string
      patch: LayoutPatch
      requestId: string
    }
type SyncError = { type: 'error'; requestId: string; message: string }
type IndexRow = Omit<FrameLayout, 'canvasId' | 'demo'> & { demo: number | null; removed: number }
const INDEX_COLUMNS = 'id, x, y, width, height, createdAt, updatedAt, updatedBy, demo, removed'

function indexTable(db: ActorDatabase): true {
  db.exec(
    'CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL, ' +
      'width REAL NOT NULL, height REAL NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ' +
      'updatedBy TEXT NOT NULL, demo INTEGER, removed INTEGER NOT NULL DEFAULT 0)',
  )
  return true
}
function indexFrame(canvasId: string, { removed: _removed, demo, ...row }: IndexRow): FrameLayout {
  return { ...row, canvasId, ...(demo === null ? {} : { demo: demo === 1 }) }
}
function saveLayout(db: ActorDatabase, frame: FrameLayout) {
  db.exec(
    'INSERT INTO entries (id, x, y, width, height, createdAt, updatedAt, updatedBy, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    frame.id,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    frame.createdAt,
    frame.updatedAt,
    frame.updatedBy,
    frame.demo === undefined ? null : frame.demo ? 1 : 0,
  )
}
function cleanLayout(patch: LayoutPatch): LayoutPatch {
  const clean: LayoutPatch = {}
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (!Number.isFinite(value) || ((key === 'width' || key === 'height') && value <= 0))
      throw new Error(`Invalid frame ${key}`)
    clean[key] = value
  }
  return clean
}

/** The canvas owns only membership and placement. No method accepts HTML. */
@Compute({ cpu: 1, memoryMiB: 256 })
export class CanvasIndex extends Actor<FrameMetadata, IndexCommand, IndexSnapshot | FrameDrag | SyncError> {
  @Persisted private initialized = false
  @Persisted private deleted = false
  @Persisted private revision = 0
  @Persisted private activity: ActivityItem[] = []
  @Ephemeral private ready = false
  @Persisted @Emittable committed: IndexChange | IndexSnapshot | null = null

  override async onConnect(socket: ActorSocketOf<CanvasIndex>) {
    socket.send(await this.snapshot())
  }

  async status(): Promise<{ initialized: boolean; deleted: boolean }> {
    return { initialized: this.initialized, deleted: this.deleted }
  }

  override async onMessage(socket: ActorSocketOf<CanvasIndex>, command: IndexCommand) {
    if (command.type === 'snapshot') return socket.send(await this.snapshot())
    if (command.type === 'drag') {
      const frame = await this.getFrame(command.frameId)
      if (socket.metadata.readOnly || !frame || frame.updatedAt !== command.updatedAt) return
      try {
        cleanLayout(command)
      } catch {
        return
      }
      const { frameId, x, y, width, height, updatedAt } = command
      this.broadcast({ type: 'drag', frameId, x, y, width, height, updatedAt }, { except: socket })
      return
    }
    try {
      if (socket.metadata.readOnly) throw new Error('This connection is read only')
      if (!(await this.updateLayout(command.id, command.patch, socket.metadata.actor, command.requestId)))
        throw new Error('Canvas or frame not found')
    } catch (error) {
      socket.send({
        type: 'error',
        requestId: command.requestId,
        message: error instanceof Error ? error.message : 'Frame edit failed',
      })
    }
  }

  async initialize(frames: FrameLayout[], activity: ActivityItem[] = [], deleted = false): Promise<IndexSnapshot> {
    if (!this.ready) this.ready = indexTable(this.db)
    if (!this.initialized) {
      for (const frame of frames) {
        if (frame.canvasId !== this.id) throw new Error('Canvas ID mismatch')
        cleanLayout(frame)
        saveLayout(this.db, layoutOf(frame))
      }
      this.activity = activity.slice(0, 100)
      this.initialized = true
      this.deleted = deleted
      if (deleted) this.db.exec('UPDATE entries SET removed = 1')
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
      activity: this.activity,
      frames: this.db
        .exec<IndexRow>(`SELECT ${INDEX_COLUMNS} FROM entries WHERE removed = 0 ORDER BY createdAt, rowid`)
        .map((row) => indexFrame(this.id, row)),
    }
  }

  async getFrame(id: string): Promise<FrameLayout | null> {
    if (!this.initialized || this.deleted) return null
    if (!this.ready) this.ready = indexTable(this.db)
    const [row] = this.db.exec<IndexRow>(`SELECT ${INDEX_COLUMNS} FROM entries WHERE id = ? AND removed = 0`, id)
    return row ? indexFrame(this.id, row) : null
  }

  async add(
    id: string,
    input: LayoutPatch & { createdAt: number; demo?: boolean },
    by: Attribution,
  ): Promise<FrameLayout | null> {
    if (!this.initialized || this.deleted) return null
    if (!id.startsWith(`${this.id}.`)) throw new Error('New frame IDs must belong to this canvas')
    if (!this.ready) this.ready = indexTable(this.db)
    const [existing] = this.db.exec<IndexRow>(`SELECT ${INDEX_COLUMNS} FROM entries WHERE id = ?`, id)
    if (existing) return existing.removed ? null : indexFrame(this.id, existing)
    const patch = cleanLayout(input)
    const [placement] = this.db.exec<{ edge: number | null }>(
      'SELECT MAX(x + width) AS edge FROM entries WHERE removed = 0',
    )
    const now = Date.now()
    const frame: FrameLayout = {
      id,
      canvasId: this.id,
      x: patch.x ?? (placement?.edge == null ? 120 : placement.edge + 80),
      y: patch.y ?? 120,
      width: patch.width ?? 640,
      height: patch.height ?? 480,
      createdAt: input.createdAt,
      updatedAt: now,
      updatedBy: by.name,
      ...(input.demo === undefined ? {} : { demo: input.demo }),
    }
    saveLayout(this.db, frame)
    this.committed = { type: 'index-change', revision: ++this.revision, operation: 'create', frame, actor: by }
    return frame
  }

  async updateLayout(id: string, patch: LayoutPatch, by: Attribution, requestId?: string): Promise<FrameLayout | null> {
    const before = await this.getFrame(id)
    if (!before) return null
    const frame = {
      ...before,
      ...cleanLayout(patch),
      updatedAt: Math.max(Date.now(), before.updatedAt + 1),
      updatedBy: by.name,
    }
    this.db.exec(
      'UPDATE entries SET x = ?, y = ?, width = ?, height = ?, updatedAt = ?, updatedBy = ? WHERE id = ?',
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      frame.updatedAt,
      frame.updatedBy,
      id,
    )
    this.committed = {
      type: 'index-change',
      revision: ++this.revision,
      operation: 'update',
      frame,
      actor: by,
      ...(requestId ? { requestId } : {}),
    }
    return frame
  }

  async remove(id: string, by: Attribution): Promise<FrameLayout | null> {
    const frame = await this.getFrame(id)
    if (!frame) return null
    // Keep tombstones so retrying a create can never resurrect a deleted ID.
    this.db.exec('UPDATE entries SET removed = 1 WHERE id = ?', id)
    this.committed = { type: 'index-change', revision: ++this.revision, operation: 'delete', frame, actor: by }
    return frame
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
    if (!this.ready) this.ready = indexTable(this.db)
    this.db.exec('UPDATE entries SET removed = 1 WHERE removed = 0')
    this.deleted = true
    this.initialized = true
    this.revision++
    this.committed = await this.snapshot()
  }
}

export type ContentWrite =
  | { type: 'update'; patch: Partial<Pick<FrameContent, 'name' | 'html'>> }
  | { type: 'append'; chunk: string; start: boolean; done?: boolean }
export type ContentSnapshot = {
  type: 'frame-snapshot'
  revision: number
  frame: FrameContent | null
  deleted: boolean
  activity: ActivityItem[]
}
export type ContentChange = {
  type: 'frame-change'
  revision: number
  frame: FrameContent
  operation: ContentWrite['type']
  actor: Attribution
  requestId?: string
  activity?: ActivityItem
  streaming?: boolean
}
export type ContentCommand = { type: 'snapshot' } | { type: 'write'; write: ContentWrite; requestId: string }

function contentTable(db: ActorDatabase): true {
  db.exec(
    'CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY, canvasId TEXT NOT NULL, name TEXT NOT NULL, html TEXT NOT NULL, updatedAt INTEGER NOT NULL, updatedBy TEXT NOT NULL)',
  )
  return true
}
function readContent(db: ActorDatabase): FrameContent | null {
  return db.exec<FrameContent>('SELECT id, canvasId, name, html, updatedAt, updatedBy FROM content')[0] ?? null
}
function validateContent(name: string, html: string) {
  if (typeof name !== 'string' || name.length > 1024) throw new Error('Frame name is too long')
  if (typeof html !== 'string' || new TextEncoder().encode(html).length > MAX_FRAME_HTML_BYTES)
    throw new Error('Frame HTML is too large')
}

/** One frame's content, with an independent invocation queue and revision. */
@Compute({ cpu: 1, memoryMiB: 512 })
export class FrameContentActor extends Actor<FrameMetadata, ContentCommand, ContentSnapshot | SyncError> {
  @Persisted private initialized = false
  @Persisted private deleted = false
  @Persisted private revision = 0
  @Persisted private activity: ActivityItem[] = []
  @Ephemeral private ready = false
  @Persisted @Emittable committed: ContentChange | ContentSnapshot | null = null

  override async onConnect(socket: ActorSocketOf<FrameContentActor>) {
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<FrameContentActor>, command: ContentCommand) {
    if (command.type === 'snapshot') return socket.send(await this.snapshot())
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

  async initialize(frame: FrameContent): Promise<boolean> {
    if (this.initialized) return false
    if (frame.id !== this.id) throw new Error('Frame ID mismatch')
    validateContent(frame.name, frame.html)
    if (!this.ready) this.ready = contentTable(this.db)
    const clean = contentOf(frame)
    this.db.exec(
      'INSERT INTO content (id, canvasId, name, html, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?, ?)',
      clean.id,
      clean.canvasId,
      clean.name,
      clean.html,
      clean.updatedAt,
      clean.updatedBy,
    )
    this.initialized = true
    return true
  }

  async snapshot(): Promise<ContentSnapshot> {
    if (!this.ready) this.ready = contentTable(this.db)
    return {
      type: 'frame-snapshot',
      revision: this.revision,
      frame: readContent(this.db),
      deleted: this.deleted,
      activity: this.activity,
    }
  }

  /** Dashboard/activity responses omit HTML. */
  async summary(): Promise<{ frame: Omit<FrameContent, 'html'> | null; activity: ActivityItem[] }> {
    if (!this.ready) this.ready = contentTable(this.db)
    const frame =
      this.db.exec<Omit<FrameContent, 'html'>>('SELECT id, canvasId, name, updatedAt, updatedBy FROM content')[0] ??
      null
    return { frame, activity: this.activity }
  }

  async write(write: ContentWrite, by: Attribution, requestId?: string): Promise<ContentChange | null> {
    if (!this.initialized || this.deleted) return null
    if (!this.ready) this.ready = contentTable(this.db)
    const before = readContent(this.db)
    if (!before) return null
    const name = write.type === 'update' ? (write.patch.name ?? before.name) : before.name
    const html =
      write.type === 'append'
        ? (write.start ? '' : before.html) + write.chunk
        : write.patch.html === undefined
          ? before.html
          : repairEscapedHtml(write.patch.html)
    validateContent(name, html)
    const frame = { ...before, name, html, updatedAt: Math.max(Date.now(), before.updatedAt + 1), updatedBy: by.name }
    this.db.exec(
      'UPDATE content SET name = ?, html = ?, updatedAt = ?, updatedBy = ? WHERE id = ?',
      name,
      html,
      frame.updatedAt,
      by.name,
      this.id,
    )
    const change: ContentChange = {
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
    if (!this.ready) this.ready = contentTable(this.db)
    this.db.exec('DELETE FROM content')
    this.initialized = true
    this.deleted = true
    this.revision++
    this.committed = await this.snapshot()
  }
}
