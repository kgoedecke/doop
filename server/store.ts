import { nanoid } from 'nanoid'
import { canvasPages, copyPageName, framePageId, pageFrames, samePages } from '../shared/pages.ts'
import * as persist from './db/persist.ts'
import type { LinkAccess } from '../shared/canvasRole.ts'
import { MAX_GUIDES } from '../shared/guides.ts'
import { remapFrameTargets } from '../shared/prototype.ts'
import { renderRevOf, rendersSame, type ComponentDef } from '../shared/components.ts'
import { composeFrameHtml } from '../shared/frameCompose.ts'
import {
  THEMES_DEPENDENCY,
  bumpStyle,
  componentDependency,
  forgetStyleVersions,
  tokenDependency,
} from './styleVersion.ts'
import { byStack, frontOf, stackOf } from '../shared/frameStack.ts'
import { htmlLoaded, setHtml, setHtmlMissHandler, unloadHtml, withHtml } from './frameHtml.ts'
import { afterCommit, inTransaction, recordUndo, requireBoundary } from './journal.ts'
import { needsWaking, placeheldHtml, wakingHtml, type WakeReport } from './frameRest.ts'
import { forgetCounts } from './componentUsage.ts'
import { runOperation } from './workBudget.ts'
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

/** Pages, and frames wherever they are: what a write or a drawing reads. */
export type PageScope = { pages: readonly string[]; frames: readonly string[] }

/** What `store.hold` keeps in memory: the whole canvas, or a scope's pages. */
export type HoldScope = 'all' | PageScope

/** reads a load makes at most while frames keep moving onto its pages */
const MAX_LOAD_PASSES = 3

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

/** A frame as it stands, to put back if the write about to change it is undone. Its html
 *  is read only when loaded: an unloaded frame goes back to unloaded. */
function frameState(frame: Frame) {
  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(frame)) if (key !== 'html') fields[key] = (frame as never)[key]
  const loaded = htmlLoaded(frame)
  return { fields, loaded, html: loaded ? frame.html : '' }
}

function restoreFrame(frame: Frame, state: ReturnType<typeof frameState>) {
  for (const key of Object.keys(frame)) if (key !== 'html' && !(key in state.fields)) delete (frame as never)[key]
  Object.assign(frame, state.fields)
  if (state.loaded) setHtml(frame, state.html)
  else unloadHtml(frame)
}

/**
 * In-memory canvas/frame state — the hot path for reads, reveals and
 * broadcasts. Every committed mutation is mirrored to the database via
 * the write-through helpers in db/persist.ts; boot hydrates from there.
 *
 * Every write here is journaled (server/journal.ts): memory changes at once,
 * with a way back recorded, and the database write waits for the commit of
 * the operation it is part of. An operation that is refused part of the way
 * leaves memory as it was and the database untouched. An undo puts back only
 * what is still its own: a frame or component someone else has written since
 * is theirs. The copies (duplicateCanvas, duplicatePage) are the exception:
 * they are durable before memory changes, and are not undone.
 *
 * Every canvas and frame is in memory except frame HTML, which is most of
 * the data: boot leaves it out and it is read per page when something needs
 * it (frameHtml.ts). Entry points (a REST route, the room join, an MCP tool,
 * an agent run, a job) await `loadPages` for the pages they work on, or
 * `load` for the whole canvas; everything past them reads the store
 * synchronously as before. `evictIdle` drops the HTML of a page nobody has
 * used for a while, never one that is held, in use or waiting on a write.
 */
/** Set a definition's `renderRev` as it is saved: where it stood when this state renders
 *  what the one it replaces did, else this revision. Decided here, the one place every
 *  save passes, since a revision is opened before its content is known (`bumpRevision`,
 *  then the main's write). The definition is the caller's own fresh object. */
function markRenderRev(def: ComponentDef, replaced: ComponentDef | undefined) {
  const carried = replaced ? (rendersSame(replaced, def) ? renderRevOf(replaced) : def.rev) : renderRevOf(def)
  if (carried < def.rev) def.renderRev = carried
  else delete def.renderRev
}

class Store {
  canvases = new Map<string, Canvas>()
  private frameIndex = new Map<string, string>() // frameId -> canvasId
  /** the page copy in flight per canvas, so the next one waits for it */
  private pageCopies = new Map<string, Promise<unknown>>()
  /** canvases with frame HTML in memory -> each page read -> when it was last used */
  private pagesUsed = new Map<string, Map<string, number>>()
  /** frames whose HTML is being read -> that read, so a second load waits for it */
  private reading = new Map<string, Promise<void>>()
  /** loads in flight per canvas: a canvas being read is never dropped meanwhile */
  private loads = new Map<string, number>()
  /** what agent runs, jobs and requests are working on, per canvas */
  private holds = new Map<string, HoldScope[]>()
  /** rooms, agents and streams the store cannot see (wired by index.ts): true
   *  when the whole canvas is in use, else the pages people are looking at */
  private inUse: (canvasId: string) => boolean | ReadonlySet<string> = () => false
  /** told when a page's frame HTML leaves memory (wired by index.ts: the room) */
  private pageDropped: (canvasId: string, pageId: string) => void = () => {}

