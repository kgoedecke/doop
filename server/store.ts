import { nanoid } from 'nanoid'
import { canvasPages, copyPageName, pageFrames, samePages } from '../shared/pages.ts'
import * as persist from './db/persist.ts'
import type { LinkAccess } from '../shared/canvasRole.ts'
import { MAX_GUIDES } from '../shared/guides.ts'
import { remapFrameTargets } from '../shared/prototype.ts'
import type { ComponentDef } from '../shared/components.ts'
import { byStack, frontOf, stackOf } from '../shared/frameStack.ts'
import { htmlLoaded, setHtml, setHtmlMissHandler, unloadHtml, withHtml } from './frameHtml.ts'
import type { DesignToken } from '../shared/designTokens.ts'
import type {
  Canvas,
  CanvasGuide,
  CanvasPageInfo,
  CommunityCategory,
  Frame,
  GuidelineDoc,
  MemoryReference,
} from '../shared/types.ts'

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

type PageCopy = {
  source: CanvasPageInfo
  page: CanvasPageInfo
  pages: CanvasPageInfo[]
  frames: Frame[]
  guides: CanvasGuide[]
}

const names = (pages: CanvasPageInfo[]) => pages.map((page) => page.name)

/**
 * In-memory canvas/frame state — the hot path for reads, reveals and
 * broadcasts. Every committed mutation is mirrored to the database via
 * the write-through helpers in db/persist.ts; boot hydrates from there.
 *
 * Every canvas and frame is in memory except frame HTML, which is most of
 * the data: boot leaves it out and `load` reads one canvas's when something
 * needs it (frameHtml.ts). Entry points (a REST route, the room join, an MCP
 * tool, an agent run, a job) await `load`; everything past them reads the
 * store synchronously as before. `evictIdle` drops the HTML of a canvas
 * nobody has used for a while, never one that is held or in use.
 */
class Store {
  canvases = new Map<string, Canvas>()
  private frameIndex = new Map<string, string>() // frameId -> canvasId
  /** the page copy in flight per canvas, so the next one waits for it */
  private pageCopies = new Map<string, Promise<unknown>>()
  /** canvases whose frame HTML is in memory -> when they were last used */
  private loaded = new Map<string, number>()
  private loading = new Map<string, Promise<void>>()
  /** canvases an agent run or job is working on, counted */
  private holds = new Map<string, number>()
  /** rooms, agents and streams the store cannot see (wired by index.ts) */
  private inUse: (canvasId: string) => boolean = () => false

  constructor() {
    /* a missed load still fails, but the canvas is on its way for a retry */
    setHtmlMissHandler((canvasId) => {
      this.load(canvasId).catch((error: unknown) =>
        console.error('[store] loading after a miss failed', canvasId, error),
      )
    })
  }

  init(canvases: Canvas[]) {
    for (const c of canvases) {
      c.pages = canvasPages(c)
      this.canvases.set(c.id, c)
      for (const f of c.frames) {
        /* A frame whose page is gone (the server died between a frame move
           and the page's deletion: moves persist on a debounce, pages at
           once) rejoins the first page instead of vanishing from every page. */
        if (!f.pageId || !c.pages.some((page) => page.id === f.pageId)) {
          f.pageId = c.pages[0]!.id
          if (htmlLoaded(f)) persist.saveFrame(f, true)
          else persist.saveFramePage(f.id, f.pageId)
        }
        this.frameIndex.set(f.id, c.id)
      }
      if (c.frames.every(htmlLoaded)) this.loaded.set(c.id, Date.now())
      else this.loaded.delete(c.id)
    }
  }

