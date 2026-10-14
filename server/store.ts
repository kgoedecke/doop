import { nanoid } from 'nanoid'
import { canvasIndex, frameActor, mapFrames } from './frame-sync.ts'
import type { FrameInput, FramePatch, PageUpdate } from '../src/actor.ts'
import { canvasPages } from '../shared/pages.ts'
import { validateFrame } from '../shared/frame-validation.ts'
import * as persist from './db/persist.ts'
import { colorFor } from '../shared/types.ts'
import type {
  Actor,
  Canvas,
  CanvasPageInfo,
  CommunityCategory,
  Frame,
  GuidelineDoc,
  MemoryReference,
} from '../shared/types.ts'

export const MAX_GUIDELINE_DOCS = 20

/** SQL owns canvas metadata. Every frame read and write goes through actor RPC. */
class Store {
  canvases = new Map<string, Canvas>()
  private cleaning = new Map<string, Promise<void>>()

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

  private async ensureMembership(id: string): Promise<boolean> {
    const index = canvasIndex(id)
    let status = await index.snapshot()
    if (!status.initialized) {
      const ids = await persist.loadLegacyFrameIds(id)
      await mapFrames(ids, async (frameId) => {
        const frame = await persist.loadLegacyFrame(frameId)
        if (!frame || frame.canvasId !== id) throw new Error(`Legacy frame unavailable: ${frameId}`)
        const pages = canvasPages(this.canvases.get(id)!)
        const pageId = pages.some((page) => page.id === frame.pageId) ? frame.pageId : pages[0]!.id
        await frameActor(frameId).initialize({ ...frame, pageId })
      })
      // Each actor initializes once. Concurrent imports and retries after a crash
      // cannot overwrite edits or reset an already initialized index.
      status = await index.initialize(ids)
    }
    if (!status.deleted && !status.pages) {
      const frames = await mapFrames(status.frameIds, async (frameId) => {
        const { frame } = await frameActor(frameId).summary()
        if (!frame && (await index.has(frameId))) throw new Error(`Frame unavailable: ${frameId}`)
        return [frameId, frame?.pageId ?? ''] as const
      })
      status = await index.initializePages(canvasPages(this.canvases.get(id)!), Object.fromEntries(frames))
    }
    if (status.pages) this.canvases.get(id)!.pages = status.pages
    // Removal is durable before cleanup. A later request resumes cleanup after
    // an app crash; tombstones prevent retries from bringing a frame back.
    void this.recoverCanvasFrames(id, status.deleted)
    if (status.deleted) this.canvases.delete(id)
    return !status.deleted
  }

  private recoverCanvasFrames(id: string, deleted: boolean): Promise<void> {
    const existing = this.cleaning.get(id)
    if (existing) return existing
    const cleanup = this.cleanupFrames(id)
      .then(() => {
        if (deleted) persist.deleteCanvas(id)
      })
      .catch((error) => console.error('[frame cleanup]', error))
      .finally(() => this.cleaning.delete(id))
    this.cleaning.set(id, cleanup)
    return cleanup
  }

  private async cleanupFrames(id: string): Promise<void> {
    const index = canvasIndex(id)
    await mapFrames(await index.pending(), async ({ id: frameId, status }) => {
      const actor = frameActor(frameId)
      if (status === 'creating') {
        const snapshot = await actor.snapshot()
        if (snapshot.deleted) {
          await index.remove(frameId)
          await index.confirmDelete(frameId)
        } else if (snapshot.frame && !(await index.activate(frameId))) await actor.destroy()
      } else {
        await actor.destroy()
        await index.confirmDelete(frameId)
      }
    })
  }