  /** Put these fields of the canvas back if the transaction is undone. `deep` for the ones
   *  whose items are changed in place (tokens, guideline docs). */
  private remember(c: Canvas, keys: readonly (keyof Canvas)[], deep = false) {
    if (!inTransaction()) return
    const fields = c as unknown as Record<string, unknown>
    const before = keys.map((key) => {
      const value = fields[key]
      return { key, had: key in c, value: deep ? structuredClone(value) : Array.isArray(value) ? [...value] : value }
    })
    recordUndo(() => {
      for (const { key, had, value } of before) {
        if (had) fields[key] = value
        else delete fields[key]
      }
    })
  }

  /** The canvas row is written once per transaction, with what the canvas holds by then. */
  private saveCanvasLater(c: Canvas) {
    afterCommit(() => {
      if (this.canvases.get(c.id) === c) persist.saveCanvas(c)
    }, `canvas:${c.id}`)
  }

  /** A design edit landed: the canvas is as recent as it. */
  private touchCanvas(c: Canvas, at: number) {
    const before = c.updatedAt
    c.updatedAt = at
    recordUndo(() => {
      if (c.updatedAt === at) c.updatedAt = before
    })
  }

  /** The frame row is written at the commit, as the frame stands then; `now` skips the debounce. */
  private saveFrameLater(frame: Frame, now = false) {
    afterCommit(() => {
      if (this.getFrame(frame.id) === frame) persist.saveFrame(frame, now)
    }, `frame:${frame.id}`)
  }

