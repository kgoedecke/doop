import { Actor, Compute, Emittable, Ephemeral, Persisted, type ActorDatabase, type ActorSocketOf } from 'durable-actors'
import { repairEscapedHtml } from '../server/escapedHtml.js'
import { validateFrame } from '../shared/frame-validation.js'
import { samePages } from '../shared/pages.js'
import type {
  ActivityItem,
  Actor as Attribution,
  CanvasPageInfo,
  Frame,
  FrameApproval,
  FrameVersion,
  FrameVersionInfo,
} from '../shared/types.js'

export type FrameInput = Pick<Frame, 'name'> &
  Partial<Pick<Frame, 'pageId' | 'x' | 'y' | 'width' | 'height' | 'html' | 'demo' | 'hidden' | 'locked'>>
export type FramePatch = Partial<
  Pick<Frame, 'name' | 'pageId' | 'x' | 'y' | 'width' | 'height' | 'html' | 'hidden' | 'locked' | 'approval'>
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
    }
  | { type: 'replace'; find: string; replacement: string }
  | { type: 'append'; chunk: string; start: boolean; done?: boolean }
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
export type FrameMetadata = { actor: Attribution; readOnly: boolean; accessVersion?: number }
type SyncError = { type: 'error'; requestId: string; message: string }

type EncodedColumns = {
  demo: number | null
  pageId: string | null
  hidden: number | null
  locked: number | null
  approval: string | null
}
type FrameRow = Omit<Frame, keyof EncodedColumns> & EncodedColumns
const SUMMARY_COLUMNS =
  'id, canvasId, name, x, y, width, height, createdAt, updatedAt, updatedBy, demo, pageId, hidden, locked, approval'
