import { nanoid } from 'nanoid'
import { canvasActor, mapFrames } from './frame-sync.ts'
import type {
  CanvasSummary,
  FrameChange,
  FrameInput,
  FramePatch,
  FrameWriteConflict,
  PageUpdate,
} from '../src/actor.ts'
import { canvasPages, copyPageName } from '../shared/pages.ts'
import * as persist from './db/persist.ts'
import type { LinkAccess } from '../shared/canvasRole.ts'
import { MAX_GUIDES } from '../shared/guides.ts'
import { remapFrameTargets } from '../shared/prototype.ts'
import { colorFor } from '../shared/types.ts'
import type {
  ActivityItem,
  Actor,
  Canvas,
  CanvasGuide,
  CanvasPageInfo,
  CommunityCategory,
  Frame,
  FrameVersion,
  FrameVersionInfo,
  GuidelineDoc,
  MemoryReference,
} from '../shared/types.ts'

export const MAX_GUIDELINE_DOCS = 20
export const MAX_PAGES = 100

export class PageLimitError extends Error {
  constructor() {
    super(`A canvas holds at most ${MAX_PAGES} pages.`)
  }
}

export class GuideLimitError extends Error {
  constructor() {
    super(`A canvas holds at most ${MAX_GUIDES} guides.`)
  }
}

/** An optimistic save whose frame moved on; carries the current frame. */
export class FrameConflictError extends Error {
  constructor(readonly frame: Frame) {
    super('Frame changed. Reload it and try again.')
  }
}

type PageCopy = {
  source: CanvasPageInfo
  page: CanvasPageInfo
  pages: CanvasPageInfo[]
  frames: Frame[]
  guides: CanvasGuide[]
}

export type FrameUpdateOptions = {
  /** the html change only marks elements up (a `data-doop-id` stamp):
   *  nothing a reviewer signed off on moved, so sign-off stands */
  annotation?: boolean
  /** refuse the write (FrameConflictError) unless the frame is at this version */
  expectedUpdatedAt?: number
  /** a deliberate whole-document write: it always opens a design-history burst */
  replace?: boolean
}

const names = (pages: CanvasPageInfo[]) => pages.map((page) => page.name)
const isConflict = (result: FrameChange | FrameWriteConflict | null): result is FrameWriteConflict =>
  result?.type === 'conflict'
const attribution = (name: string, kind: Actor['kind'] = 'user'): Actor => ({ name, kind, color: colorFor(name) })
type Membership = { id: string; canvasId: string; pageId: string }

/** Frames go into a new canvas actor in groups of about this much HTML, so no
 *  single call carries a whole canvas. */
const IMPORT_BATCH_BYTES = 4_000_000
function importBatches(frames: Frame[]): Frame[][] {
  const batches: Frame[][] = []
  let size = Infinity
  for (const frame of frames) {
    if (size + frame.html.length > IMPORT_BATCH_BYTES) {
      batches.push([])
      size = 0
    }
    batches.at(-1)!.push(frame)
    size += frame.html.length
  }
  return batches
}

/** SQL owns canvas metadata. Each canvas actor owns its pages and frames; every
 *  frame read and write is actor RPC. */
class Store {
  canvases = new Map<string, Canvas>()
  /** the page copy in flight per canvas, so the next one waits for it */
  private pageCopies = new Map<string, Promise<unknown>>()

  private async loadCanvasMetadata(id: string): Promise<Canvas | undefined> {
    let canvas = this.canvases.get(id)
    if (!canvas) {
      const loaded = await persist.loadCanvas(id)
      if (!loaded) return undefined
      this.init([loaded])
      canvas = this.canvases.get(id)!
    }
    return canvas
  }