  async syncCanvas(id: string, mode: 'full' | 'summary' | 'index' = 'full'): Promise<Canvas | undefined> {
    const canvas = await this.loadCanvasMetadata(id)
    if (!canvas || !(await this.ensureMembership(id))) return undefined
    const snapshot = await canvasIndex(id).snapshot()
    if (snapshot.deleted) return undefined
    const frames =
      mode === 'index'
        ? []
        : await mapFrames(snapshot.frameIds, async (frameId) => {
            const frame =
              mode === 'full'
                ? (await frameActor(frameId).snapshot()).frame
                : (await frameActor(frameId).summary()).frame
            if (!frame) {
              if (!(await canvasIndex(id).has(frameId))) return undefined // concurrent deletion
              throw new Error(`Frame unavailable: ${frameId}`)
            }
            return { html: '', ...frame, pageId: snapshot.framePages?.[frameId] ?? frame.pageId }
          })
    const present = frames.filter((frame) => frame !== undefined)
    return {
      ...canvas,
      pages: snapshot.pages ?? canvasPages(canvas),
      frames: present,
      updatedAt: present.reduce((latest, frame) => Math.max(latest, frame.updatedAt), canvas.updatedAt),
    }
  }

  init(canvases: Canvas[]) {
    for (const c of canvases) this.canvases.set(c.id, { ...c, pages: canvasPages(c), frames: [] })
  }

  /** Metadata for server loops such as Live Activity push-to-start. */
  allCanvases(): Canvas[] {
    return [...this.canvases.values()]
  }