  constructor() {
    /* a missed load still fails, but the frame's page is on its way for a retry */
    setHtmlMissHandler((canvasId, frameId) => {
      this.loadForFrames(canvasId, [frameId]).catch((error: unknown) =>
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
      if (c.frames.length && c.frames.every(htmlLoaded))
        this.touchPages(
          c.id,
          c.pages.map((page) => page.id),
        )
      else this.pagesUsed.delete(c.id)
    }
  }

  /** The canvas with every frame's HTML in memory (`loadPages` of every
   *  page), for work on the whole canvas. Undefined for a canvas that does
   *  not exist. */
  load(canvasId: string): Promise<Canvas | undefined> {
    return this.loadPages(canvasId, 'all')
  }

  /** The canvas with the HTML of every frame on these pages, and of
   *  `frameIds` wherever they are, in memory: read from the database the first time, shared by concurrent calls, and kept
   *  until `evictIdle` drops the page. Undefined for a canvas that does not
   *  exist. */
  async loadPages(
    canvasId: string,
    pageIds: readonly string[] | 'all',
    frameIds: readonly string[] = [],
  ): Promise<Canvas | undefined> {
    if (!this.canvases.has(canvasId)) return undefined
    this.loads.set(canvasId, (this.loads.get(canvasId) ?? 0) + 1)
    try {
      /* a frame moved onto these pages while their HTML was read is read in turn */
      for (let pass = 0; pass < MAX_LOAD_PASSES; pass++) {
        const canvas = this.canvases.get(canvasId)
        if (!canvas) return undefined
        const missing = this.framesOf(canvas, pageIds, frameIds).filter((frame) => !htmlLoaded(frame))
        if (!missing.length) break
        await this.readHtml(
          canvasId,
          missing.map((frame) => frame.id),
        )
      }
      const canvas = this.canvases.get(canvasId)
      if (!canvas) return undefined
      this.touchPages(canvasId, this.pagesOf(canvas, pageIds, frameIds))
      return canvas
    } finally {
      const left = (this.loads.get(canvasId) ?? 1) - 1
      if (left > 0) this.loads.set(canvasId, left)
      else this.loads.delete(canvasId)
    }
  }

  /** What a write to these frames may read: their pages, and every component
   *  main on the canvas (a write that carries a main asks whether that main
   *  lives in another frame, and a deleted one's component looks for it). */
  loadForFrames(canvasId: string, frameIds: readonly string[]): Promise<Canvas | undefined> {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return Promise.resolve(undefined)
    const { pages, frames } = this.framesScope(canvasId, frameIds)
    return this.loadPages(canvasId, pages, frames)
  }

  /** What drawing on a page may read: its frames and the component mains. */
  loadForPage(canvasId: string, pageId: string): Promise<Canvas | undefined> {
    const { pages, frames } = this.pageScope(canvasId, pageId)
    return this.loadPages(canvasId, pages, frames)
  }

  /** What a write to these frames reads (`loadForFrames`), for `hold`. */
  framesScope(canvasId: string, frameIds: readonly string[]): PageScope {
    const canvas = this.canvases.get(canvasId)
    const pages = frameIds.flatMap((id) => {
      const frame = this.getFrame(id)
      return canvas && frame && frame.canvasId === canvasId ? [framePageId(canvas, frame)] : []
    })
    return { pages, frames: [...frameIds, ...this.mainFrameIds(canvasId)] }
  }

  /** What drawing on a page reads (`loadForPage`), for `hold`. */
  pageScope(canvasId: string, pageId: string): PageScope {
    return { pages: [pageId], frames: this.mainFrameIds(canvasId) }
  }

  private mainFrameIds(canvasId: string): string[] {
    return this.getComponents(canvasId).flatMap((def) => (def.mainFrameId ? [def.mainFrameId] : []))
  }

  /** The frame with what a write to it may read in memory (`loadForFrames`);
   *  undefined when the frame is gone. */
  async loadFrame(frameId: string): Promise<Frame | undefined> {
    const canvasId = this.frameIndex.get(frameId)
    if (canvasId) await this.loadForFrames(canvasId, [frameId])
    return this.getFrame(frameId)
  }

  /** The frames a load asks for: every frame on `pageIds`, and `frameIds`. */
  private framesOf(canvas: Canvas, pageIds: readonly string[] | 'all', frameIds: readonly string[]): Frame[] {
    if (pageIds === 'all') return canvas.frames
    const pages = new Set(pageIds)
    const ids = new Set(frameIds)
    return canvas.frames.filter((frame) => ids.has(frame.id) || pages.has(framePageId(canvas, frame)))
  }

  /** The pages a load counts as used: the ones it names and the ones its frames are on. */
  private pagesOf(canvas: Canvas, pageIds: readonly string[] | 'all', frameIds: readonly string[]): string[] {
    if (pageIds === 'all') return canvasPages(canvas).map((page) => page.id)
    const pages = new Set(pageIds)
    for (const id of frameIds) {
      const frame = this.getFrame(id)
      if (frame?.canvasId === canvas.id) pages.add(framePageId(canvas, frame))
    }
    return [...pages]
  }

  private touchPages(canvasId: string, pageIds: readonly string[], at = Date.now()) {
    let used = this.pagesUsed.get(canvasId)
    if (!used) this.pagesUsed.set(canvasId, (used = new Map()))
    for (const pageId of pageIds) used.set(pageId, at)
  }

  /** Read these frames' HTML, once: a frame another load is reading already is waited for. */
  private async readHtml(canvasId: string, frameIds: readonly string[]) {
    const waits: Promise<void>[] = []
    const fresh: string[] = []
    for (const id of frameIds) {
      const pending = this.reading.get(id)
      if (pending) waits.push(pending)
      else fresh.push(id)
    }
    if (fresh.length) {
      const read = this.fetchHtml(canvasId, fresh)
      for (const id of fresh) this.reading.set(id, read)
      const done = () => {
        for (const id of fresh) if (this.reading.get(id) === read) this.reading.delete(id)
      }
      void read.then(done, done)
      waits.push(read)
    }
    await Promise.all(waits)
  }

  private async fetchHtml(canvasId: string, frameIds: readonly string[]) {
    const stored = await persist.loadFrameHtml(frameIds)
    for (const id of frameIds) {
      const frame = this.getFrame(id)
      /* gone, or written while the read was in flight: that html is newer */
      if (!frame || htmlLoaded(frame)) continue
      const html = stored.get(id)
      if (html === undefined) console.error('[store] frame has no stored html', id)
      /* rendered and taken in within one turn: from here on the frame is in memory, where a
         change to a component it uses finds it (server/propagation.ts) */
      const report: WakeReport = { lost: 0, revived: [] }
      const awake = this.wakeHtml(canvasId, html ?? '', id, report)
      setHtml(frame, awake)
      /* a row stored written out and behind its components was brought up to date: stored
         again as it now is, so the next read of it has nothing to do */
      if (report.upgraded) persist.saveFrame(frame)
      const canvas = this.canvases.get(canvasId)
      if (canvas && awake !== html) forgetCounts(canvas, id)
      /* a page of frames to render is not one turn of the event loop */
      if (awake !== html) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  /** Stored HTML as memory holds it: its component references written out, and instances
   *  stored written out brought up to their components (server/frameRest.ts). Each frame is
   *  an operation of its own, so a page of many frames is not one work budget. A frame that
   *  cannot be rendered (over its budget, markup the engine trips on) never fails the read
   *  of its page: its references are shown as placeholders, which the next save stores as
   *  the references again. */
  wakeHtml(canvasId: string, stored: string, frameId: string, report?: WakeReport): string {
    const canvas = this.canvases.get(canvasId)
    const defs = canvas?.components ?? []
    if (!canvas || !needsWaking(stored, defs)) return stored
    const where = `canvas ${canvasId} frame ${frameId}`
    try {
      return runOperation(`read frame ${frameId}`, canvasId, () => wakingHtml(stored, defs, where, report))
    } catch (error) {
      console.error(`[frames] ${where}: reading it failed`, error)
      try {
        return runOperation(`read frame ${frameId} as placeholders`, canvasId, () => placeheldHtml(stored, where))
      } catch (again) {
        console.error(`[frames] ${where}: placeholders failed too; read as stored`, again)
        return stored
      }
    }
  }

  /** Keep what an agent run, job or request works on in memory: the whole
   *  canvas, or the pages (and the pages of the frames) `scope` names. Call the
   *  returned function when done: those pages count as used then, and only
   *  those, so work on one page never keeps the others. Load what it needs first. */
  hold(canvasId: string, scope: HoldScope = 'all'): () => void {
    const held = this.holds.get(canvasId) ?? []
    held.push(scope)
    this.holds.set(canvasId, held)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = this.holds.get(canvasId) ?? []
      const at = left.indexOf(scope)
      if (at >= 0) left.splice(at, 1)
      if (!left.length) this.holds.delete(canvasId)
      const used = this.pagesUsed.get(canvasId)
      const canvas = this.canvases.get(canvasId)
      if (!used || !canvas) return
      this.touchPages(
        canvasId,
        this.scopePages(canvas, scope).filter((pageId) => used.has(pageId)),
      )
    }
  }

  /** The pages a hold keeps. */
  private scopePages(canvas: Canvas, scope: HoldScope): string[] {
    return scope === 'all'
      ? canvasPages(canvas).map((page) => page.id)
      : this.pagesOf(canvas, scope.pages, scope.frames)
  }

  /** The pages of a canvas nothing may drop now: true for all of them (a load
   *  in flight, a hold on the whole canvas, an agent or a stream on it), else
   *  the ones held or looked at. */
  private pinnedPages(canvas: Canvas): true | Set<string> {
    if (this.loads.has(canvas.id)) return true
    const inUse = this.inUse(canvas.id)
    if (inUse === true) return true
    const pinned = new Set(inUse || [])
    for (const scope of this.holds.get(canvas.id) ?? []) {
      if (scope === 'all') return true
      for (const pageId of this.scopePages(canvas, scope)) pinned.add(pageId)
    }
    return pinned
  }

  /** Load the whole canvas, hold it for the length of `work`, release. */
  async withCanvas<T>(canvasId: string, work: (canvas: Canvas | undefined) => Promise<T>): Promise<T> {
    const canvas = await this.load(canvasId)
    const release = this.hold(canvasId, 'all')
    try {
      return await work(canvas)
    } finally {
      release()
    }
  }

  /** Load what a write to these frames may read (`loadForFrames`), hold it
   *  for the length of `work`, release. */
  async withFrames<T>(canvasId: string, frameIds: readonly string[], work: () => Promise<T>): Promise<T> {
    await this.loadForFrames(canvasId, frameIds)
    const release = this.hold(canvasId, this.framesScope(canvasId, frameIds))
    try {
      return await work()
    } finally {
      release()
    }
  }

  setInUse(check: (canvasId: string) => boolean | ReadonlySet<string>) {
    this.inUse = check
  }

  onPageDropped(listener: (canvasId: string, pageId: string) => void) {
    this.pageDropped = listener
  }

  /** Every frame of the canvas has its HTML in memory. */
  isLoaded(canvasId: string): boolean {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return false
    return canvas.frames.every(htmlLoaded)
  }

  /** Every frame on the page has its HTML in memory. */
  isPageLoaded(canvasId: string, pageId: string): boolean {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return false
    return pageFrames(canvas, pageId).every(htmlLoaded)
  }

  /** Drop the frame HTML of pages unused for `idleMs`: never one of a canvas
   *  that is held or being read, one in use (a room looking at it; an agent or
   *  a stream on the canvas) or one waiting on a frame write. Returns how many
   *  pages were dropped. */
  evictIdle(idleMs: number, now = Date.now()): number {
    let evicted = 0
    for (const canvasId of [...this.pagesUsed.keys()])
      evicted += this.evictPages(canvasId, (usedAt) => now - usedAt >= idleMs, now)
    return evicted
  }

  /** Drop the pages of a canvas `idle` picks, unless held, in use or waiting
   *  on a frame write; returns how many were dropped. */
  private evictPages(canvasId: string, idle: (usedAt: number) => boolean, now: number): number {
    const canvas = this.canvases.get(canvasId)
    const used = this.pagesUsed.get(canvasId)
    if (!canvas || !used) {
      this.pagesUsed.delete(canvasId)
      return 0
    }
    /* frames that came into memory some other way (a frame moved onto a page,
       a component's main read with a write) count their page as used now */
    for (const frame of canvas.frames) {
      const pageId = framePageId(canvas, frame)
      if (!used.has(pageId) && htmlLoaded(frame)) used.set(pageId, now)
    }
    const pinned = this.pinnedPages(canvas)
    let dropped = 0
    for (const [pageId, usedAt] of used) {
      /* in use counts as used: the idle wait starts when the last one leaves */
      if (pinned === true || pinned.has(pageId)) {
        used.set(pageId, now)
        continue
      }
      if (!idle(usedAt) || !this.dropPage(canvas, pageId)) continue
      used.delete(pageId)
      dropped++
      this.pageDropped(canvasId, pageId)
    }
    if (!used.size) this.pagesUsed.delete(canvasId)
    return dropped
  }

  /** Unload one page's frame HTML, unless a frame on it waits on a write; true if it was dropped. */
  private dropPage(canvas: Canvas, pageId: string): boolean {
    const frames = pageFrames(canvas, pageId).filter(htmlLoaded)
    const unsaved = frames.filter((frame) => persist.frameWritePending(frame.id))
    if (unsaved.length) {
      /* idle with unsaved frames means a write failed: try it again */
      for (const frame of unsaved) persist.retryFrameWrite(frame)
      return false
    }
    for (const frame of frames) unloadHtml(frame)
    return true
  }

  /** A standalone copy of a frame with its HTML, for a render: from memory
   *  when its page is loaded, else read from the database, so one
   *  thumbnail never pulls a whole page into memory. A copy, so a page
   *  dropped while the render waits for a slot cannot take the html away. */
  async renderableFrame(frameId: string): Promise<Frame | undefined> {
    const frame = this.getFrame(frameId)
    if (!frame) return undefined
    if (htmlLoaded(frame)) return withHtml(frame, frame.html)
    const html = await persist.loadOneFrameHtml(frameId)
    const current = this.getFrame(frameId)
    if (!current) return undefined
    if (htmlLoaded(current)) return withHtml(current, current.html)
    return withHtml(current, this.wakeHtml(current.canvasId, html ?? '', frameId))
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
    let pages = 0
    for (const used of this.pagesUsed.values()) pages += used.size
    return {
      canvases: this.canvases.size,
      loaded: this.pagesUsed.size,
      pages,
      loading: this.loads.size,
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
    requireBoundary('store.createCanvas')
    this.canvases.set(canvas.id, canvas)
    canvas.pages = canvasPages(canvas)
    this.touchPages(
      canvas.id,
      canvas.pages.map((page) => page.id),
      now,
    )
    recordUndo(() => {
      if (this.canvases.get(canvas.id) !== canvas) return
      for (const frame of canvas.frames) this.frameIndex.delete(frame.id)
      this.canvases.delete(canvas.id)
      this.pagesUsed.delete(canvas.id)
    })
    this.saveCanvasLater(canvas)
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
    this.touchPages(
      canvas.id,
      canvasPages(canvas).map((page) => page.id),
    )
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
    const canvas = await this.loadPages(canvasId, [pageId])
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
    requireBoundary('store.setPages')
    this.remember(canvas, ['pages', 'guides', 'updatedAt'])
    const firstId = canvasPages(canvas)[0]!.id
    for (const frame of canvas.frames) {
      if (!frame.pageId) {
        frame.pageId = firstId
        recordUndo(() => {
          if (frame.pageId === firstId) delete frame.pageId
        })
        this.saveFrameLater(frame, true)
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
    this.saveCanvasLater(canvas)
    return { pages: merged, dropped }
  }

  /** Set (frameId) or clear (null) the frame a page's prototype starts on. */
  setFlowStart(canvasId: string, pageId: string, frameId: string | null) {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    if (!pages.some((p) => p.id === pageId)) return undefined
    requireBoundary('store.setFlowStart')
    this.remember(canvas, ['pages', 'updatedAt'])
    canvas.pages = pages.map((page) => {
      if (page.id !== pageId) return page
      const { startFrameId: _previous, ...rest } = page
      return frameId ? { ...rest, startFrameId: frameId } : rest
    })
    canvas.updatedAt = Date.now()
    this.saveCanvasLater(canvas)
    return canvas.pages
  }

  /** Set (a `#rrggbb`) or clear (null) a page's own canvas colour. */
  setPageBackground(canvasId: string, pageId: string, background: string | null) {
    const canvas = this.canvases.get(canvasId)
    if (!canvas) return undefined
    const pages = canvasPages(canvas)
    if (!pages.some((p) => p.id === pageId)) return undefined
    requireBoundary('store.setPageBackground')
    this.remember(canvas, ['pages', 'updatedAt'])
    canvas.pages = pages.map((page) => {
      if (page.id !== pageId) return page
      const { background: _previous, ...rest } = page
      return background ? { ...rest, background } : rest
    })
    canvas.updatedAt = Date.now()
    this.saveCanvasLater(canvas)
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
    requireBoundary('store.setGuide')
    this.remember(canvas, ['guides'])
    canvas.guides = exists ? guides.map((g) => (g.id === guide.id ? guide : g)) : [...guides, guide]
    this.saveCanvasLater(canvas)
    return guide
  }

  /** Remove a ruler guide; false when there was no such guide. */
  deleteGuide(canvasId: string, guideId: string): boolean {
    const canvas = this.canvases.get(canvasId)
    if (!canvas?.guides?.some((g) => g.id === guideId)) return false
    requireBoundary('store.deleteGuide')
    this.remember(canvas, ['guides'])
    canvas.guides = canvas.guides.filter((g) => g.id !== guideId)
    this.saveCanvasLater(canvas)
    return true
  }

  getCanvas(id: string) {
    return this.canvases.get(id)
  }

  /** Remove a canvas and its frames from memory + database. */
  deleteCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.deleteCanvas')
    forgetStyleVersions(id)
    const used = this.pagesUsed.get(id)
    for (const f of c.frames) this.frameIndex.delete(f.id)
    this.canvases.delete(id)
    this.pagesUsed.delete(id)
    recordUndo(() => {
      if (this.canvases.has(id)) return
      this.canvases.set(id, c)
      for (const f of c.frames) this.frameIndex.set(f.id, id)
      if (used) this.pagesUsed.set(id, used)
    })
    afterCommit(() => {
      if (!this.canvases.has(id)) persist.deleteCanvas(id)
    })
    return c
  }

  /** Take ownership of a pre-auth (unowned) canvas. No-op if already owned. */
  claimCanvas(id: string, userId: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c || c.ownerId) return undefined
    requireBoundary('store.claimCanvas')
    this.remember(c, ['ownerId'])
    c.ownerId = userId
    this.saveCanvasLater(c)
    return c
  }

  /** Owner-set link policy ('none' is the default and stored as unset).
   *  Deliberately does not bump updatedAt — a privacy toggle is not a
   *  design edit. */
  setLinkAccess(id: string, mode: LinkAccess): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.setLinkAccess')
    this.remember(c, ['linkAccess'])
    if (mode === 'none') delete c.linkAccess
    else c.linkAccess = mode
    this.saveCanvasLater(c)
    return c
  }

  /* ---- workspaces ---- */

  /** File a canvas in a workspace, or take it back to its owner's personal
   *  space (undefined). Access checks are the caller's; like the privacy
   *  toggles this is not a design edit, so updatedAt stays put. */
  setWorkspace(id: string, workspaceId: string | undefined): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.setWorkspace')
    this.remember(c, ['workspaceId'])
    if (workspaceId) c.workspaceId = workspaceId
    else delete c.workspaceId
    this.saveCanvasLater(c)
    return c
  }

  /** A workspace stopped sharing beyond the team: every canvas in it goes
   *  private (share link back to no access) and leaves the Community gallery.
   *  Returns the ids of the canvases it changed. */
  closePublicSharing(workspaceId: string): string[] {
    const closed: string[] = []
    for (const c of this.canvases.values()) {
      if (c.workspaceId !== workspaceId) continue
      if (this.closeCanvasSharing(c)) closed.push(c.id)
    }
    return closed
  }

  /** Make one canvas private and take it out of the gallery; false when it
   *  was neither shared by link nor listed. */
  closeCanvasSharing(c: Canvas): boolean {
    if (!c.linkAccess && c.publishedAt === undefined) return false
    requireBoundary('store.closeCanvasSharing')
    this.remember(c, ['linkAccess', 'publishedAt', 'category', 'description'])
    delete c.linkAccess
    delete c.publishedAt
    delete c.description
    delete c.category
    this.saveCanvasLater(c)
    return true
  }

  countWorkspaceCanvases(workspaceId: string): number {
    let n = 0
    for (const c of this.canvases.values()) if (c.workspaceId === workspaceId) n++
    return n
  }

  /** A workspace is going away: every canvas in it becomes personal again.
   *  Returns the ids of the canvases it moved. */
  detachWorkspace(workspaceId: string): string[] {
    const moved: string[] = []
    for (const c of this.canvases.values()) {
      if (c.workspaceId === workspaceId) {
        requireBoundary('store.detachWorkspace')
        this.remember(c, ['workspaceId'])
        delete c.workspaceId
        this.saveCanvasLater(c)
        moved.push(c.id)
      }
    }
    return moved
  }

  /* ---- community gallery ---- */

  /** List (or re-describe) a canvas in the gallery. Keeps the original
   *  publish date on edits so "newest" stays honest. Not a design edit, so
   *  updatedAt is left alone. */
  publishCanvas(id: string, listing: { description: string; category: CommunityCategory }): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.publishCanvas')
    this.remember(c, ['publishedAt', 'category', 'description'])
    c.publishedAt ??= Date.now()
    c.category = listing.category
    if (listing.description) c.description = listing.description
    else delete c.description
    this.saveCanvasLater(c)
    return c
  }

  unpublishCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.unpublishCanvas')
    this.remember(c, ['publishedAt', 'category', 'description'])
    delete c.publishedAt
    delete c.description
    delete c.category
    this.saveCanvasLater(c)
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
    requireBoundary('store.recordCommunityCopy')
    this.remember(c, ['copyCount'])
    c.copyCount = (c.copyCount ?? 0) + 1
    this.saveCanvasLater(c)
  }

