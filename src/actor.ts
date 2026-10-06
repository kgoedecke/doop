import { Actor, Emittable, Ephemeral, Persisted, type ActorDatabase, type ActorSocketOf } from 'durable-actors'
import type { ActivityItem, Actor as Attribution, Frame } from '../shared/types.js'
import { repairEscapedHtml } from '../server/escapedHtml.js'
import { MAX_FRAME_HTML_BYTES } from '../server/limits.js'

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
    if (!this.ready) this.ready = ensureTable(this.db)
    if (!this.initialized) {
      if (frames.some((frame) => frame.canvasId !== this.id)) throw new Error('Canvas ID mismatch')
      for (const frame of frames) insertFrame(this.db, frame)
      this.initialized = true
    }
    return this.snapshot()
  }

  async snapshot(): Promise<FrameSnapshot> {
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
    if (!this.ready) this.ready = ensureTable(this.db)
    this.db.exec('DELETE FROM frames')
    this.deleted = true
    this.initialized = true
    this.revision++
    this.committed = await this.snapshot()
  }
}