  /** The canvas actor's summary, importing legacy SQL frames the first time.
   *  Undefined for a deleted canvas. */
  private async openCanvas(id: string): Promise<CanvasSummary | undefined> {
    const actor = canvasActor(id)
    let summary = await actor.summary()
    /* the canvas can be deleted from memory while any await below is pending */
    const metadata = () => this.canvases.get(id)
    if (!summary.initialized) {
      const loaded = metadata()
      if (!loaded) return undefined
      const pages = canvasPages(loaded)
      const frames = await mapFrames(await persist.loadLegacyFrameIds(id), async (frameId) => {
        const frame = await persist.loadLegacyFrame(frameId)
        if (!frame || frame.canvasId !== id) throw new Error(`Legacy frame unavailable: ${frameId}`)
        // Frames from before pages, or on a page since deleted, open on the first page.
        return pages.some((page) => page.id === frame.pageId) ? frame : { ...frame, pageId: pages[0]!.id }
      })
      // Imports skip frames already in and the actor opens once, so concurrent
      // imports and retries after a crash cannot overwrite edits.
      for (const batch of importBatches(frames)) await actor.importFrames(batch)
      await actor.initialize(pages)
      summary = await actor.summary()
    }
    const canvas = metadata()
    if (summary.deleted) {
      // The actor is deleted first; finish an SQL delete a crash interrupted.
      if (canvas) {
        this.canvases.delete(id)
        persist.deleteCanvas(id)
      }
      return undefined
    }
    if (canvas) canvas.pages = summary.pages
    return summary
  }

  async syncCanvas(id: string, mode: 'full' | 'summary' | 'index' = 'full'): Promise<Canvas | undefined> {
    const canvas = await this.loadCanvasMetadata(id)
    const summary = canvas && (await this.openCanvas(id))
    if (!canvas || !summary) return undefined
    const state = mode === 'full' ? await canvasActor(id).snapshot() : summary
    if (state.deleted) return undefined
    const frames: Frame[] = mode === 'index' ? [] : state.frames.map((frame) => ({ html: '', ...frame }))
    return {
      ...canvas,
      pages: state.pages,
      frames,
      updatedAt: frames.reduce((latest, frame) => Math.max(latest, frame.updatedAt), canvas.updatedAt),
    }
  }

  init(canvases: Canvas[]) {
    for (const c of canvases) this.canvases.set(c.id, { ...c, pages: canvasPages(c), frames: [] })
  }

  /** Metadata for server loops such as Live Activity push-to-start. */
  allCanvases(): Canvas[] {
    return [...this.canvases.values()]
  }

  /** Count frames with bounded summary reads, without loading frame content. */
  async getCanvasStats(): Promise<{ canvases: number; frames: number }> {
    const counts = await mapFrames([...this.canvases.keys()], async (id) => (await this.openCanvas(id))?.frames.length)
    const present = counts.filter((count): count is number => count !== undefined)
    return { canvases: present.length, frames: present.reduce((total, count) => total + count, 0) }
  }

  /** The dashboard row for one canvas. `viewerId` decides only whether the
   *  canvas is marked as shared-with-me; pass undefined for views that have
   *  no viewer-relative meaning (the admin index). */
  private toMeta(c: Canvas, viewerId?: string) {
    return {
      id: c.id,
      name: c.name,
      ownerId: c.ownerId,
      shared: viewerId !== undefined ? c.ownerId !== viewerId || undefined : undefined,
      ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      frameCount: c.frames.length,
      /* most recently touched frame — the home dashboard renders it as the
         canvas preview via the public /i/ image pipeline */
      previewFrameId: c.frames.length ? c.frames.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id : undefined,
    }
  }

