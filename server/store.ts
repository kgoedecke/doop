import { nanoid } from 'nanoid'
import { canvasIndex, frameActor, mapFrames } from './frame-sync.ts'
import type { FrameInput, FramePatch } from '../src/actor.ts'
import * as persist from './db/persist.ts'
import { colorFor, createFrameId } from '../shared/types.ts'
import type { Actor, Canvas, CommunityCategory, Frame, GuidelineDoc, MemoryReference } from '../shared/types.ts'

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

  private async ensureIndex(id: string): Promise<boolean> {
    const status = await canvasIndex(id).initialize()
    // Removal is durable before cleanup. A later request resumes cleanup after
    // an app crash; tombstones prevent retries from bringing a frame back.
    if (!this.cleaning.has(id)) {
      const cleanup = this.cleanupFrames(id)
        .catch((error) => console.error('[frame cleanup]', error))
        .finally(() => this.cleaning.delete(id))
      this.cleaning.set(id, cleanup)
    }
    if (status.deleted) this.canvases.delete(id)
    return !status.deleted
  }

  private async cleanupFrames(id: string): Promise<void> {
    const index = canvasIndex(id)
    await mapFrames(await index.pendingDeletes(), async (frameId) => {
      await frameActor(frameId).destroy()
      await index.confirmDelete(frameId)
    })
  }

  async syncCanvas(id: string, mode: 'full' | 'summary' | 'index' = 'full'): Promise<Canvas | undefined> {
    const canvas = await this.loadCanvasMetadata(id)
    if (!canvas || !(await this.ensureIndex(id))) return undefined
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
            return { html: '', ...frame }
          })
    const present = frames.filter((frame): frame is Frame => !!frame)
    return {
      ...canvas,
      frames: present,
      updatedAt: present.reduce((latest, frame) => Math.max(latest, frame.updatedAt), canvas.updatedAt),
    }
  }

  async syncFrame(id: string): Promise<Frame | undefined> {
    return this.getFrame(id)
  }

  init(canvases: Canvas[]) {
    for (const c of canvases) this.canvases.set(c.id, { ...c, frames: [] })
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
    const frameIds = new Map(sourceFrames.map((frame) => [frame.id, createFrameId(canvasId, frame.name, nanoid(10))]))
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
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(guidelines?.length ? { guidelines } : {}),
      ...(references?.length ? { references } : {}),
    }
    await persist.saveCanvasCopy({ ...canvas, frames: [] })
    await mapFrames(frames, (frame) => frameActor(frame.id).initialize(frame))
    await canvasIndex(canvasId).initialize(frames.map((frame) => frame.id))
    this.init([canvas])
    return canvas
  }

  getCanvasMetadata(id: string) {
    return this.canvases.get(id)
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
  claimCanvas(id: string, userId: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c || c.ownerId) return undefined
    c.ownerId = userId
    persist.saveCanvas(c)
    return c
  }

  /** Owner-set link policy ('none' is the default and stored as unset).
   *  Deliberately does not bump updatedAt — a privacy toggle is not a
   *  design edit. */
  setLinkAccess(id: string, mode: 'edit' | 'none'): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (mode === 'edit') c.linkAccess = 'edit'
    else delete c.linkAccess
    persist.saveCanvas(c)
    return c
  }

  /* ---- workspaces ---- */

  /** File a canvas in a workspace, or take it back to its owner's personal
   *  space (undefined). Access checks are the caller's; like the privacy
   *  toggles this is not a design edit, so updatedAt stays put. */
  setWorkspace(id: string, workspaceId: string | undefined): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (workspaceId) c.workspaceId = workspaceId
    else delete c.workspaceId
    persist.saveCanvas(c)
    return c
  }

  countWorkspaceCanvases(workspaceId: string): number {
    let n = 0
    for (const c of this.canvases.values()) if (c.workspaceId === workspaceId) n++
    return n
  }

  /** A workspace is going away: every canvas in it becomes personal again. */
  detachWorkspace(workspaceId: string): void {
    for (const c of this.canvases.values()) {
      if (c.workspaceId === workspaceId) {
        delete c.workspaceId
        persist.saveCanvas(c)
      }
    }
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

  removeMember(canvasId: string, userId: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.memberIds?.indexOf(userId) ?? -1
    if (!c || idx === -1) return false
    c.memberIds!.splice(idx, 1)
    persist.deleteMember(canvasId, userId)
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
      const placed = pos ?? this.placeGuideline((await this.syncCanvas(canvasId)) ?? c, docs.length)
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

  async getFrameMembership(frameId: string): Promise<{ id: string; canvasId: string } | undefined> {
    const canvasId = frameId.split('.')[0]
    if (
      !frameId.includes('.') ||
      !canvasId ||
      !(await this.loadCanvasMetadata(canvasId)) ||
      !(await this.ensureIndex(canvasId))
    )
      return undefined
    return (await canvasIndex(canvasId).has(frameId)) ? { id: frameId, canvasId } : undefined
  }

  async getFrame(frameId: string): Promise<Frame | undefined> {
    const membership = await this.getFrameMembership(frameId)
    if (!membership) return undefined
    const { frame } = await frameActor(frameId).snapshot()
    if (!frame) {
      if (!(await canvasIndex(membership.canvasId).has(frameId))) return undefined
      throw new Error(`Frame unavailable: ${frameId}`)
    }
    return frame
  }

  async createFrame(canvasId: string, input: FrameInput, by: string, creationId?: string): Promise<Frame | undefined> {
    if (!(await this.loadCanvasMetadata(canvasId)) || !(await this.ensureIndex(canvasId))) return undefined
    const id = creationId ?? createFrameId(canvasId, input.name, nanoid(10))
    if (!id.startsWith(`${canvasId}.`) || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('Invalid frame ID')
    let x = input.x
    if (x === undefined) {
      const { frameIds } = await canvasIndex(canvasId).snapshot()
      const summaries = await mapFrames(frameIds, (id) => frameActor(id).summary())
      const edges = summaries.flatMap(({ frame }) => (frame ? [frame.x + frame.width] : []))
      x = edges.length ? Math.max(...edges) + 80 : 120
    }
    const now = Date.now()
    const frame: Frame = {
      id,
      canvasId,
      name: input.name,
      html: input.html ?? '',
      x,
      y: input.y ?? 120,
      width: input.width ?? 640,
      height: input.height ?? 480,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
      ...(input.demo === undefined ? {} : { demo: input.demo }),
    }
    const actor = frameActor(id)
    await actor.initialize(frame)
    const saved = (await actor.snapshot()).frame
    if (!saved) return undefined
    if (!(await canvasIndex(canvasId).add(id))) {
      await actor.destroy()
      return undefined
    }
    return saved
  }

  async updateFrame(frameId: string, patch: FramePatch, by: string, actor?: Actor): Promise<Frame | undefined> {
    if (!(await this.getFrameMembership(frameId))) return undefined
    return (
      await frameActor(frameId).write(
        { type: 'update', patch },
        actor ?? { name: by, kind: 'user', color: colorFor(by) },
      )
    )?.frame
  }

  async appendFrameHtml(
    frameId: string,
    chunk: string,
    start: boolean,
    by: string,
    actor?: Actor,
    done = false,
  ): Promise<Frame | undefined> {
    if (!(await this.getFrameMembership(frameId))) return undefined
    return (
      await frameActor(frameId).write(
        { type: 'append', chunk, start, done },
        actor ?? { name: by, kind: 'user', color: colorFor(by) },
      )
    )?.frame
  }

  async deleteFrame(frameId: string): Promise<Frame | undefined> {
    const frame = await this.syncFrame(frameId)
    if (!frame) return undefined
    await canvasIndex(frame.canvasId).remove(frameId)
    await frameActor(frameId).destroy()
    await canvasIndex(frame.canvasId).confirmDelete(frameId)
    return frame
  }
}

export const store = new Store()