  /** The canvas with every frame's HTML in memory, read from the database
   *  the first time and kept until `evictIdle`. Concurrent calls share one
   *  read. Undefined for a canvas that does not exist. */
  async load(canvasId: string): Promise<Canvas | undefined> {
    if (!this.canvases.has(canvasId)) return undefined
    if (this.loaded.has(canvasId)) {
      this.loaded.set(canvasId, Date.now())
      return this.canvases.get(canvasId)
    }
    let pending = this.loading.get(canvasId)
    if (!pending) {
      pending = this.fill(canvasId).finally(() => this.loading.delete(canvasId))
      this.loading.set(canvasId, pending)
    }
    await pending
    return this.canvases.get(canvasId)
  }

  /** The canvas of a frame, loaded; undefined when the frame is gone. */
  async loadFrame(frameId: string): Promise<Frame | undefined> {
    const canvasId = this.frameIndex.get(frameId)
    if (canvasId) await this.load(canvasId)
    return this.getFrame(frameId)
  }

  private async fill(canvasId: string) {
    /* a canvas whose every frame was written since boot needs no read */
    if (this.canvases.get(canvasId)?.frames.every(htmlLoaded)) {
      this.loaded.set(canvasId, Date.now())
      return
    }
    const rows = await persist.loadFrameHtml(canvasId)
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return
    const stored = new Map(rows.map((row) => [row.id, row.html]))
    /* a frame written while the read was in flight already holds newer html */
    for (const frame of canvas.frames) {
      if (htmlLoaded(frame)) continue
      const html = stored.get(frame.id)
      if (html === undefined) console.error('[store] frame has no stored html', frame.id)
      setHtml(frame, html ?? '')
    }
    this.loaded.set(canvasId, Date.now())
  }