const COLUMNS = `${SUMMARY_COLUMNS}, html`
/** Columns added after the first release; actors created earlier gain them on wake. */
const ADDED_COLUMNS = { pageId: 'TEXT', hidden: 'INTEGER', locked: 'INTEGER', approval: 'TEXT' }
function frameTable(db: ActorDatabase): true {
  db.exec(
    'CREATE TABLE IF NOT EXISTS frame (id TEXT PRIMARY KEY, canvasId TEXT NOT NULL, name TEXT NOT NULL, ' +
      'x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, html TEXT NOT NULL, ' +
      'createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, updatedBy TEXT NOT NULL, demo INTEGER)',
  )
  const existing = new Set(db.exec<{ name: string }>('PRAGMA table_info(frame)').map((column) => column.name))
  for (const [column, type] of Object.entries(ADDED_COLUMNS))
    if (!existing.has(column)) db.exec(`ALTER TABLE frame ADD COLUMN ${column} ${type}`)
  return true
}
const flag = (value: boolean | undefined) => (value ? 1 : null)
function decodeRow<T extends EncodedColumns>({ demo, pageId, hidden, locked, approval, ...row }: T) {
  return {
    ...row,
    ...(demo === null ? {} : { demo: demo === 1 }),
    ...(pageId === null ? {} : { pageId }),
    ...(hidden ? { hidden: true } : {}),
    ...(locked ? { locked: true } : {}),
    ...(approval === null ? {} : { approval: JSON.parse(approval) as FrameApproval }),
  }
}
function readFrame(db: ActorDatabase): Frame | null {
  const [row] = db.exec<FrameRow>(`SELECT ${COLUMNS} FROM frame`)
  return row ? decodeRow(row) : null
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
type VersionRow = Omit<FrameVersion, 'frameId' | 'canvasId' | 'htmlBytes' | 'savedByKind'> & {
  savedByKind: string | null
}
const VERSION_COLUMNS = 'id, html, width, height, savedAt, savedBy, savedByKind'
function versionTable(db: ActorDatabase) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, html TEXT NOT NULL, width REAL NOT NULL, ' +
      'height REAL NOT NULL, savedAt INTEGER NOT NULL, savedBy TEXT NOT NULL, savedByKind TEXT)',
  )
}
const versionKind = (kind: string | null) => (kind === 'user' || kind === 'agent' ? kind : undefined)

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
function noteHtmlChange(
  db: ActorDatabase,
  open: Burst | null,
  prior: Frame,
  by: Attribution,
  tweak: boolean,
  versionId: string,
): Burst {
  const now = Date.now()
  const burst = { actorName: by.name, actorKind: by.kind, lastAt: now }
  const joins =
    tweak &&
    open !== null &&
    open.actorName === by.name &&
    open.actorKind === by.kind &&
    now - open.lastAt < BURST_IDLE_MS
  if (joins || !prior.html) return burst
  versionTable(db)
  /* a burst that ended where it began would file the same state twice. Size
     counts: the same document at another frame size is a state of its own */
  const [latest] = db.exec<{ html: string; width: number; height: number }>(
    'SELECT html, width, height FROM versions ORDER BY savedAt DESC, rowid DESC LIMIT 1',
  )
  if (latest && latest.html === prior.html && latest.width === prior.width && latest.height === prior.height)
    return burst
  db.exec(
    `INSERT INTO versions (${VERSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    versionId,
    prior.html,
    prior.width,
    prior.height,
    /* the open burst wrote this state; without one the frame's own stamp is the best attribution */
    open?.lastAt ?? prior.updatedAt,
    open?.actorName ?? prior.updatedBy,
    open?.actorKind ?? null,
  )
  db.exec(
    'DELETE FROM versions WHERE id NOT IN (SELECT id FROM versions ORDER BY savedAt DESC, rowid DESC LIMIT ?)',
    MAX_FRAME_VERSIONS,
  )
  return burst
}

export type IndexSnapshot = {
  type: 'index-snapshot'
  revision: number
  frameIds: string[]
  initialized: boolean
  deleted: boolean
  pages?: CanvasPageInfo[]
  framePages?: Record<string, string>
}
export type IndexCommand = { type: 'snapshot' }
export type PageUpdate = { pages: CanvasPageInfo[]; error?: 'conflict' | 'occupied' | 'deleted' }
type IndexEntry = { id: string; status: 'creating' | 'active' | 'deleting' | 'deleted' }

function indexTable(db: ActorDatabase): true {
  db.exec('CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, position INTEGER NOT NULL, status TEXT NOT NULL)')
  return true
}

/** Canvas membership is serialized separately from each frame's content. */
@Compute({ cpu: 1, memoryMiB: 256, idleTimeoutMs: 5000 })
export class CanvasIndex extends Actor<FrameMetadata, IndexCommand, IndexSnapshot> {
  @Persisted private initialized = false
  @Persisted private deleted = false
  @Persisted private revision = 0
  @Persisted private accessRevision = 0
  @Persisted private pages: CanvasPageInfo[] | null = null
  @Persisted private framePages: Record<string, string> = {}
  @Persisted private reservedBounds: Record<string, { x: number; width: number; pageId?: string }> = {}
  @Ephemeral private ready = false
  @Persisted @Emittable committed: IndexSnapshot | null = null

  override async onConnect(socket: ActorSocketOf<CanvasIndex>) {
    if ((socket.metadata.accessVersion ?? 0) !== this.accessRevision) return socket.reject(4003, 'Access changed')
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<CanvasIndex>, command: IndexCommand) {
    if ((socket.metadata.accessVersion ?? 0) !== this.accessRevision) return socket.close(4003, 'Access changed')
    if (command.type === 'snapshot') socket.send(await this.snapshot())
  }

  async accessVersion(): Promise<number> {
    return this.accessRevision
  }

  async revokeAccess(): Promise<void> {
    this.accessRevision++
    for (const socket of await this.getConnections()) socket.close(4003, 'Access changed')
  }

  /** Called only after legacy frame payloads have been copied. Retrying cannot reset membership. */
  async initialize(frameIds: string[] = []): Promise<IndexSnapshot> {
    if (!this.initialized) {
      if (!this.ready) this.ready = indexTable(this.db)
      for (const [position, id] of frameIds.entries())
        this.db.exec("INSERT INTO entries (id, position, status) VALUES (?, ?, 'active')", id, position)
      this.initialized = true
      this.committed = await this.snapshot()
    }
    return this.snapshot()
  }

  /** Import SQL-owned pages once. Later reads never relocate a frame. */
  async initializePages(pages: CanvasPageInfo[], framePages: Record<string, string> = {}): Promise<IndexSnapshot> {
    if (this.pages === null && !this.deleted) {
      if (!pages.length) throw new Error('A canvas must have a page')
      if (!this.ready) this.ready = indexTable(this.db)
      const entries = this.db.exec<IndexEntry>("SELECT id, status FROM entries WHERE status IN ('creating', 'active')")
      const assigned = { ...this.framePages }
      for (const { id } of entries) {
        const pageId = this.reservedBounds[id]?.pageId ?? framePages[id]
        assigned[id] = pages.some((page) => page.id === pageId) ? pageId! : pages[0]!.id
      }
      // Persisted fields save on assignment, not on mutation.
      this.framePages = assigned
      this.pages = pages
      this.revision++
      this.committed = await this.snapshot()
    }
    return this.snapshot()
  }

  /** Page deletion and page moves share this actor's invocation queue. */
  async setPages(pages: CanvasPageInfo[], expectedPages: CanvasPageInfo[]): Promise<PageUpdate> {
    const current = this.pages ?? []
    if (this.deleted) return { pages: current, error: 'deleted' }
    if (!samePages(expectedPages, current)) return { pages: current, error: 'conflict' }
    if (!pages.length || new Set(pages.map((page) => page.id)).size !== pages.length)
      throw new Error('Provide at least one page with unique IDs')
    const removed = new Set(current.filter((page) => !pages.some((next) => next.id === page.id)).map((page) => page.id))
    if (removed.size) {
      if (!this.ready) this.ready = indexTable(this.db)
      const entries = this.db.exec<IndexEntry>(
        "SELECT id, status FROM entries WHERE status IN ('creating', 'active', 'deleting')",
      )
      for (const entry of entries) {
        if (removed.has(this.framePages[entry.id] ?? current[0]!.id)) return { pages: current, error: 'occupied' }
      }
    }
    // A page-list save renames, reorders, adds or deletes pages; only setFlowStart moves a flow start.
    this.pages = pages.map(({ startFrameId: _ignored, ...page }) => {
      const startFrameId = current.find((existing) => existing.id === page.id)?.startFrameId
      return startFrameId ? { ...page, startFrameId } : page
    })
    this.revision++
    this.committed = await this.snapshot()
    return { pages: this.pages }
  }

  /** Insert a page after `afterPageId` (or last), for page copies. */
  async insertPage(page: CanvasPageInfo, afterPageId: string): Promise<PageUpdate> {
    const current = this.pages ?? []
    if (this.deleted) return { pages: current, error: 'deleted' }
    if (current.some((existing) => existing.id === page.id)) return { pages: current, error: 'conflict' }
    const at = current.findIndex((existing) => existing.id === afterPageId)
    const pages = [...current]
    pages.splice(at === -1 ? current.length : at + 1, 0, page)
    this.pages = pages
    this.revision++
    this.committed = await this.snapshot()
    return { pages }
  }

  /** Set (frameId) or clear (null) the frame a page's prototype starts on. */
  async setFlowStart(pageId: string, frameId: string | null): Promise<CanvasPageInfo[] | null> {
    if (this.deleted || !this.pages?.some((page) => page.id === pageId)) return null
    this.pages = this.pages.map((page) => {
      if (page.id !== pageId) return page
      const { startFrameId: _previous, ...rest } = page
      return frameId ? { ...rest, startFrameId: frameId } : rest
    })
    this.revision++
    this.committed = await this.snapshot()
    return this.pages
  }

  async moveFrame(id: string, pageId: string): Promise<boolean> {
    if (!(await this.has(id)) || !this.pages?.some((page) => page.id === pageId)) return false
    this.framePages = { ...this.framePages, [id]: pageId }
    this.revision++
    this.committed = await this.snapshot()
    return true
  }

  async snapshot(): Promise<IndexSnapshot> {
    if (!this.ready) this.ready = indexTable(this.db)
    return {
      type: 'index-snapshot',
      revision: this.revision,
      initialized: this.initialized,
      deleted: this.deleted,
      ...(this.pages ? { pages: this.pages, framePages: this.framePages } : {}),
      frameIds: this.db
        .exec<{ id: string }>("SELECT id FROM entries WHERE status = 'active' ORDER BY position")
        .map((row) => row.id),
    }
  }

  async has(id: string): Promise<boolean> {
    if (!this.ready) this.ready = indexTable(this.db)
    return !this.deleted && !!this.db.exec("SELECT id FROM entries WHERE id = ? AND status = 'active'", id).length
  }

  /** Record intent before initializing the frame, so a later access can finish an interrupted create. */
  async reserve(id: string): Promise<boolean> {
    if (!id.startsWith(`${this.id}.`)) throw new Error('Frame ID must belong to this canvas')
    if (!this.initialized || this.deleted) return false
    if (!this.ready) this.ready = indexTable(this.db)
    const [existing] = this.db.exec<IndexEntry>('SELECT id, status FROM entries WHERE id = ?', id)
    if (existing) return existing.status === 'creating' || existing.status === 'active'
    this.db.exec(
      "INSERT INTO entries (id, position, status) SELECT ?, COALESCE(MAX(position), -1) + 1, 'creating' FROM entries",
      id,
    )
    return true
  }

  /** Calculate and reserve placement together, including creates whose payload is still in flight. */
  async reserveFrame(
    frame: Frame,
    automatic: boolean,
    observed: Record<string, { x: number; width: number; pageId?: string }>,
  ): Promise<Frame | 'retry' | null> {
    validateFrame(frame)
    if (!this.initialized || this.deleted) return null
    if (!this.pages?.some((page) => page.id === frame.pageId)) return null
    if (!this.ready) this.ready = indexTable(this.db)
    const [existing] = this.db.exec<IndexEntry>('SELECT id, status FROM entries WHERE id = ?', frame.id)
    if (existing?.status === 'active') return { ...frame, pageId: this.framePages[frame.id] ?? frame.pageId }
    if (existing && existing.status !== 'creating') return null
    const reserved = this.reservedBounds[frame.id]
    if (reserved) return { ...frame, ...reserved }
    const entries = this.db.exec<IndexEntry>("SELECT id, status FROM entries WHERE status IN ('creating', 'active')")
    const edges: number[] = []
    for (const entry of entries) {
      // A create may have activated since the caller read the canvas. Refresh before deciding.
      if (automatic && entry.status === 'active' && !observed[entry.id]) return 'retry'
      const bounds = entry.status === 'creating' ? this.reservedBounds[entry.id] : observed[entry.id]
      if (bounds && bounds.pageId === frame.pageId) edges.push(bounds.x + bounds.width)
    }
    if (automatic) frame = { ...frame, x: edges.length ? Math.max(...edges) + 80 : 120 }
    if (!(await this.reserve(frame.id))) return null
    this.framePages = { ...this.framePages, [frame.id]: frame.pageId! }
    this.reservedBounds = {
      ...this.reservedBounds,
      [frame.id]: { x: frame.x, width: frame.width, pageId: frame.pageId },
    }
    return frame
  }

  async activate(id: string): Promise<boolean> {
    if (this.deleted) return false
    if (!this.ready) this.ready = indexTable(this.db)
    const [entry] = this.db.exec<IndexEntry>('SELECT id, status FROM entries WHERE id = ?', id)
    if (!entry || (entry.status !== 'creating' && entry.status !== 'active')) return false
    if (entry.status === 'creating') {
      this.db.exec("UPDATE entries SET status = 'active' WHERE id = ?", id)
      const { [id]: _reserved, ...reservedBounds } = this.reservedBounds
      this.reservedBounds = reservedBounds
      this.revision++
      this.committed = await this.snapshot()
    }
    return true
  }

  async remove(id: string): Promise<boolean> {
    if (!this.ready) this.ready = indexTable(this.db)
    const removed = this.db.exec(
      "UPDATE entries SET status = 'deleting' WHERE id = ? AND status IN ('creating', 'active') RETURNING id",
      id,
    )
    if (!removed.length) return false
    this.revision++
    this.committed = await this.snapshot()
    return true
  }

  async pending(): Promise<IndexEntry[]> {
    if (!this.ready) this.ready = indexTable(this.db)
    return this.db.exec<IndexEntry>(
      "SELECT id, status FROM entries WHERE status IN ('creating', 'deleting') ORDER BY position",
    )
  }

  async confirmDelete(id: string): Promise<void> {
    if (!this.ready) this.ready = indexTable(this.db)
    // Keep the tombstone so creation retries and legacy imports cannot resurrect the frame.
    this.db.exec("UPDATE entries SET status = 'deleted' WHERE id = ? AND status = 'deleting'", id)
    const { [id]: _reserved, ...reservedBounds } = this.reservedBounds
    const { [id]: _page, ...framePages } = this.framePages
    this.reservedBounds = reservedBounds
    this.framePages = framePages
  }

  async destroy(): Promise<void> {
    if (this.deleted) return
    if (!this.ready) this.ready = indexTable(this.db)
    this.db.exec("UPDATE entries SET status = 'deleting' WHERE status IN ('creating', 'active')")
    this.initialized = true
    this.deleted = true
    this.revision++
    this.committed = await this.snapshot()
  }
}

/** The whole frame has one writer, one invocation queue, and one revision. */
@Compute({ cpu: 1, memoryMiB: 256, idleTimeoutMs: 5000 })
export class FrameActor extends Actor<FrameMetadata, FrameCommand, FrameSnapshot | FrameDrag | SyncError> {
  @Persisted private initialized = false
  @Persisted private deleted = false
  @Persisted private revision = 0
  @Persisted private accessRevision = 0
  @Persisted private activity: ActivityItem[] = []
  @Persisted private burst: Burst | null = null
  @Ephemeral private ready = false
  @Persisted @Emittable committed: FrameChange | FrameSnapshot | null = null

  override async onConnect(socket: ActorSocketOf<FrameActor>) {
    if ((socket.metadata.accessVersion ?? 0) !== this.accessRevision) return socket.reject(4003, 'Access changed')
    socket.send(await this.snapshot())
  }

  override async onMessage(socket: ActorSocketOf<FrameActor>, command: FrameCommand) {
    if ((socket.metadata.accessVersion ?? 0) !== this.accessRevision) return socket.close(4003, 'Access changed')
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
      // Page changes use the app API and the canvas actor's invocation queue.
      if (command.write.type === 'update' && command.write.patch.pageId !== undefined)
        throw new Error('Page changes must use the frame API')
      // Sign-off and annotation writes carry server-checked identity.
      if (command.write.type === 'update' && (command.write.patch.approval !== undefined || command.write.annotation))
        throw new Error('Approval changes must use the frame API')
      const result = await this.write(command.write, socket.metadata.actor, command.requestId)
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

  async initialize(frame: Frame, creatorKind: Attribution['kind'] = 'user'): Promise<boolean> {
    if (this.initialized) return false
    if (frame.id !== this.id) throw new Error('Frame ID mismatch')
    // Legacy SQL frames keep their original IDs. Only trusted backend RPC can initialize.
    frame = { ...frame, html: repairEscapedHtml(frame.html) }
    validateFrame(frame)
    if (!this.ready) this.ready = frameTable(this.db)
    this.db.exec(
      `INSERT INTO frame (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      frame.pageId ?? null,
      flag(frame.hidden),
      flag(frame.locked),
      frame.approval ? JSON.stringify(frame.approval) : null,
      frame.html,
    )
    versionTable(this.db)
    // The creator's first edits continue the design it was created with.
    this.burst = { actorName: frame.updatedBy, actorKind: creatorKind, lastAt: frame.createdAt }
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

  async write(write: FrameEdit, by: Attribution, requestId?: string): Promise<FrameChange | FrameWriteConflict | null> {
    if (!this.initialized || this.deleted) return null
    if (!this.ready) this.ready = frameTable(this.db)
    const before = readFrame(this.db)
    if (!before) return null
    // Checked in the actor's queue, so two saves from the same version cannot both land.
    if (
      write.type === 'update' &&
      write.expectedUpdatedAt !== undefined &&
      write.expectedUpdatedAt !== before.updatedAt
    )
      return { type: 'conflict', frame: before }
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
                  ['name', 'pageId', 'x', 'y', 'width', 'height', 'html', 'hidden', 'locked', 'approval'].includes(
                    key,
                  ) && value !== undefined,
              ),
            )
    if (write.type !== 'append' && patch.html !== undefined) patch.html = repairEscapedHtml(patch.html)
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
    const { name, html } = frame
    this.db.exec(
      'UPDATE frame SET name = ?, x = ?, y = ?, width = ?, height = ?, html = ?, updatedAt = ?, updatedBy = ?, ' +
        'pageId = ?, hidden = ?, locked = ?, approval = ? WHERE id = ?',
      name,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      html,
      frame.updatedAt,
      by.name,
      frame.pageId ?? null,
      flag(frame.hidden),
      flag(frame.locked),
      frame.approval ? JSON.stringify(frame.approval) : null,
      this.id,
    )
    if (!annotation && html !== before.html)
      this.burst = noteHtmlChange(
        this.db,
        this.burst,
        before,
        by,
        isTweak(write, before.html, html),
        `${this.id}.v${this.revision + 1}`,
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
    if (requestId && !annotation && (html !== before.html || name !== before.name)) {
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

  /** Newest first, without the HTML. */
  async listVersions(): Promise<FrameVersionInfo[]> {
    if (!this.initialized || this.deleted) return []
    if (!this.ready) this.ready = frameTable(this.db)
    versionTable(this.db)
    // Legacy frames keep IDs without a canvas prefix, so read the owner from the row.
    const canvasId = readFrame(this.db)?.canvasId ?? ''
    return this.db
      .exec<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM versions ORDER BY savedAt DESC, rowid DESC`)
      .map(({ html, savedByKind, ...row }) => ({
        ...row,
        frameId: this.id,
        canvasId,
        htmlBytes: html.length,
        ...(versionKind(savedByKind) ? { savedByKind: versionKind(savedByKind) } : {}),
      }))
  }

  async getVersion(versionId: string): Promise<FrameVersion | null> {
    if (!this.initialized || this.deleted) return null
    if (!this.ready) this.ready = frameTable(this.db)
    versionTable(this.db)
    const [row] = this.db.exec<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM versions WHERE id = ?`, versionId)
    if (!row) return null
    const { savedByKind, ...version } = row
    return {
      ...version,
      frameId: this.id,
      canvasId: readFrame(this.db)?.canvasId ?? '',
      htmlBytes: row.html.length,
      ...(versionKind(savedByKind) ? { savedByKind: versionKind(savedByKind) } : {}),
    }
  }

  async destroy(): Promise<void> {
    if (this.deleted) return
    if (!this.ready) this.ready = frameTable(this.db)
    this.db.exec('DELETE FROM frame')
    versionTable(this.db)
    this.db.exec('DELETE FROM versions')
    this.burst = null
    this.initialized = true
    this.deleted = true
    this.revision++
    this.committed = await this.snapshot()
  }
}