  /** Canvases visible to a user: their own, ones they were invited to, and
   *  every canvas in the workspaces they belong to (the caller resolves
   *  membership — see workspaces.canvasesFor). Unowned (legacy/seeded)
   *  canvases are NOT listed — listing them to everyone leaked one user's
   *  work onto every other user's dashboard. They remain reachable by their
   *  unguessable id and claimable there. */
  async listCanvases(userId: string, workspaceIds: readonly string[] = []) {
    const visible = [...this.canvases.values()].filter(
      (c) =>
        c.ownerId === userId ||
        c.memberIds?.includes(userId) ||
        (c.workspaceId !== undefined && workspaceIds.includes(c.workspaceId)),
    )
    const snapshots = await mapFrames(visible, (c) => this.syncCanvas(c.id, 'summary'))
    return snapshots
      .filter((c): c is Canvas => !!c)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => this.toMeta(c, userId))
  }

  /** The canvas signup made for this user (server/auth.ts): the oldest one
   *  they own. Undefined once they have deleted it, or for an account that
   *  predates the signup hook. */
  firstCanvasOf(userId: string): Canvas | undefined {
    let first: Canvas | undefined
    for (const c of this.canvases.values()) {
      if (c.ownerId === userId && (!first || c.createdAt < first.createdAt)) first = c
    }
    return first
  }

  /** Every canvas on the instance, for the admin index only. Access is the
   *  caller's problem — the only caller is server/admin.ts, behind isAdmin.
   *  A deliberately separate method rather than a flag on listCanvases: a
   *  boolean parameter is the kind of thing that eventually gets passed
   *  `true` from a route that shouldn't. */
  async listAllCanvases(limit = 200) {
    const snapshots = await mapFrames([...this.canvases.keys()], (id) => this.syncCanvas(id, 'summary'))
    const all = snapshots.filter((c): c is Canvas => !!c).sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      total: all.length,
      canvases: all.slice(0, limit).map((c) => ({
        ...this.toMeta(c),
        linkAccess: c.linkAccess ?? 'none',
        memberCount: c.memberIds?.length ?? 0,
      })),
    }
  }

  createCanvas(name: string, ownerId?: string, workspaceId?: string): Canvas {
    const now = Date.now()
    const canvas: Canvas = { id: nanoid(10), name, ownerId, createdAt: now, updatedAt: now, frames: [] }
    if (workspaceId) canvas.workspaceId = workspaceId
    this.canvases.set(canvas.id, canvas)
    canvas.pages = canvasPages(canvas)
    persist.saveCanvas(canvas)
    return canvas
  }

  /** Copy reusable design content into a new private canvas. Collaboration,
   * activity, tasks, external connections and the gallery listing belong to
   * the source only. `name` defaults to "<source> copy"; `dropDemo` leaves
   * product-made onboarding frames behind (a gallery copy is the design,
   * not the welcome tour that happened to sit next to it); `workspaceId`
   * files the copy in a workspace (the caller checks membership). */
  async duplicateCanvas(
    id: string,
    ownerId: string,
    by: string,
    options: { name?: string; dropDemo?: boolean; workspaceId?: string } = {},
  ): Promise<Canvas | undefined> {
    const source = await this.syncCanvas(id)
    if (!source) return undefined
    const now = Date.now()
    const canvasId = nanoid(10)
    const sourceFrames = options.dropDemo ? source.frames.filter((frame) => !frame.demo) : source.frames
    const frameIds = new Map(sourceFrames.map((frame) => [frame.id, `${canvasId}.${nanoid(10)}`]))
    const frames = sourceFrames.map((frame) => ({
      ...frame,
      id: frameIds.get(frame.id)!,
      html: remapFrameTargets(frame.html, frameIds),
      approval: null,
      canvasId,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }))
    const guidelines = source.guidelines?.map((doc) => ({ ...doc, updatedAt: now, updatedBy: by }))
    const references = source.references?.map((ref) => ({
      ...ref,
      id: nanoid(10),
      frameId: frameIds.get(ref.frameId) ?? ref.frameId,
      pinnedBy: by,
      pinnedAt: now,
    }))
    const canvas: Canvas = {
      id: canvasId,
      name: options.name ?? `${source.name} copy`,
      ownerId,
      createdAt: now,
      updatedAt: now,
      frames,
      pages: canvasPages(source).map(({ startFrameId, ...page }) => {
        const start = startFrameId && frameIds.get(startFrameId)
        return start ? { ...page, startFrameId: start } : page
      }),
      ...(source.guides?.length ? { guides: source.guides.map((guide) => ({ ...guide })) } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(guidelines?.length ? { guidelines } : {}),
      ...(references?.length ? { references } : {}),
    }
    const actor = canvasActor(canvasId)
    try {
      for (const batch of importBatches(frames)) await actor.importFrames(batch, 'user')
      await actor.initialize(canvas.pages!)
    } catch (error) {
      await actor.destroy().catch((cleanupError) => console.error('[copy cleanup]', cleanupError))
      throw error
    }
    // Publish only complete copies. A failed SQL response must not destroy ready actors.
    await persist.saveCanvasCopy({ ...canvas, frames: [] })
    this.init([canvas])
    return canvas
  }

  /** Copy a page and every frame on it (same names, geometry and html under
   * fresh ids) into a new page right after the source, named "<source> copy"
   * (numbered when that name is taken). Copies of one canvas run one after
   * another so two at once cannot pick the same name or overshoot the page
   * limit. Rejects with PageLimitError when the canvas is full. */
  duplicatePage(canvasId: string, pageId: string, by: string): Promise<PageCopy | undefined> {
    const previous = this.pageCopies.get(canvasId) ?? Promise.resolve()
    const task = previous.then(
      () => this.copyPage(canvasId, pageId, by),
      () => this.copyPage(canvasId, pageId, by),
    )
    this.pageCopies.set(canvasId, task)
    const release = () => {
      if (this.pageCopies.get(canvasId) === task) this.pageCopies.delete(canvasId)
    }
    void task.then(release, release)
    return task
  }

  private async copyPage(canvasId: string, pageId: string, by: string): Promise<PageCopy | undefined> {
    const canvas = await this.syncCanvas(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    const source = pages.find((page) => page.id === pageId)
    if (!source) return undefined
    if (pages.length >= MAX_PAGES) throw new PageLimitError()
    const now = Date.now()
    const sourceFrames = canvas.frames.filter((frame) => frame.pageId === pageId)
    const frameIds = new Map(sourceFrames.map((frame) => [frame.id, `${canvasId}.${nanoid(10)}`]))
    const start = source.startFrameId && frameIds.get(source.startFrameId)
    const page: CanvasPageInfo = {
      id: nanoid(10),
      name: copyPageName(source.name, names(pages)),
      ...(start ? { startFrameId: start } : {}),
    }
    const guides: CanvasGuide[] = (canvas.guides ?? [])
      .filter((guide) => guide.pageId === pageId)
      .map((guide) => ({ ...guide, id: nanoid(10), pageId: page.id }))
    /* the copy's guides count against the canvas like any other */
    if ((canvas.guides?.length ?? 0) + guides.length > MAX_GUIDES) throw new GuideLimitError()
    /* links within the page follow the copy; links to other pages stay */
    const frames: Frame[] = sourceFrames.map((frame) => ({
      ...frame,
      id: frameIds.get(frame.id)!,
      html: remapFrameTargets(frame.html, frameIds),
      pageId: page.id,
      approval: null,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }))
    // The page and its frames arrive in one write, so a failure leaves nothing behind.
    const inserted = await canvasActor(canvasId).addPage(page, pageId, frames, attribution(by))
    if (inserted.error) return undefined
    const metadata = this.canvases.get(canvasId)
    if (!metadata) return undefined
    metadata.pages = inserted.pages
    /* guides placed while the copy was being written stay alongside; the
       copy keeps only as many of its own as the limit still has room for */
    const room = Math.max(0, MAX_GUIDES - (metadata.guides?.length ?? 0))
    if (guides.length > room) guides.splice(room)
    if (guides.length) metadata.guides = [...(metadata.guides ?? []), ...guides]
    metadata.updatedAt = Math.max(metadata.updatedAt, now)
    persist.saveCanvas(metadata)
    return { source, page, pages: inserted.pages, frames, guides }
  }

  getCanvasMetadata(id: string) {
    return this.canvases.get(id)
  }

  /** Replace the page list through the canvas actor, which refuses to drop a
   *  page that still holds frames. Flow starts are kept; the guides of
   *  deleted pages go with them and are returned so peers can drop them. */
  async setPages(
    canvasId: string,
    pages: CanvasPageInfo[],
    expectedPages: CanvasPageInfo[],
  ): Promise<(PageUpdate & { dropped: CanvasGuide[] }) | undefined> {
    const canvas = await this.loadCanvasMetadata(canvasId)
    if (!canvas || !(await this.openCanvas(canvasId))) return undefined
    const result = await canvasActor(canvasId).setPages(pages, expectedPages)
    canvas.pages = result.pages
    if (result.error) return { ...result, dropped: [] }
    /* a deleted page takes its guides with it */
    const kept = (guide: CanvasGuide) => result.pages.some((page) => page.id === guide.pageId)
    const dropped = (canvas.guides ?? []).filter((guide) => !kept(guide))
    if (dropped.length) canvas.guides = canvas.guides!.filter(kept)
    canvas.updatedAt = Date.now()
    persist.saveCanvas(canvas)
    return { ...result, dropped }
  }

  /** Set (frameId) or clear (null) the frame a page's prototype starts on. */
  async setFlowStart(canvasId: string, pageId: string, frameId: string | null): Promise<CanvasPageInfo[] | undefined> {
    const canvas = await this.loadCanvasMetadata(canvasId)
    if (!canvas || !(await this.openCanvas(canvasId))) return undefined
    const pages = await canvasActor(canvasId).setFlowStart(pageId, frameId)
    if (!pages) return undefined
    canvas.pages = pages
    canvas.updatedAt = Date.now()
    persist.saveCanvas(canvas)
    return pages
  }

  /** Add a ruler guide, or move one that exists. Undefined when the canvas
   *  is gone; throws GuideLimitError on a canvas already holding the most. */
  setGuide(canvasId: string, guide: CanvasGuide): CanvasGuide | undefined {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const guides = canvas.guides ?? []
    const exists = guides.some((g) => g.id === guide.id)
    if (!exists && guides.length >= MAX_GUIDES) throw new GuideLimitError()
    canvas.guides = exists ? guides.map((g) => (g.id === guide.id ? guide : g)) : [...guides, guide]
    persist.saveCanvas(canvas)
    return guide
  }

  /** Remove a ruler guide; false when there was no such guide. */
  deleteGuide(canvasId: string, guideId: string): boolean {
    const canvas = this.canvases.get(canvasId)
    if (!canvas?.guides?.some((g) => g.id === guideId)) return false
    canvas.guides = canvas.guides.filter((g) => g.id !== guideId)
    persist.saveCanvas(canvas)
    return true
  }

  /** Invalidate issued tickets as well as sockets, before an access change answers. */
  async revokeCanvasAccess(id: string): Promise<void> {
    if (!(await this.openCanvas(id))) return
    await canvasActor(id).revokeAccess()
  }

  /** Remove a canvas and its frames from memory + database. */
  async deleteCanvas(id: string): Promise<Canvas | undefined> {
    const c = await this.syncCanvas(id, 'summary')
    if (!c) return undefined
    const deleted = c
    await canvasActor(id).destroy()
    this.canvases.delete(id)
    persist.deleteCanvas(id)
    return deleted
  }

  /** Take ownership of a pre-auth (unowned) canvas. No-op if already owned. */
  async claimCanvas(id: string, userId: string): Promise<Canvas | undefined> {
    const c = this.canvases.get(id)
    if (!c || c.ownerId) return undefined
    c.ownerId = userId
    persist.saveCanvas(c)
    await this.revokeCanvasAccess(id)
    return c
  }

  /** Owner-set link policy ('none' is the default and stored as unset).
   *  Deliberately does not bump updatedAt — a privacy toggle is not a
   *  design edit. */
  async setLinkAccess(id: string, mode: LinkAccess): Promise<Canvas | undefined> {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (mode === 'none') delete c.linkAccess
    else c.linkAccess = mode
    persist.saveCanvas(c)
    await this.revokeCanvasAccess(id)
    return c
  }

  /* ---- workspaces ---- */

  /** File a canvas in a workspace, or take it back to its owner's personal
   *  space (undefined). Access checks are the caller's; like the privacy
   *  toggles this is not a design edit, so updatedAt stays put. */
  async setWorkspace(id: string, workspaceId: string | undefined): Promise<Canvas | undefined> {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (workspaceId) c.workspaceId = workspaceId
    else delete c.workspaceId
    persist.saveCanvas(c)
    await this.revokeCanvasAccess(id)
    return c
  }

  countWorkspaceCanvases(workspaceId: string): number {
    let n = 0
    for (const c of this.canvases.values()) if (c.workspaceId === workspaceId) n++
    return n
  }

  /** A workspace is going away: every canvas in it becomes personal again. */
  async detachWorkspace(workspaceId: string): Promise<void> {
    const changed: string[] = []
    for (const c of this.canvases.values()) {
      if (c.workspaceId === workspaceId) {
        delete c.workspaceId
        persist.saveCanvas(c)
        changed.push(c.id)
      }
    }
    await mapFrames(changed, (id) => this.revokeCanvasAccess(id))
  }

  /* ---- community gallery ---- */

  /** List (or re-describe) a canvas in the gallery. Keeps the original
   *  publish date on edits so "newest" stays honest. Not a design edit, so
   *  updatedAt is left alone. */
  publishCanvas(id: string, listing: { description: string; category: CommunityCategory }): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    c.publishedAt ??= Date.now()
    c.category = listing.category
    if (listing.description) c.description = listing.description
    else delete c.description
    persist.saveCanvas(c)
    return c
  }

  unpublishCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    delete c.publishedAt
    delete c.description
    delete c.category
    persist.saveCanvas(c)
    return c
  }

  /** Every published canvas, newest listing first. Access is deliberately
   *  not a question here: publishing is the owner's opt-in, and the gallery
   *  exposes previews and copies, never the canvas itself. */
  listPublished(): Canvas[] {
    return [...this.canvases.values()]
      .filter((c) => c.publishedAt !== undefined)
      .sort((a, b) => b.publishedAt! - a.publishedAt!)
  }

  /** A gallery copy went out — the trending signal. */
  recordCommunityCopy(id: string) {
    const c = this.canvases.get(id)
    if (!c) return
    c.copyCount = (c.copyCount ?? 0) + 1
    persist.saveCanvas(c)
  }

  /** Invite a user to collaborate. Idempotent; the owner is never listed. */
  addMember(canvasId: string, userId: string, addedBy: string): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c || c.ownerId === userId) return c
    if (!(c.memberIds ??= []).includes(userId)) {
      c.memberIds.push(userId)
      persist.saveMember(canvasId, userId, addedBy, Date.now())
    }
    return c
  }

  async removeMember(canvasId: string, userId: string): Promise<boolean> {
    const c = this.canvases.get(canvasId)
    const idx = c?.memberIds?.indexOf(userId) ?? -1
    if (!c || idx === -1) return false
    c.memberIds!.splice(idx, 1)
    persist.deleteMember(canvasId, userId)
    await this.revokeCanvasAccess(canvasId)
    return true
  }

  renameCanvas(id: string, name: string) {
    const c = this.canvases.get(id)
    if (!c) return undefined
    c.name = name
    c.updatedAt = Date.now()
    persist.saveCanvas(c)
    return c
  }

  getGuidelines(canvasId: string): GuidelineDoc[] {
    return this.canvases.get(canvasId)?.guidelines ?? []
  }

  /** Upsert a design doc by name. New docs without a position are auto-placed
   *  as a card to the left of the frames, stacked downward. */
  async setGuideline(
    canvasId: string,
    name: string,
    markdown: string,
    by: string,
    pos?: { x: number; y: number },
    title?: string,
  ): Promise<GuidelineDoc | undefined> {
    const current = this.canvases.get(canvasId)
    if (!current) return undefined
    const placementCanvas =
      !pos && !current.guidelines?.some((doc) => doc.name === name)
        ? await this.syncCanvas(canvasId, 'summary')
        : undefined
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const docs = (c.guidelines ??= [])
    const now = Date.now()
    let doc = docs.find((d) => d.name === name)
    if (doc) {
      doc.markdown = markdown
      doc.updatedAt = now
      doc.updatedBy = by
      if (pos) Object.assign(doc, pos)
      if (title !== undefined) doc.title = title || undefined
    } else {
      if (docs.length >= MAX_GUIDELINE_DOCS)
        throw new Error(`this canvas already has ${MAX_GUIDELINE_DOCS} design guides — delete one first`)
      const placed = pos ?? this.placeGuideline(placementCanvas ?? c, docs.length)
      doc = { name, markdown, ...(title ? { title } : {}), updatedAt: now, updatedBy: by, ...placed }
      docs.push(doc)
      docs.sort((a, b) => a.name.localeCompare(b.name))
    }
    c.updatedAt = now
    persist.saveGuideline(canvasId, doc)
    persist.saveCanvas(c)
    return doc
  }

  private placeGuideline(c: Canvas, index: number): { x: number; y: number } {
    const CARD_W = 360
    if (!c.frames.length) return { x: 120, y: 120 + index * 380 }
    const minX = Math.min(...c.frames.map((f) => f.x))
    const minY = Math.min(...c.frames.map((f) => f.y))
    return { x: minX - CARD_W - 100, y: minY + index * 380 }
  }

  /** Patch card position / display title; content and history stay untouched. */
  patchGuideline(
    canvasId: string,
    name: string,
    patch: { x?: number; y?: number; title?: string },
  ): GuidelineDoc | undefined {
    const c = this.canvases.get(canvasId)
    const doc = c?.guidelines?.find((d) => d.name === name)
    if (!c || !doc) return undefined
    if (patch.x !== undefined) doc.x = patch.x
    if (patch.y !== undefined) doc.y = patch.y
    if (patch.title !== undefined) doc.title = patch.title || undefined
    persist.saveGuideline(canvasId, doc)
    return doc
  }

  deleteGuideline(canvasId: string, name: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.guidelines?.findIndex((d) => d.name === name) ?? -1
    if (!c || idx === -1) return false
    c.guidelines!.splice(idx, 1)
    c.updatedAt = Date.now()
    persist.deleteGuideline(canvasId, name)
    persist.saveCanvas(c)
    return true
  }

  getReferences(canvasId: string): MemoryReference[] {
    return this.canvases.get(canvasId)?.references ?? []
  }

  /** Pin a frame to Memory: snapshot its HTML now, decoupled from the frame. */
  addReference(canvasId: string, frame: Frame, by: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const ref: MemoryReference = {
      id: nanoid(10),
      frameId: frame.id,
      title: frame.name,
      html: frame.html,
      width: frame.width,
      height: frame.height,
      pinnedBy: by,
      pinnedAt: Date.now(),
    }
    ;(c.references ??= []).unshift(ref)
    persist.saveReference(canvasId, ref)
    return ref
  }

  deleteReference(canvasId: string, id: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    const idx = c?.references?.findIndex((r) => r.id === id) ?? -1
    if (!c || idx === -1) return undefined
    const [ref] = c.references!.splice(idx, 1)
    persist.deleteReference(id)
    return ref
  }

  async getFrameMembership(frameId: string): Promise<Membership | undefined> {
    const canvasId = frameId.includes('.') ? frameId.split('.')[0] : await persist.legacyFrameCanvasId(frameId)
    if (!canvasId || !(await this.loadCanvasMetadata(canvasId)) || !(await this.openCanvas(canvasId))) return undefined
    const pageId = await canvasActor(canvasId).pageOf(frameId)
    return pageId ? { id: frameId, canvasId, pageId } : undefined
  }

  async getFrame(frameId: string): Promise<Frame | undefined> {
    const membership = await this.getFrameMembership(frameId)
    if (!membership) return undefined
    return (await canvasActor(membership.canvasId).frame(frameId)) ?? undefined
  }

  /** Recent frame activity on the canvas, for frames still on it. */
  async frameActivity(canvasId: string): Promise<ActivityItem[]> {
    const { activity, frames } = await canvasActor(canvasId).summary()
    const present = new Set(frames.map((frame) => frame.id))
    return activity.filter((item) => !item.frameId || present.has(item.frameId))
  }

  async listFrameVersions(frameId: string): Promise<FrameVersionInfo[]> {
    const membership = await this.getFrameMembership(frameId)
    return membership ? canvasActor(membership.canvasId).listVersions(frameId) : []
  }

  async getFrameVersion(frameId: string, versionId: string): Promise<FrameVersion | null> {
    const membership = await this.getFrameMembership(frameId)
    return membership ? canvasActor(membership.canvasId).getVersion(frameId, versionId) : null
  }

  async createFrame(
    canvasId: string,
    input: FrameInput,
    by: string,
    creationId?: string,
    kind: Actor['kind'] = 'user',
  ): Promise<Frame | undefined> {
    const metadata = await this.loadCanvasMetadata(canvasId)
    if (!metadata || !(await this.openCanvas(canvasId))) return undefined
    const pages = canvasPages(metadata)
    const pageId = input.pageId ?? pages[0]!.id
    if (!pages.some((page) => page.id === pageId)) return undefined
    const id = creationId ?? `${canvasId}.${nanoid(10)}`
    if (!id.startsWith(`${canvasId}.`) || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('Invalid frame ID')
    const now = Date.now()
    const candidate: Frame = {
      id,
      canvasId,
      pageId,
      name: input.name,
      html: input.html ?? '',
      x: input.x ?? 120,
      y: input.y ?? 120,
      width: input.width ?? 640,
      height: input.height ?? 480,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
      ...(input.demo === undefined ? {} : { demo: input.demo }),
      ...(input.hidden ? { hidden: true } : {}),
      ...(input.locked ? { locked: true } : {}),
    }
    // Without a position the actor places the frame, in the same queue as every other create.
    const frame = await canvasActor(canvasId).createFrame(candidate, attribution(by, kind), input.x === undefined)
    return frame ?? undefined
  }

  async updateFrame(
    frameId: string,
    patch: FramePatch,
    by: string,
    actor?: Actor,
    options: FrameUpdateOptions = {},
  ): Promise<Frame | undefined> {
    const membership = await this.getFrameMembership(frameId)
    if (!membership) return undefined
    if (
      patch.pageId !== undefined &&
      !canvasPages(this.canvases.get(membership.canvasId)!).some((page) => page.id === patch.pageId)
    )
      return undefined
    // A page move is a column change inside the canvas actor, so it lands with the rest of the patch.
    const change = await canvasActor(membership.canvasId).write(
      frameId,
      { type: 'update', patch, ...options },
      actor ?? attribution(by),
    )
    if (isConflict(change)) throw new FrameConflictError(change.frame)
    return change?.frame
  }

  async replaceFrameHtml(frameId: string, find: string, replacement: string, actor: Actor): Promise<Frame | undefined> {
    const membership = await this.getFrameMembership(frameId)
    if (!membership) return undefined
    const change = await canvasActor(membership.canvasId).write(frameId, { type: 'replace', find, replacement }, actor)
    return isConflict(change) ? undefined : change?.frame
  }

  async appendFrameHtml(
    frameId: string,
    chunk: string,
    start: boolean,
    by: string,
    actor?: Actor,
    done = false,
  ): Promise<Frame | undefined> {
    const membership = await this.getFrameMembership(frameId)
    if (!membership) return undefined
    const change = await canvasActor(membership.canvasId).write(
      frameId,
      { type: 'append', chunk, start, done },
      actor ?? attribution(by),
    )
    return isConflict(change) ? undefined : change?.frame
  }

  async deleteFrame(frameId: string): Promise<Frame | undefined> {
    const membership = await this.getFrameMembership(frameId)
    if (!membership) return undefined
    return (await canvasActor(membership.canvasId).deleteFrame(frameId)) ?? undefined
  }
}

export const store = new Store()