  /** Invite a user to collaborate. Idempotent; the owner is never listed. */
  addMember(canvasId: string, userId: string, addedBy: string): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c || c.ownerId === userId) return c
    if (!c.memberIds?.includes(userId)) {
      requireBoundary('store.addMember')
      this.remember(c, ['memberIds'])
      ;(c.memberIds ??= []).push(userId)
      const at = Date.now()
      afterCommit(() => persist.saveMember(canvasId, userId, addedBy, at))
    }
    return c
  }

  removeMember(canvasId: string, userId: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.memberIds?.indexOf(userId) ?? -1
    if (!c || idx === -1) return false
    requireBoundary('store.removeMember')
    this.remember(c, ['memberIds'])
    c.memberIds!.splice(idx, 1)
    afterCommit(() => persist.deleteMember(canvasId, userId))
    return true
  }

  renameCanvas(id: string, name: string) {
    const c = this.canvases.get(id)
    if (!c) return undefined
    requireBoundary('store.renameCanvas')
    this.remember(c, ['name', 'updatedAt'])
    c.name = name
    c.updatedAt = Date.now()
    this.saveCanvasLater(c)
    return c
  }

  getComponents(canvasId: string): ComponentDef[] {
    return this.canvases.get(canvasId)?.components ?? []
  }

  /** Add or replace by id; the database hears at the commit. Definitions are replaced,
   *  never changed in place, so the one this replaced is what an undo puts back. */
  saveComponent(canvasId: string, def: ComponentDef) {
    const c = this.canvases.get(canvasId)
    if (!c) return
    requireBoundary('store.saveComponent')
    const list = (c.components ??= [])
    const at = list.findIndex((existing) => existing.id === def.id)
    const replaced = at === -1 ? undefined : list[at]
    markRenderRev(def, replaced)
    if (at === -1) list.push(def)
    else list[at] = def
    /* its stylesheet is part of every render of a frame using it, and so is its markup: a
       frame stores a reference to it, not the markup (server/styleVersion.ts, frameRest.ts) */
    if (replaced?.css !== def.css || replaced.head.join('\n') !== def.head.join('\n') || !rendersSame(replaced, def))
      bumpStyle(canvasId, componentDependency(def.id))
    recordUndo(() => {
      /* saved again since by someone else: theirs stands */
      const now = c.components?.indexOf(def) ?? -1
      if (now === -1) return
      if (replaced) c.components![now] = replaced
      else c.components!.splice(now, 1)
    })
    /* a definition replaced again before the commit was never the stored one */
    afterCommit(() => {
      if (this.canvases.get(canvasId) === c && c.components?.includes(def)) persist.saveComponent(canvasId, def)
    })
  }

  deleteComponent(canvasId: string, id: string): boolean {
    const c = this.canvases.get(canvasId)
    const at = c?.components?.findIndex((def) => def.id === id) ?? -1
    if (!c?.components || at === -1) return false
    requireBoundary('store.deleteComponent')
    bumpStyle(canvasId, componentDependency(id))
    const [removed] = c.components.splice(at, 1)
    recordUndo(() => {
      const list = (c.components ??= [])
      if (removed && !list.some((def) => def.id === id)) list.splice(Math.min(at, list.length), 0, removed)
    })
    afterCommit(() => {
      if (!c.components?.some((def) => def.id === id)) persist.deleteComponent(canvasId, id)
    })
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
    requireBoundary('store.setGuideline')
    this.remember(c, ['guidelines', 'updatedAt'], true)
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
    const saved = doc
    afterCommit(() => persist.saveGuideline(canvasId, saved))
    this.saveCanvasLater(c)
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
    requireBoundary('store.patchGuideline')
    const before = { x: doc.x, y: doc.y, title: doc.title }
    recordUndo(() => Object.assign(doc, before))
    if (patch.x !== undefined) doc.x = patch.x
    if (patch.y !== undefined) doc.y = patch.y
    if (patch.title !== undefined) doc.title = patch.title || undefined
    afterCommit(() => persist.saveGuideline(canvasId, doc))
    return doc
  }

  deleteGuideline(canvasId: string, name: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.guidelines?.findIndex((d) => d.name === name) ?? -1
    if (!c || idx === -1) return false
    requireBoundary('store.deleteGuideline')
    this.remember(c, ['guidelines', 'updatedAt'])
    c.guidelines!.splice(idx, 1)
    c.updatedAt = Date.now()
    afterCommit(() => persist.deleteGuideline(canvasId, name))
    this.saveCanvasLater(c)
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
    requireBoundary('store.setTokens')
    /* renders naming one of these are stale (server/styleVersion.ts) */
    for (const input of inputs) bumpStyle(canvasId, tokenDependency(input.name))
    this.remember(c, ['tokens', 'updatedAt'], true)
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
      const saved = token
      afterCommit(() => persist.saveToken(canvasId, saved))
      written.push(token)
    }
    tokens.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    c.updatedAt = now
    this.saveCanvasLater(c)
    return written
  }

  /** Rename a token in place: its order and description ride along. */
  renameToken(canvasId: string, name: string, newName: string, by: string): DesignToken | undefined {
    const c = this.canvases.get(canvasId)
    const token = c?.tokens?.find((t) => t.name === name)
    if (!c || !token) return undefined
    requireBoundary('store.renameToken')
    bumpStyle(canvasId, tokenDependency(name))
    bumpStyle(canvasId, tokenDependency(newName))
    /* the whole list, as setTokens keeps it: an undo of a later setTokens in the same
       transaction puts back a copy of the list, which an undo of this token alone would miss */
    this.remember(c, ['tokens', 'updatedAt'], true)
    afterCommit(() => persist.deleteToken(canvasId, name))
    token.name = newName
    token.updatedAt = Date.now()
    token.updatedBy = by
    afterCommit(() => persist.saveToken(canvasId, token))
    c.updatedAt = token.updatedAt
    this.saveCanvasLater(c)
    return token
  }

  getTokenThemes(canvasId: string): string[] {
    return this.canvases.get(canvasId)?.tokenThemes ?? []
  }

  /** Replace the theme list; tokens drop the values of themes that left. */
  setTokenThemes(canvasId: string, themes: string[], by: string): string[] | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    requireBoundary('store.setTokenThemes')
    bumpStyle(canvasId, THEMES_DEPENDENCY)
    this.remember(c, ['tokens', 'tokenThemes', 'updatedAt'], true)
    c.tokenThemes = themes.length ? [...themes] : undefined
    const now = Date.now()
    for (const token of c.tokens ?? []) {
      if (!token.themes) continue
      const kept = Object.fromEntries(Object.entries(token.themes).filter(([theme]) => themes.includes(theme)))
      if (Object.keys(kept).length === Object.keys(token.themes).length) continue
      token.themes = Object.keys(kept).length ? kept : undefined
      token.updatedAt = now
      token.updatedBy = by
      afterCommit(() => persist.saveToken(canvasId, token))
    }
    c.updatedAt = now
    this.saveCanvasLater(c)
    return themes
  }

  /** Rename a theme: the list entry and every token's value under it. */
  renameTokenTheme(canvasId: string, from: string, to: string, by: string): boolean {
    const c = this.canvases.get(canvasId)
    if (!c || !c.tokenThemes?.includes(from)) return false
    requireBoundary('store.renameTokenTheme')
    bumpStyle(canvasId, THEMES_DEPENDENCY)
    this.remember(c, ['tokens', 'tokenThemes', 'updatedAt'], true)
    c.tokenThemes = c.tokenThemes.map((theme) => (theme === from ? to : theme))
    const now = Date.now()
    for (const token of c.tokens ?? []) {
      if (!token.themes || !(from in token.themes)) continue
      const { [from]: moved, ...rest } = token.themes
      token.themes = { ...rest, ...(moved === undefined ? {} : { [to]: moved }) }
      token.updatedAt = now
      token.updatedBy = by
      afterCommit(() => persist.saveToken(canvasId, token))
    }
    c.updatedAt = now
    this.saveCanvasLater(c)
    return true
  }

  deleteToken(canvasId: string, name: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.tokens?.findIndex((t) => t.name === name) ?? -1
    if (!c || idx === -1) return false
    requireBoundary('store.deleteToken')
    bumpStyle(canvasId, tokenDependency(name))
    this.remember(c, ['tokens', 'updatedAt'])
    c.tokens!.splice(idx, 1)
    c.updatedAt = Date.now()
    afterCommit(() => persist.deleteToken(canvasId, name))
    this.saveCanvasLater(c)
    return true
  }

  getReferences(canvasId: string): MemoryReference[] {
    return this.canvases.get(canvasId)?.references ?? []
  }

  /** Pin a frame to Memory: snapshot its document now, decoupled from the frame and from
   *  the canvas's tokens and components, so it is composed here (shared/frameCompose.ts). */
  addReference(canvasId: string, frame: Frame, by: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const ref: MemoryReference = {
      id: nanoid(10),
      frameId: frame.id,
      title: frame.name,
      html: composeFrameHtml(frame.html, {
        tokens: c.tokens ?? [],
        themes: c.tokenThemes ?? [],
        components: c.components ?? [],
      }),
      width: frame.width,
      height: frame.height,
      pinnedBy: by,
      pinnedAt: Date.now(),
    }
    requireBoundary('store.addReference')
    this.remember(c, ['references'])
    ;(c.references ??= []).unshift(ref)
    afterCommit(() => persist.saveReference(canvasId, ref))
    return ref
  }

  deleteReference(canvasId: string, id: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    const idx = c?.references?.findIndex((r) => r.id === id) ?? -1
    if (!c || idx === -1) return undefined
    requireBoundary('store.deleteReference')
    this.remember(c, ['references'])
    const [ref] = c.references!.splice(idx, 1)
    afterCommit(() => persist.deleteReference(id))
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
    requireBoundary('store.createFrame')
    c.frames.push(frame)
    c.frames.sort(byStack)
    this.frameIndex.set(frame.id, canvasId)
    recordUndo(() => {
      const at = c.frames.indexOf(frame)
      if (at !== -1) c.frames.splice(at, 1)
      if (this.frameIndex.get(frame.id) === canvasId) this.frameIndex.delete(frame.id)
    })
    this.touchCanvas(c, now)
    this.saveFrameLater(frame, true)
    this.saveCanvasLater(c)
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
    requireBoundary('store.updateFrame')
    const before = inTransaction() ? frameState(frame) : undefined
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
    // An annotation moves the version a step and leaves the author: nobody edited the design.
    frame.updatedAt = opts.annotation ? frame.updatedAt + 1 : Math.max(Date.now(), frame.updatedAt + 1)
    if (!opts.annotation) frame.updatedBy = by
    const stamp = frame.updatedAt
    const restacked = patch.z !== undefined
    if (before)
      recordUndo(({ yielded, repair }) => {
        /* written again since by someone else (this one awaited meanwhile), or gone: theirs stands */
        if (this.getFrame(frame.id) !== frame || frame.updatedAt !== stamp) return
        restoreFrame(frame, before)
        if (restacked) c.frames.sort(byStack)
        /* a write already on its debounce may have stored this frame while the operation
           awaited: the row goes back to what the frame is again, once every undo has run,
           and only if the frame is still there (one this transaction created is not) */
        if (yielded && before.loaded)
          repair(`frame:${frame.id}`, () => {
            if (this.getFrame(frame.id) === frame) persist.saveFrame(frame)
          })
      })
    /* an annotation changed nothing anyone sees: the canvas is no more recent for it */
    if (!opts.annotation) this.touchCanvas(c, stamp)
    this.saveFrameLater(frame) // debounced: streaming appends land as one write per burst
    this.saveCanvasLater(c)
    return frame
  }

  /** A loaded frame rendered again from the source it has: a component it uses changed its
   *  markup, and what the frame stores (a reference to that component) did not. Memory
   *  only: no row is written and `updatedAt` stays, since nothing a save could conflict
   *  with moved. `rendered` moves instead, so a browser can tell this rendering from an
   *  older one of the same version (src/lib/store.ts `upsertFrame`), and a cached image of
   *  the older one is retired (server/styleVersion.ts). */
  rerenderFrame(frameId: string, html: string): Frame | undefined {
    const frame = this.getFrame(frameId)
    if (!frame || !htmlLoaded(frame)) return undefined
    requireBoundary('store.rerenderFrame')
    const before = { html: frame.html, rendered: frame.rendered }
    const stamp = frame.updatedAt
    const mark = Math.max(Date.now(), (frame.rendered ?? 0) + 1)
    frame.html = html
    frame.rendered = mark
    recordUndo(() => {
      /* written or rendered again since, dropped from memory, or gone: that state stands */
      if (this.getFrame(frame.id) !== frame || !htmlLoaded(frame)) return
      if (frame.updatedAt !== stamp || frame.rendered !== mark) return
      frame.html = before.html
      if (before.rendered === undefined) delete frame.rendered
      else frame.rendered = before.rendered
    })
    return frame
  }

  deleteFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const idx = c.frames.findIndex((f) => f.id === frameId)
    if (idx === -1) return undefined
    requireBoundary('store.deleteFrame')
    const [frame] = c.frames.splice(idx, 1)
    this.frameIndex.delete(frameId)
    recordUndo(() => {
      if (!frame || this.canvases.get(canvasId) !== c || this.frameIndex.has(frameId)) return
      c.frames.push(frame)
      c.frames.sort(byStack)
      this.frameIndex.set(frameId, canvasId)
    })
    this.touchCanvas(c, Date.now())
    afterCommit(() => {
      if (!this.frameIndex.has(frameId)) persist.deleteFrame(frameId)
    })
    this.saveCanvasLater(c)
    return frame
  }
}

export const store = new Store()