  /** Count membership with bounded index reads, without loading frame content. */
  async getCanvasStats(): Promise<{ canvases: number; frames: number }> {
    const counts = await mapFrames([...this.canvases.keys()], async (id) => {
      if (!(await this.ensureMembership(id))) return undefined
      const index = await canvasIndex(id).snapshot()
      return index.deleted ? undefined : index.frameIds.length
    })
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
      pages: canvasPages(source).map((page) => ({ ...page })),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(guidelines?.length ? { guidelines } : {}),
      ...(references?.length ? { references } : {}),
    }
    const index = canvasIndex(canvasId)
    try {
      await index.initialize()
      await index.initializePages(canvas.pages!)
      for (const frame of frames) {
        if (!(await index.reserveFrame(frame, false, {}))) throw new Error('Could not prepare copied frame')
        await frameActor(frame.id).initialize(frame)
        if (!(await index.activate(frame.id))) throw new Error('Could not finish copied frame')
      }
    } catch (error) {
      await index
        .destroy()
        .then(() => this.cleanupFrames(canvasId))
        .catch((cleanupError) => console.error('[copy cleanup]', cleanupError))
      throw error
    }
    // Publish only complete copies. A failed SQL response must not destroy ready actors.
    await persist.saveCanvasCopy({ ...canvas, frames: [] })
    this.init([canvas])
    return canvas
  }

  getCanvasMetadata(id: string) {
    return this.canvases.get(id)
  }

  async setPages(
    canvasId: string,
    pages: CanvasPageInfo[],
    expectedPages: CanvasPageInfo[],
  ): Promise<PageUpdate | undefined> {
    const canvas = await this.loadCanvasMetadata(canvasId)
    if (!canvas || !(await this.ensureMembership(canvasId))) return undefined
    const result = await canvasIndex(canvasId).setPages(pages, expectedPages)
    canvas.pages = result.pages
    if (!result.error) {
      canvas.updatedAt = Date.now()
      persist.saveCanvas(canvas)
    }
    return result
  }

  /** Invalidate issued tickets as well as sockets, before an access change answers. */
  async revokeCanvasAccess(id: string): Promise<void> {
    if (!(await this.ensureMembership(id))) return
    const index = canvasIndex(id)
    const { frameIds } = await index.snapshot()
    await index.revokeAccess()
    await mapFrames(frameIds, (frameId) => frameActor(frameId).revokeAccess())
  }

  /** Remove a canvas and its frames from memory + database. */
  async deleteCanvas(id: string): Promise<Canvas | undefined> {
    const c = await this.syncCanvas(id, 'summary')
    if (!c) return undefined
    const deleted = c
    await canvasIndex(id).destroy()
    await this.cleanupFrames(id)
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
  async setLinkAccess(id: string, mode: 'edit' | 'none'): Promise<Canvas | undefined> {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (mode === 'edit') c.linkAccess = 'edit'
    else delete c.linkAccess
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

  async getFrameMembership(frameId: string): Promise<{ id: string; canvasId: string; pageId?: string } | undefined> {
    const canvasId = frameId.includes('.') ? frameId.split('.')[0] : await persist.legacyFrameCanvasId(frameId)
    if (!canvasId || !(await this.loadCanvasMetadata(canvasId)) || !(await this.ensureMembership(canvasId)))
      return undefined
    const snapshot = await canvasIndex(canvasId).snapshot()
    return !snapshot.deleted && snapshot.frameIds.includes(frameId)
      ? { id: frameId, canvasId, pageId: snapshot.framePages?.[frameId] }
      : undefined
  }

  async getFrame(frameId: string): Promise<Frame | undefined> {
    const membership = await this.getFrameMembership(frameId)
    if (!membership) return undefined
    const { frame } = await frameActor(frameId).snapshot()
    if (!frame) {
      if (!(await canvasIndex(membership.canvasId).has(frameId))) return undefined
      throw new Error(`Frame unavailable: ${frameId}`)
    }
    return { ...frame, pageId: membership.pageId ?? frame.pageId }
  }

  async createFrame(canvasId: string, input: FrameInput, by: string, creationId?: string): Promise<Frame | undefined> {
    const metadata = await this.loadCanvasMetadata(canvasId)
    if (!metadata || !(await this.ensureMembership(canvasId))) return undefined
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
    }
    const index = canvasIndex(canvasId)
    let frame: Frame | 'retry' | null
    do {
      const canvas = input.x === undefined ? await this.syncCanvas(canvasId, 'summary') : undefined
      const observed = Object.fromEntries(
        (canvas?.frames ?? []).map(({ id, x, width, pageId }) => [id, { x, width, pageId }]),
      )
      frame = await index.reserveFrame(candidate, input.x === undefined, observed)
    } while (frame === 'retry')
    if (!frame) return undefined
    const actor = frameActor(id)
    let saved: Frame | null
    try {
      await actor.initialize(frame)
      saved = (await actor.snapshot()).frame
    } catch (error) {
      // Release the page reservation when this create fails, even if its payload committed.
      await index
        .remove(id)
        .then(() => this.cleanupFrames(canvasId))
        .catch((cleanupError) => console.error('[frame cleanup]', cleanupError))
      throw error
    }
    if (!saved) return undefined
    if (!(await canvasIndex(canvasId).activate(id))) {
      await actor.destroy()
      return undefined
    }
    return { ...saved, pageId: frame.pageId }
  }

  async updateFrame(frameId: string, patch: FramePatch, by: string, actor?: Actor): Promise<Frame | undefined> {
    const membership = await this.getFrameMembership(frameId)
    if (!membership) return undefined
    if (
      patch.pageId !== undefined &&
      !canvasPages(this.canvases.get(membership.canvasId)!).some((page) => page.id === patch.pageId)
    )
      return undefined
    const { pageId, ...content } = patch
    if (pageId !== undefined) {
      const current = (await frameActor(frameId).snapshot()).frame
      if (!current) return undefined
      validateFrame({ ...current, ...content })
      if (!(await canvasIndex(membership.canvasId).moveFrame(frameId, pageId))) return undefined
    }
    const change = await frameActor(frameId).write(
      { type: 'update', patch: content },
      actor ?? { name: by, kind: 'user', color: colorFor(by) },
    )
    return change ? { ...change.frame, pageId: pageId ?? membership.pageId ?? change.frame.pageId } : undefined
  }

  async replaceFrameHtml(frameId: string, find: string, replacement: string, actor: Actor): Promise<Frame | undefined> {
    const membership = await this.getFrameMembership(frameId)
    if (!membership) return undefined
    const change = await frameActor(frameId).write({ type: 'replace', find, replacement }, actor)
    return change ? { ...change.frame, pageId: membership.pageId ?? change.frame.pageId } : undefined
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
    const change = await frameActor(frameId).write(
      { type: 'append', chunk, start, done },
      actor ?? { name: by, kind: 'user', color: colorFor(by) },
    )
    return change ? { ...change.frame, pageId: membership.pageId ?? change.frame.pageId } : undefined
  }

  async deleteFrame(frameId: string): Promise<Frame | undefined> {
    const frame = await this.getFrame(frameId)
    if (!frame) return undefined
    await canvasIndex(frame.canvasId).remove(frameId)
    await frameActor(frameId).destroy()
    await canvasIndex(frame.canvasId).confirmDelete(frameId)
    return frame
  }
}

export const store = new Store()