  /** Keep a canvas loaded while an agent run or job works on it; call the
   *  returned function when done. Load it first. */
  hold(canvasId: string): () => void {
    this.holds.set(canvasId, (this.holds.get(canvasId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.holds.get(canvasId) ?? 1) - 1
      if (count > 0) this.holds.set(canvasId, count)
      else this.holds.delete(canvasId)
      if (this.loaded.has(canvasId)) this.loaded.set(canvasId, Date.now())
    }
  }

  /** Load, hold for the length of `work`, release. */
  async withCanvas<T>(canvasId: string, work: (canvas: Canvas | undefined) => Promise<T>): Promise<T> {
    const canvas = await this.load(canvasId)
    const release = this.hold(canvasId)
    try {
      return await work(canvas)
    } finally {
      release()
    }
  }

  setInUse(check: (canvasId: string) => boolean) {
    this.inUse = check
  }

  isLoaded(canvasId: string): boolean {
    return this.loaded.has(canvasId)
  }

  /** Drop the frame HTML of canvases unused for `idleMs`: never one that is
   *  held, in use (a room, an agent, a stream) or waiting on a frame write.
   *  Returns how many were dropped. */
  evictIdle(idleMs: number, now = Date.now()): number {
    let evicted = 0
    for (const [canvasId, usedAt] of this.loaded) {
      if (now - usedAt < idleMs) continue
      /* in use counts as used: the idle wait starts when the last one leaves */
      if (this.holds.has(canvasId) || this.inUse(canvasId)) {
        this.loaded.set(canvasId, now)
        continue
      }
      const canvas = this.canvases.get(canvasId)
      const unsaved = canvas?.frames.filter((frame) => persist.frameWritePending(frame.id)) ?? []
      if (unsaved.length) {
        /* idle with unsaved frames means a write failed: try it again */
        for (const frame of unsaved) persist.retryFrameWrite(frame)
        continue
      }
      for (const frame of canvas?.frames ?? []) unloadHtml(frame)
      this.loaded.delete(canvasId)
      evicted++
    }
    return evicted
  }

  /** A standalone copy of a frame with its HTML, for a render: from memory
   *  when its canvas is loaded, else read from the database, so one
   *  thumbnail never pulls a whole canvas into memory. A copy, so a canvas
   *  dropped while the render waits for a slot cannot take the html away. */
  async renderableFrame(frameId: string): Promise<Frame | undefined> {
    const frame = this.getFrame(frameId)
    if (!frame) return undefined
    if (htmlLoaded(frame)) return withHtml(frame, frame.html)
    const html = await persist.loadOneFrameHtml(frameId)
    const current = this.getFrame(frameId)
    if (!current) return undefined
    return withHtml(current, htmlLoaded(current) ? current.html : (html ?? ''))
  }

  /** The renderable copy of `frame`, for a render that was handed the
   *  frame's metadata. A frame the store no longer holds renders as given
   *  when it carries its html; otherwise this rejects. */
  async renderSource(frame: Frame): Promise<Frame> {
    const source = await this.renderableFrame(frame.id)
    if (source) return source
    if (htmlLoaded(frame)) return frame
    throw new Error(`frame ${frame.id} no longer exists`)
  }

  stats() {
    return {
      canvases: this.canvases.size,
      loaded: this.loaded.size,
      loading: this.loading.size,
      held: this.holds.size,
    }
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
  listCanvases(userId: string, workspaceIds: readonly string[] = []) {
    return [...this.canvases.values()]
      .filter(
        (c) =>
          c.ownerId === userId ||
          c.memberIds?.includes(userId) ||
          (c.workspaceId !== undefined && workspaceIds.includes(c.workspaceId)),
      )
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
  /** Every canvas, unfiltered and unsummarised, for server-side loops that
   *  apply their own access check per user (Live Activity push-to-start). */
  allCanvases(): Canvas[] {
    return [...this.canvases.values()]
  }

  listAllCanvases(limit = 200) {
    const all = [...this.canvases.values()].sort((a, b) => b.updatedAt - a.updatedAt)
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
    this.loaded.set(canvas.id, now)
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
    const source = await this.load(id)
    if (!source) return undefined
    const now = Date.now()
    const canvasId = nanoid(10)
    const sourceFrames = options.dropDemo ? source.frames.filter((frame) => !frame.demo) : source.frames
    const frameIds = new Map(sourceFrames.map((frame) => [frame.id, nanoid(10)]))
    /* the copies share one createdAt, so each keeps its place in the stack */
    const frames = sourceFrames.map((frame) => ({
      ...frame,
      id: frameIds.get(frame.id)!,
      html: remapFrameTargets(frame.html, frameIds),
      approval: null,
      z: stackOf(frame),
      canvasId,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }))
    const guidelines = source.guidelines?.map((doc) => ({ ...doc, updatedAt: now, updatedBy: by }))
    const tokens = source.tokens?.map((token) => ({ ...token, updatedAt: now, updatedBy: by }))
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
      /* same ids: the markers in the copied frames keep pointing at them */
      ...(source.components?.length
        ? {
            components: source.components.map((def) => ({
              ...def,
              mainFrameId: def.mainFrameId ? (frameIds.get(def.mainFrameId) ?? null) : null,
              updatedAt: now,
              updatedBy: by,
            })),
          }
        : {}),
      ...(tokens?.length ? { tokens } : {}),
      ...(source.tokenThemes?.length ? { tokenThemes: [...source.tokenThemes] } : {}),
      ...(references?.length ? { references } : {}),
    }
    await persist.saveCanvasCopy(canvas)
    this.canvases.set(canvas.id, canvas)
    this.loaded.set(canvas.id, Date.now())
    for (const frame of frames) this.frameIndex.set(frame.id, canvas.id)
    return canvas
  }

  /** Copy a page and every frame on it (same names, geometry and html under
   * fresh ids) into a new page right after the source, named "<source> copy"
   * (numbered when that name is taken). Copies of one canvas run one after
   * another so two at once cannot pick the same name or overshoot the page
   * limit; memory changes only once the copy is durable, as with
   * duplicateCanvas. Rejects with PageLimitError when the canvas is full. */
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
    const canvas = await this.load(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    const source = pages.find((page) => page.id === pageId)
    if (!source) return undefined
    if (pages.length >= MAX_PAGES) throw new PageLimitError()
    const now = Date.now()
    const sourceFrames = pageFrames(canvas, pageId)
    const frameIds = new Map(sourceFrames.map((frame) => [frame.id, nanoid(10)]))
    const start = source.startFrameId && frameIds.get(source.startFrameId)
    const page: CanvasPageInfo = {
      id: nanoid(10),
      name: copyPageName(source.name, names(pages)),
      ...(start ? { startFrameId: start } : {}),
      ...(source.background ? { background: source.background } : {}),
    }
    /* links within the page follow the copy; links to other pages stay */
    const frames: Frame[] = sourceFrames.map((frame) => ({
      ...frame,
      id: frameIds.get(frame.id)!,
      html: remapFrameTargets(frame.html, frameIds),
      pageId: page.id,
      approval: null,
      z: stackOf(frame),
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }))
    const guides: CanvasGuide[] = (canvas.guides ?? [])
      .filter((guide) => guide.pageId === pageId)
      .map((guide) => ({ ...guide, id: nanoid(10), pageId: page.id }))
    /* the copy's guides count against the canvas like any other */
    if ((canvas.guides?.length ?? 0) + guides.length > MAX_GUIDES) throw new GuideLimitError()
    const next = [...pages]
    next.splice(pages.indexOf(source) + 1, 0, page)
    await persist.savePageCopy(
      { ...canvas, pages: next, guides: [...(canvas.guides ?? []), ...guides], updatedAt: now },
      frames,
    )
    if (this.canvases.get(canvasId) !== canvas) return undefined
    /* a page save may have landed during the write: slot the copy after the
       source wherever it is now (or last, if the source is gone), under a
       name the live list does not use */
    const live = canvasPages(canvas)
    if (names(live).includes(page.name)) page.name = copyPageName(source.name, names(live))
    const at = live.findIndex((candidate) => candidate.id === pageId)
    canvas.pages = [...live]
    canvas.pages.splice(at === -1 ? live.length : at + 1, 0, page)
    canvas.frames.push(...frames)
    canvas.frames.sort(byStack)
    for (const frame of frames) this.frameIndex.set(frame.id, canvasId)
    /* guides placed while the copy was being written stay alongside; the
       copy keeps only as many of its own as the limit still has room for */
    const copied = guides.length > 0
    const room = Math.max(0, MAX_GUIDES - (canvas.guides?.length ?? 0))
    if (guides.length > room) guides.splice(room)
    if (guides.length) canvas.guides = [...(canvas.guides ?? []), ...guides]
    canvas.updatedAt = Math.max(canvas.updatedAt, now)
    if (!samePages(canvas.pages, next) || copied) persist.saveCanvas(canvas)
    return { source, page, pages: canvas.pages, frames, guides }
  }

  /** Replace the page list. Returns the saved pages (flow starts kept) and
   *  the guides that went with deleted pages, so peers can drop them;
   *  undefined when the canvas is gone. */
  setPages(
    canvasId: string,
    pages: import('../shared/types.ts').CanvasPageInfo[],
  ): { pages: import('../shared/types.ts').CanvasPageInfo[]; dropped: CanvasGuide[] } | undefined {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const firstId = canvasPages(canvas)[0]!.id
    for (const frame of canvas.frames) {
      if (!frame.pageId) {
        frame.pageId = firstId
        persist.saveFrame(frame, true)
      }
    }
    /* a page-list save renames, reorders, adds or deletes pages — it never
       moves a flow start or recolours a page, which only setFlowStart and
       setPageBackground change */
    const current = canvasPages(canvas)
    const merged = pages.map(({ startFrameId: _start, background: _background, ...page }) => {
      const kept = current.find((p) => p.id === page.id)
      return {
        ...page,
        ...(kept?.startFrameId ? { startFrameId: kept.startFrameId } : {}),
        ...(kept?.background ? { background: kept.background } : {}),
      }
    })
    canvas.pages = merged
    /* a deleted page takes its guides with it */
    const kept = (guide: CanvasGuide) => merged.some((page) => page.id === guide.pageId)
    const dropped = (canvas.guides ?? []).filter((guide) => !kept(guide))
    if (dropped.length) canvas.guides = canvas.guides!.filter(kept)
    canvas.updatedAt = Date.now()
    persist.saveCanvas(canvas)
    return { pages: merged, dropped }
  }

  /** Set (frameId) or clear (null) the frame a page's prototype starts on. */
  setFlowStart(canvasId: string, pageId: string, frameId: string | null) {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    if (!pages.some((p) => p.id === pageId)) return undefined
    canvas.pages = pages.map((page) => {
      if (page.id !== pageId) return page
      const { startFrameId: _previous, ...rest } = page
      return frameId ? { ...rest, startFrameId: frameId } : rest
    })
    canvas.updatedAt = Date.now()
    persist.saveCanvas(canvas)
    return canvas.pages
  }

  /** Set (a `#rrggbb`) or clear (null) a page's own canvas colour. */
  setPageBackground(canvasId: string, pageId: string, background: string | null) {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    if (!pages.some((p) => p.id === pageId)) return undefined
    canvas.pages = pages.map((page) => {
      if (page.id !== pageId) return page
      const { background: _previous, ...rest } = page
      return background ? { ...rest, background } : rest
    })
    canvas.updatedAt = Date.now()
    persist.saveCanvas(canvas)
    return canvas.pages
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

  getCanvas(id: string) {
    return this.canvases.get(id)
  }

  /** Remove a canvas and its frames from memory + database. */
  deleteCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    for (const f of c.frames) this.frameIndex.delete(f.id)
    this.canvases.delete(id)
    this.loaded.delete(id)
    persist.deleteCanvas(id)
    return c
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
  setLinkAccess(id: string, mode: LinkAccess): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (mode === 'none') delete c.linkAccess
    else c.linkAccess = mode
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

  getComponents(canvasId: string): ComponentDef[] {
    return this.canvases.get(canvasId)?.components ?? []
  }

  /** Add or replace by id, and mirror it to the database. */
  saveComponent(canvasId: string, def: ComponentDef) {
    const c = this.canvases.get(canvasId)
    if (!c) return
    const list = (c.components ??= [])
    const at = list.findIndex((existing) => existing.id === def.id)
    if (at === -1) list.push(def)
    else list[at] = def
    persist.saveComponent(canvasId, def)
  }

  deleteComponent(canvasId: string, id: string): boolean {
    const c = this.canvases.get(canvasId)
    const at = c?.components?.findIndex((def) => def.id === id) ?? -1
    if (!c?.components || at === -1) return false
    c.components.splice(at, 1)
    persist.deleteComponent(canvasId, id)
    return true
  }

  getGuidelines(canvasId: string): GuidelineDoc[] {
    return this.canvases.get(canvasId)?.guidelines ?? []
  }

  /** Upsert a design doc by name. New docs without a position are auto-placed
   *  as a card to the left of the frames, stacked downward. */
  setGuideline(
    canvasId: string,
    name: string,
    markdown: string,
    by: string,
    pos?: { x: number; y: number },
    title?: string,
  ): GuidelineDoc | undefined {
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
      const placed = pos ?? this.placeGuideline(c, docs.length)
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

  getTokens(canvasId: string): DesignToken[] {
    return this.canvases.get(canvasId)?.tokens ?? []
  }

  /** Upsert tokens by name: a new one lands at the end of its canvas's
   *  order, an existing one keeps its place unless the patch moves it. */
  setTokens(
    canvasId: string,
    inputs: (Pick<DesignToken, 'name' | 'type' | 'value'> & {
      themes?: Record<string, string>
      description?: string
      order?: number
    })[],
    by: string,
  ): DesignToken[] | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const tokens = (c.tokens ??= [])
    const now = Date.now()
    const written: DesignToken[] = []
    for (const input of inputs) {
      let token = tokens.find((t) => t.name === input.name)
      if (token) {
        token.type = input.type
        token.value = input.value
        token.themes = input.themes && Object.keys(input.themes).length ? input.themes : undefined
        token.description = input.description || undefined
        if (input.order !== undefined) token.order = input.order
        token.updatedAt = now
        token.updatedBy = by
      } else {
        const last = tokens.reduce((max, t) => Math.max(max, t.order), 0)
        token = {
          name: input.name,
          type: input.type,
          value: input.value,
          ...(input.themes && Object.keys(input.themes).length ? { themes: input.themes } : {}),
          ...(input.description ? { description: input.description } : {}),
          order: input.order ?? last + 1,
          updatedAt: now,
          updatedBy: by,
        }
        tokens.push(token)
      }
      persist.saveToken(canvasId, token)
      written.push(token)
    }
    tokens.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    c.updatedAt = now
    persist.saveCanvas(c)
    return written
  }

  /** Rename a token in place: its order and description ride along. */
  renameToken(canvasId: string, name: string, newName: string, by: string): DesignToken | undefined {
    const c = this.canvases.get(canvasId)
    const token = c?.tokens?.find((t) => t.name === name)
    if (!c || !token) return undefined
    persist.deleteToken(canvasId, name)
    token.name = newName
    token.updatedAt = Date.now()
    token.updatedBy = by
    persist.saveToken(canvasId, token)
    c.updatedAt = token.updatedAt
    persist.saveCanvas(c)
    return token
  }

  getTokenThemes(canvasId: string): string[] {
    return this.canvases.get(canvasId)?.tokenThemes ?? []
  }

  /** Replace the theme list; tokens drop the values of themes that left. */
  setTokenThemes(canvasId: string, themes: string[], by: string): string[] | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    c.tokenThemes = themes.length ? [...themes] : undefined
    const now = Date.now()
    for (const token of c.tokens ?? []) {
      if (!token.themes) continue
      const kept = Object.fromEntries(Object.entries(token.themes).filter(([theme]) => themes.includes(theme)))
      if (Object.keys(kept).length === Object.keys(token.themes).length) continue
      token.themes = Object.keys(kept).length ? kept : undefined
      token.updatedAt = now
      token.updatedBy = by
      persist.saveToken(canvasId, token)
    }
    c.updatedAt = now
    persist.saveCanvas(c)
    return themes
  }

  /** Rename a theme: the list entry and every token's value under it. */
  renameTokenTheme(canvasId: string, from: string, to: string, by: string): boolean {
    const c = this.canvases.get(canvasId)
    if (!c || !c.tokenThemes?.includes(from)) return false
    c.tokenThemes = c.tokenThemes.map((theme) => (theme === from ? to : theme))
    const now = Date.now()
    for (const token of c.tokens ?? []) {
      if (!token.themes || !(from in token.themes)) continue
      const { [from]: moved, ...rest } = token.themes
      token.themes = { ...rest, ...(moved === undefined ? {} : { [to]: moved }) }
      token.updatedAt = now
      token.updatedBy = by
      persist.saveToken(canvasId, token)
    }
    c.updatedAt = now
    persist.saveCanvas(c)
    return true
  }

  deleteToken(canvasId: string, name: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.tokens?.findIndex((t) => t.name === name) ?? -1
    if (!c || idx === -1) return false
    c.tokens!.splice(idx, 1)
    c.updatedAt = Date.now()
    persist.deleteToken(canvasId, name)
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

  getFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    return this.canvases.get(canvasId)?.frames.find((f) => f.id === frameId)
  }

  createFrame(
    canvasId: string,
    input: {
      name: string
      pageId?: string
      x?: number
      y?: number
      width?: number
      height?: number
      html?: string
      demo?: boolean
      hidden?: boolean
      locked?: boolean
      /** where it stacks (undo brings a deleted frame back to its place);
       *  in front of everything on the page when unset */
      z?: number
      rotation?: number
    },
    by: string,
  ): Frame | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const pageId = input.pageId ?? canvasPages(c)[0]!.id
    if (!canvasPages(c).some((page) => page.id === pageId)) return undefined
    const frames = pageFrames(c, pageId)
    const now = Date.now()
    // auto-place: to the right of the right-most frame
    let x = input.x
    let y = input.y
    if (x === undefined || y === undefined) {
      const rightmost = frames.reduce((mx, f) => Math.max(mx, f.x + f.width), 0)
      x ??= frames.length ? rightmost + 80 : 120
      y ??= 120
    }
    const frame: Frame = {
      id: nanoid(10),
      canvasId,
      pageId,
      name: input.name,
      x,
      y,
      width: input.width ?? 640,
      height: input.height ?? 480,
      html: input.html ?? '',
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
      z: input.z ?? frontOf(frames) ?? now,
    }
    if (input.demo) frame.demo = true
    if (input.hidden) frame.hidden = true
    if (input.locked) frame.locked = true
    if (input.rotation) frame.rotation = input.rotation
    c.frames.push(frame)
    c.frames.sort(byStack)
    c.updatedAt = now
    this.frameIndex.set(frame.id, canvasId)
    persist.saveFrame(frame, true)
    persist.saveCanvas(c)
    return frame
  }

  updateFrame(
    frameId: string,
    patch: Partial<
      Pick<
        Frame,
        | 'name'
        | 'pageId'
        | 'x'
        | 'y'
        | 'width'
        | 'height'
        | 'html'
        | 'hidden'
        | 'locked'
        | 'z'
        | 'rotation'
        | 'approval'
      >
    >,
    by: string,
    opts: {
      /** the html change only marks elements up (a `data-doop-id` stamp):
       *  nothing a reviewer signed off on moved, so sign-off stands */
      annotation?: boolean
    } = {},
  ): Frame | undefined {
    const frame = this.getFrame(frameId)
    if (!frame) return undefined
    if (
      patch.pageId !== undefined &&
      !canvasPages(this.canvases.get(frame.canvasId)!).some((p) => p.id === patch.pageId)
    )
      return undefined
    const designChanged =
      !opts.annotation &&
      (['html', 'width', 'height'] as const).some((key) => patch[key] !== undefined && patch[key] !== frame[key])
    const c = this.canvases.get(frame.canvasId)!
    /* a frame moved to another page lands in front there, as Figma does */
    if (patch.pageId !== undefined && patch.pageId !== frame.pageId && patch.z === undefined)
      patch = { ...patch, z: frontOf(pageFrames(c, patch.pageId)) ?? frame.z }
    Object.assign(frame, patch)
    if (patch.z !== undefined) c.frames.sort(byStack)
    // All writers (including streams, sync and restores) invalidate sign-off.
    if (designChanged && frame.approval?.status === 'ready_for_dev') {
      frame.approval = { ...frame.approval, status: 'needs_review' }
    }
    // Also serves as the optimistic-save version, including writes in the same millisecond.
    frame.updatedAt = Math.max(Date.now(), frame.updatedAt + 1)
    frame.updatedBy = by
    c.updatedAt = frame.updatedAt
    persist.saveFrame(frame) // debounced: streaming appends land as one write per burst
    persist.saveCanvas(c)
    return frame
  }

  deleteFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const idx = c.frames.findIndex((f) => f.id === frameId)
    if (idx === -1) return undefined
    const [frame] = c.frames.splice(idx, 1)
    c.updatedAt = Date.now()
    this.frameIndex.delete(frameId)
    persist.deleteFrame(frameId)
    persist.saveCanvas(c)
    return frame
  }
}

export const store = new Store()
