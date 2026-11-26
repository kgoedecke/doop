import { parseCardScope } from '../../shared/cardScope.ts'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { and, desc, eq, getTableColumns, inArray, lt, sql } from 'drizzle-orm'
import { db } from './index.ts'
import * as t from './schema.ts'
import { extractAssetIds } from '../assets.ts'
import { AGENT_ROLES, roleByAgentName } from '../../shared/agents.ts'
import { isCommunityCategory } from '../../shared/types.ts'
import { storedLinkAccess } from '../../shared/canvasRole.ts'
import { MAX_COMPONENT_HISTORY } from '../../shared/components.ts'
import type { ComponentDef, ComponentSnapshot, LibraryComponent } from '../../shared/components.ts'
import type { DesignToken, TokenType } from '../../shared/designTokens.ts'
import { parseRunnerPick } from '../../shared/agentRunner.ts'
import { byStack } from '../../shared/frameStack.ts'
import { unloadHtml } from '../frameHtml.ts'
import { definitionSerial, restingHtml } from '../frameRest.ts'
import { WorkBudgetError } from '../workBudget.ts'
import type {
  ActivityItem,
  ActorKind,
  AgentTask,
  Canvas,
  DesignDecision,
  ElementComment,
  Frame,
  FrameVersion,
  FrameVersionInfo,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  RepoCardKind,
  RepoCardPayload,
  TaskFeedback,
} from '../../shared/types.ts'

/**
 * Write-through persistence: the in-memory maps stay the source of truth and
 * the hot path; every committed mutation is mirrored here asynchronously.
 * Nothing on the live path (presence, cursors, reveal ticks) awaits the DB.
 */

function swallow(p: Promise<unknown>) {
  p.catch((err) => console.error('[db] write failed', err))
}

/* Frames at rest (server/frameRest.ts): the HTML of a frame's row, and of a version of it,
   holds each component instance as a reference, rendered from its component when the frame
   is read. What a frame is stored as depends on its canvas's components, which the store
   holds: the server hands them over (server/index.ts). Without that (a script, a test of
   this file alone) HTML is stored as given. */
let componentsOf: ((canvasId: string) => readonly ComponentDef[] | undefined) | undefined

/** Store frames at rest as references into these components: `components(canvasId)` is
 *  what the canvas has now, undefined for a canvas whose frames are stored as given (one
 *  on an actor, one the store does not hold). */
export function restFramesThrough(components: (canvasId: string) => readonly ComponentDef[] | undefined) {
  componentsOf = components
}

/* Definitions the database holds as they stand: what boot read, and every one whose write
   has landed. A reference is only as good as the row it renders from after a restart, so
   an instance of a definition not in here is stored written out. */
const storedDefs = new WeakSet<ComponentDef>()

const isStored = (def: ComponentDef) => storedDefs.has(def)

/* What a frame's HTML was last stored as, by a hash of that HTML and the state of its canvas's
   definitions: a write that changed no HTML (a move, a rename, a sign-off, a version of the
   same document) does not parse the frame again. */
const MAX_KEPT_RESTING = 300
const keptResting = new Map<string, string>()

function restingKey(
  canvasId: string,
  html: string,
  defs: readonly ComponentDef[],
  stored: (def: ComponentDef) => boolean,
) {
  const state = defs.map((def) => `${definitionSerial(def)}${stored(def) ? '' : '!'}`).join(',')
  return createHash('sha1').update(`${canvasId}\u0000${state}\u0000${html}`).digest('base64')
}

/** A frame's HTML as its row keeps it. Never fails a save: out of budget, or anything the
 *  engine trips over, the rendered HTML is stored, which is always a form a read accepts. */
function atRest(canvasId: string, html: string, defs = componentsOf?.(canvasId), stored = isStored): string {
  if (!defs || !html) return html
  try {
    const key = restingKey(canvasId, html, defs, stored)
    const kept = keptResting.get(key)
    if (kept !== undefined) return kept
    const resting = restingHtml(html, defs, { stored })
    keptResting.set(key, resting)
    if (keptResting.size > MAX_KEPT_RESTING) keptResting.delete(keptResting.keys().next().value ?? '')
    return resting
  } catch (error) {
    if (!(error instanceof WorkBudgetError)) console.error('[db] a frame could not be made compact', canvasId, error)
    return html
  }
}

/** every mutable canvas column, so insert and upsert can't drift apart */
function canvasColumns(c: Canvas) {
  return {
    name: c.name,
    pages: c.pages ?? null,
    guides: c.guides?.length ? c.guides : null,
    tokenThemes: c.tokenThemes?.length ? c.tokenThemes : null,
    ownerId: c.ownerId ?? null,
    linkAccess: storedLinkAccess(c.linkAccess) ?? null,
    publishedAt: c.publishedAt ?? null,
    description: c.description ?? null,
    category: c.category ?? null,
    copyCount: c.copyCount ?? 0,
    workspaceId: c.workspaceId ?? null,
    updatedAt: c.updatedAt,
  }
}

export function saveCanvas(c: Canvas) {
  swallow(
    db
      .insert(t.canvases)
      .values({ id: c.id, ...canvasColumns(c), createdAt: c.createdAt })
      .onConflictDoUpdate({ target: t.canvases.id, set: canvasColumns(c) }),
  )
}

/** Persist a newly duplicated canvas as one unit. Unlike ordinary live edits,
 * duplication must not report success until every copied row is durable. */
export async function saveCanvasCopy(c: Canvas): Promise<void> {
  /* a copy's frames are stored as they are in memory, written out: making every frame of a
     canvas compact in one turn is the whole-canvas work this server never does at once
     (2026-11-11). Each goes compact on its own first write; a read takes either form */
  await db.transaction(async (tx) => {
    await tx.insert(t.canvases).values({ id: c.id, ...canvasColumns(c), createdAt: c.createdAt })

    if (c.frames.length) {
      await tx.insert(t.frames).values(
        c.frames.map((frame) => ({
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
          hidden: frame.hidden ?? null,
          locked: frame.locked ?? null,
          z: frame.z ?? null,
          rotation: frame.rotation ?? null,
        })),
      )
    }

    if (c.guidelines?.length) {
      await tx.insert(t.guidelines).values(
        c.guidelines.map((doc) => ({
          canvasId: c.id,
          name: doc.name,
          markdown: doc.markdown,
          title: doc.title ?? null,
          updatedAt: doc.updatedAt,
          updatedBy: doc.updatedBy,
          x: doc.x ?? null,
          y: doc.y ?? null,
        })),
      )
    }

    if (c.components?.length) {
      await tx.insert(t.components).values(c.components.map((def) => componentRow(c.id, def)))
      const revisions = c.components.flatMap((def) => revisionRows(c.id, def.id, def.history))
      for (let at = 0; at < revisions.length; at += REVISION_INSERT_BATCH) {
        await tx
          .insert(t.componentRevisions)
          .values(revisions.slice(at, at + REVISION_INSERT_BATCH))
          .onConflictDoNothing()
      }
    }
    if (c.tokens?.length) {
      await tx.insert(t.designTokens).values(c.tokens.map((token) => tokenRow(c.id, token)))
    }

    if (c.references?.length) {
      await tx.insert(t.memoryReferences).values(
        c.references.map((ref) => ({
          id: ref.id,
          canvasId: c.id,
          frameId: ref.frameId,
          title: ref.title,
          html: ref.html,
          width: ref.width,
          height: ref.height,
          pinnedBy: ref.pinnedBy,
          pinnedAt: ref.pinnedAt,
        })),
      )
    }

    const refs = c.frames.flatMap((frame) =>
      [...extractAssetIds(frame.html)].map((assetId) => ({ assetId, frameId: frame.id })),
    )
    if (refs.length) await tx.insert(t.assetRefs).values(refs)
  })
  for (const def of c.components ?? []) {
    noteRevisionsFiled(c.id, def.id, def.history)
    storedDefs.add(def)
  }
}

export function saveMember(canvasId: string, userId: string, addedBy: string, addedAt: number) {
  swallow(db.insert(t.canvasMembers).values({ canvasId, userId, addedBy, addedAt }).onConflictDoNothing())
}

export function deleteMember(canvasId: string, userId: string) {
  swallow(
    db.delete(t.canvasMembers).where(and(eq(t.canvasMembers.canvasId, canvasId), eq(t.canvasMembers.userId, userId))),
  )
}

function componentRow(canvasId: string, def: ComponentDef) {
  return {
    canvasId,
    id: def.id,
    name: def.name,
    description: def.description,
    template: def.template,
    css: def.css,
    rawCss: def.rawCss,
    head: def.head,
    props: def.props,
    slots: def.slots,
    rev: def.rev,
    renderRev: def.renderRev ?? null,
    mainFrameId: def.mainFrameId,
    code: def.code ?? null,
    source: def.source ?? null,
    status: def.status ?? ('active' as const),
    deletedAt: def.deletedAt ?? null,
    deletedBy: def.deletedBy ?? null,
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
    updatedBy: def.updatedBy,
  }
}

/*
 * Writes to one component row go one at a time, and only the latest state waits: a create
 * saves a blank definition and then the filled one, and on a pooled connection two
 * fire-and-forget upserts land in either order. The blank one landing last left a hollow
 * row that the next boot loaded as the component (2026-11-11: 236 definitions, 7%). A write
 * that fails is retried while nothing newer waits, and logged when it gives up.
 */
interface RowQueue {
  next: (() => Promise<unknown>) | undefined
  drained: Promise<void>
}

const componentWrites = new Map<string, RowQueue>()

/** How long to wait before each retry of a failed component write. */
export const COMPONENT_WRITE_RETRIES_MS = [500, 5_000, 30_000]

/* a retry waiting out its delay: shutdown cuts the wait short, so the write gets its last try */
const retryWaits = new Set<() => void>()
let draining = false

const pause = (ms: number) =>
  draining
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          retryWaits.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, ms)
        retryWaits.add(wake)
      })

function queueComponentWrite(canvasId: string, id: string, write: () => Promise<unknown>) {
  const key = `${canvasId}\0${id}`
  const queued = componentWrites.get(key)
  if (queued) {
    queued.next = write
    return
  }
  const queue: RowQueue = { next: write, drained: Promise.resolve() }
  componentWrites.set(key, queue)
  queue.drained = drainComponentWrites(key, queue)
}

async function drainComponentWrites(key: string, queue: RowQueue) {
  try {
    for (let write = queue.next; write; write = queue.next) {
      queue.next = undefined
      await writeWithRetries(key, write, queue)
    }
  } finally {
    componentWrites.delete(key)
  }
}

async function writeWithRetries(key: string, write: () => Promise<unknown>, queue: RowQueue) {
  for (let attempt = 0; ; attempt++) {
    try {
      await write()
      return
    } catch (error) {
      /* a newer state is waiting: it replaces this one, so this one need not land */
      if (queue.next) return
      const wait = COMPONENT_WRITE_RETRIES_MS[attempt]
      if (wait === undefined) {
        console.error(`[db] component write failed for good: ${key.replace('\0', '/')}`, error)
        return
      }
      console.error(`[db] component write failed, retrying in ${wait}ms: ${key.replace('\0', '/')}`, error)
      await pause(wait)
      if (queue.next) return
    }
  }
}

/** Every queued component write, settled: what a canvas delete waits for (so a queued save
 *  cannot put a row back afterwards), and what a test awaits. */
export function pendingComponentWrites(canvasId?: string): Promise<unknown> {
  const prefix = canvasId === undefined ? '' : `${canvasId}\0`
  return Promise.allSettled(
    [...componentWrites].filter(([key]) => key.startsWith(prefix)).map(([, queue]) => queue.drained),
  )
}

/*
 * A component's earlier revisions are rows of component_revisions, written once each: a
 * save sends the small `components` row and only the revisions not yet filed, where the
 * row used to carry all twenty and was rewritten whole on every change (2026-11: 1 GB of
 * table for 135 MB of content). `revisionsFiled` is the newest revision of each component
 * known to be a row (what boot loaded, then every write that landed); the inserts are
 * ON CONFLICT DO NOTHING besides, so a revision is never written over.
 */
const revisionsFiled = new Map<string, number>()

/** most revision rows in one insert: nine parameters each, well under the protocol's 65,535 */
const REVISION_INSERT_BATCH = 500

const componentKey = (canvasId: string, id: string) => `${canvasId}\0${id}`

function revisionRows(canvasId: string, componentId: string, history: readonly ComponentSnapshot[]) {
  return history.map((entry) => ({
    canvasId,
    componentId,
    rev: entry.rev,
    renderRev: entry.renderRev ?? null,
    template: entry.template,
    rawCss: entry.rawCss,
    head: entry.head,
    props: entry.props,
    savedAt: entry.savedAt,
    savedBy: entry.savedBy,
  }))
}

function noteRevisionsFiled(canvasId: string, id: string, history: readonly ComponentSnapshot[]) {
  const newest = history.at(-1)
  if (newest) revisionsFiled.set(componentKey(canvasId, id), newest.rev)
  else revisionsFiled.delete(componentKey(canvasId, id))
}

const ofComponent = (canvasId: string, id: string) =>
  and(eq(t.componentRevisions.canvasId, canvasId), eq(t.componentRevisions.componentId, id))

export function saveComponent(canvasId: string, def: ComponentDef) {
  const row = componentRow(canvasId, def)
  const { canvasId: _canvasId, id: _id, createdAt: _createdAt, ...set } = row
  const { history } = def
  const key = componentKey(canvasId, def.id)
  /* inside the row's queue, so revisions are filed in the order their saves were made */
  queueComponentWrite(canvasId, def.id, async () => {
    const filed = revisionsFiled.get(key)
    /* at or behind a revision already filed: this is not the definition those rows were
       kept for (one made again under its id), so they go rather than answer for it */
    const restarted = filed !== undefined && def.rev <= filed
    const added = restarted || filed === undefined ? history : history.filter((entry) => entry.rev > filed)
    const upsert = (on: Pick<typeof db, 'insert'>) =>
      on
        .insert(t.components)
        .values(row)
        .onConflictDoUpdate({ target: [t.components.canvasId, t.components.id], set })
    if (!added.length && !restarted) {
      await upsert(db)
      storedDefs.add(def)
      return
    }
    await db.transaction(async (tx) => {
      await upsert(tx)
      if (restarted) await tx.delete(t.componentRevisions).where(ofComponent(canvasId, def.id))
      if (!added.length) return
      await tx
        .insert(t.componentRevisions)
        .values(revisionRows(canvasId, def.id, added))
        .onConflictDoNothing()
      /* memory keeps the newest MAX_COMPONENT_HISTORY: the table keeps the same ones */
      const oldest = history[0]!.rev
      await tx
        .delete(t.componentRevisions)
        .where(and(ofComponent(canvasId, def.id), lt(t.componentRevisions.rev, oldest)))
    })
    noteRevisionsFiled(canvasId, def.id, history)
    storedDefs.add(def)
  })
}

export function deleteComponent(canvasId: string, id: string) {
  queueComponentWrite(canvasId, id, async () => {
    await db.transaction(async (tx) => {
      await tx.delete(t.components).where(and(eq(t.components.canvasId, canvasId), eq(t.components.id, id)))
      await tx.delete(t.componentRevisions).where(ofComponent(canvasId, id))
    })
    revisionsFiled.delete(componentKey(canvasId, id))
  })
}

export function saveLibraryComponent(snapshot: LibraryComponent) {
  const row = { ...snapshot, code: snapshot.code ?? null, nested: snapshot.nested ?? null }
  const { canvasId: _canvasId, id: _id, ...set } = row
  swallow(
    db
      .insert(t.libraryComponents)
      .values(row)
      .onConflictDoUpdate({ target: [t.libraryComponents.canvasId, t.libraryComponents.id], set }),
  )
}

export function deleteLibraryComponent(canvasId: string, id: string) {
  swallow(
    db
      .delete(t.libraryComponents)
      .where(and(eq(t.libraryComponents.canvasId, canvasId), eq(t.libraryComponents.id, id))),
  )
}

export async function loadLibraryComponents(): Promise<LibraryComponent[]> {
  const rows = await db.select().from(t.libraryComponents).orderBy(t.libraryComponents.name)
  return rows.map(({ code, nested, ...row }) => ({ ...row, ...(code ? { code } : {}), ...(nested ? { nested } : {}) }))
}

export function saveGuideline(canvasId: string, doc: GuidelineDoc) {
  const row = {
    canvasId,
    name: doc.name,
    markdown: doc.markdown,
    title: doc.title ?? null,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    x: doc.x ?? null,
    y: doc.y ?? null,
  }
  swallow(
    db
      .insert(t.guidelines)
      .values(row)
      .onConflictDoUpdate({
        target: [t.guidelines.canvasId, t.guidelines.name],
        set: {
          markdown: row.markdown,
          title: row.title,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
          x: row.x,
          y: row.y,
        },
      }),
  )
}

export function deleteGuideline(canvasId: string, name: string) {
  swallow(db.delete(t.guidelines).where(and(eq(t.guidelines.canvasId, canvasId), eq(t.guidelines.name, name))))
}

function tokenRow(canvasId: string, token: DesignToken) {
  return {
    canvasId,
    name: token.name,
    type: token.type,
    value: token.value,
    themes: token.themes && Object.keys(token.themes).length ? token.themes : null,
    description: token.description ?? null,
    order: token.order,
    updatedAt: token.updatedAt,
    updatedBy: token.updatedBy,
  }
}

/* Writes to one token run in order: a rename followed by an edit of the
   same row must not let the earlier write land last on a pooled connection. */
const tokenWrites = new Map<string, Promise<unknown>>()

function queueTokenWrite(canvasId: string, name: string, write: () => Promise<unknown>) {
  const key = `${canvasId}\0${name}`
  const prior = tokenWrites.get(key) ?? Promise.resolve()
  const next = prior.then(write, write)
  tokenWrites.set(key, next)
  swallow(next.finally(() => tokenWrites.get(key) === next && tokenWrites.delete(key)))
}

/** Every queued token write of a canvas, settled: what a canvas delete waits
 *  for, so a save still in the queue cannot put a row back afterwards. */
function pendingTokenWrites(canvasId: string): Promise<unknown> {
  const prefix = `${canvasId}\0`
  return Promise.allSettled([...tokenWrites].filter(([key]) => key.startsWith(prefix)).map(([, write]) => write))
}

export function saveToken(canvasId: string, token: DesignToken) {
  const row = tokenRow(canvasId, token)
  queueTokenWrite(canvasId, token.name, () =>
    db
      .insert(t.designTokens)
      .values(row)
      .onConflictDoUpdate({
        target: [t.designTokens.canvasId, t.designTokens.name],
        set: {
          type: row.type,
          value: row.value,
          themes: row.themes,
          description: row.description,
          order: row.order,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        },
      }),
  )
}

export function deleteToken(canvasId: string, name: string) {
  queueTokenWrite(canvasId, name, () =>
    db.delete(t.designTokens).where(and(eq(t.designTokens.canvasId, canvasId), eq(t.designTokens.name, name))),
  )
}

/* Append-only doc history: a snapshot per save, '' marks a deletion. */
const MAX_GUIDELINE_VERSIONS = 50

export function saveGuidelineVersion(canvasId: string, name: string, markdown: string, by: string, at: number) {
  swallow(appendGuidelineVersion(canvasId, name, markdown, by, at))
}

async function appendGuidelineVersion(canvasId: string, name: string, markdown: string, by: string, at: number) {
  await db.insert(t.guidelineVersions).values({ id: nanoid(10), canvasId, name, markdown, savedAt: at, savedBy: by })
  const excess = await db
    .select({ id: t.guidelineVersions.id })
    .from(t.guidelineVersions)
    .where(and(eq(t.guidelineVersions.canvasId, canvasId), eq(t.guidelineVersions.name, name)))
    .orderBy(desc(t.guidelineVersions.savedAt))
    .offset(MAX_GUIDELINE_VERSIONS)
  if (excess.length) {
    await db.delete(t.guidelineVersions).where(
      inArray(
        t.guidelineVersions.id,
        excess.map((e) => e.id),
      ),
    )
  }
}

/** Newest first. Cold path — read straight from the database on demand. */
export function listGuidelineVersions(canvasId: string, name: string) {
  return db
    .select()
    .from(t.guidelineVersions)
    .where(and(eq(t.guidelineVersions.canvasId, canvasId), eq(t.guidelineVersions.name, name)))
    .orderBy(desc(t.guidelineVersions.savedAt))
}

/* Design memory: single-shot writes, like guidelines. */
export function saveReference(canvasId: string, ref: MemoryReference) {
  swallow(
    db
      .insert(t.memoryReferences)
      .values({
        id: ref.id,
        canvasId,
        frameId: ref.frameId,
        title: ref.title,
        html: ref.html,
        width: ref.width,
        height: ref.height,
        pinnedBy: ref.pinnedBy,
        pinnedAt: ref.pinnedAt,
      })
      .onConflictDoNothing(),
  )
}

export function deleteReference(id: string) {
  swallow(db.delete(t.memoryReferences).where(eq(t.memoryReferences.id, id)))
}

export function saveDecision(canvasId: string, d: DesignDecision) {
  const row = {
    id: d.id,
    canvasId,
    text: d.text,
    summary: d.summary ?? null,
    source: d.source,
    frameId: d.frameId ?? null,
    fromName: d.from,
    agentName: d.agentName ?? null,
    at: d.at,
    distilledAt: d.distilledAt ?? null,
  }
  swallow(
    db
      .insert(t.decisions)
      .values(row)
      .onConflictDoUpdate({ target: t.decisions.id, set: { summary: row.summary, distilledAt: row.distilledAt } }),
  )
}

export function saveProposal(canvasId: string, p: MemoryProposal) {
  const row = {
    id: p.id,
    canvasId,
    guideName: p.guideName,
    guideTitle: p.guideTitle ?? null,
    rule: p.rule,
    rationale: p.rationale,
    basedOn: p.basedOn.join(','),
    at: p.at,
    status: p.status,
    resolvedBy: p.resolvedBy ?? null,
    resolvedAt: p.resolvedAt ?? null,
  }
  swallow(
    db
      .insert(t.memoryProposals)
      .values(row)
      .onConflictDoUpdate({
        target: t.memoryProposals.id,
        set: { status: row.status, resolvedBy: row.resolvedBy, resolvedAt: row.resolvedAt },
      }),
  )
}

/* Streaming appends update a frame's html on every chunk — debounce per frame
   so the DB sees one row write per burst, not one per keystroke of the reveal. */
const frameTimers = new Map<string, NodeJS.Timeout>()
const FRAME_DEBOUNCE_MS = 400

/** Persist a duplicated page as one unit: the canvas's new page list and
 * every copied frame land together or not at all, so a copy is never half
 * there after a crash. Like saveCanvasCopy, success means durable. */
export async function savePageCopy(c: Canvas, frames: Frame[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(t.canvases).set(canvasColumns(c)).where(eq(t.canvases.id, c.id))
    if (!frames.length) return
    await tx.insert(t.frames).values(
      frames.map((frame) => ({
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
        hidden: frame.hidden ?? null,
        locked: frame.locked ?? null,
        z: frame.z ?? null,
        rotation: frame.rotation ?? null,
      })),
    )
    const refs = frames.flatMap((frame) =>
      [...extractAssetIds(frame.html)].map((assetId) => ({ assetId, frameId: frame.id })),
    )
    if (refs.length) await tx.insert(t.assetRefs).values(refs)
  })
}

/** Write the frame now and resolve once it is on disk, for a caller that
 *  must write something naming the frame's content afterwards. */
/* Frames whose latest state is not yet in the database, by write
   generation: marked on every save, cleared only once a write that started
   at the latest generation succeeds. A frame stays dirty through its
   debounce, its write in flight and a failed write, and a dirty frame keeps
   its canvas loaded (store.evictIdle) — dropping it would lose the only
   copy, or reload the stored row over a newer one still being written. */
const dirtyFrames = new Map<string, number>()

/** writes of a frame on their way to the database, counted */
const writesInFlight = new Map<string, number>()

function markDirty(frameId: string) {
  dirtyFrames.set(frameId, (dirtyFrames.get(frameId) ?? 0) + 1)
}

export async function saveFrameNow(f: Frame): Promise<void> {
  markDirty(f.id)
  const existing = frameTimers.get(f.id)
  if (existing) clearTimeout(existing)
  frameTimers.delete(f.id)
  await writeFrame(f)
}

export function saveFrame(f: Frame, immediate = false) {
  markDirty(f.id)
  const existing = frameTimers.get(f.id)
  if (existing) clearTimeout(existing)
  if (immediate) {
    frameTimers.delete(f.id)
    swallow(writeFrame(f))
    return
  }
  frameTimers.set(
    f.id,
    setTimeout(() => {
      frameTimers.delete(f.id)
      swallow(writeFrame(f)) // f is mutated in place by the store, so the ref holds the latest state
    }, FRAME_DEBOUNCE_MS),
  )
}

async function writeFrame(f: Frame) {
  writesInFlight.set(f.id, (writesInFlight.get(f.id) ?? 0) + 1)
  try {
    await writeFrameRow(f)
  } finally {
    const left = (writesInFlight.get(f.id) ?? 1) - 1
    if (left > 0) writesInFlight.set(f.id, left)
    else writesInFlight.delete(f.id)
  }
}

async function writeFrameRow(f: Frame) {
  /* a reference needs its definition's row: the canvas's queued component writes go first,
     and the frame is read once they have landed, as it stands then */
  if (componentsOf?.(f.canvasId)?.length) {
    const wasDirty = dirtyFrames.has(f.id)
    await pendingComponentWrites(f.canvasId)
    /* deleted while this waited (its frame, or its whole canvas): the row must not come back */
    if ((wasDirty && !dirtyFrames.has(f.id)) || !componentsOf(f.canvasId)) return
  }
  const generation = dirtyFrames.get(f.id)
  const html = f.html
  const row = { ...frameRowOf(f), html: atRest(f.canvasId, html) }
  const { id, createdAt, ...set } = row
  await db.insert(t.frames).values(row).onConflictDoUpdate({ target: t.frames.id, set })
  /* a save made while this one was in flight keeps the frame dirty */
  if (dirtyFrames.get(f.id) === generation) dirtyFrames.delete(f.id)
  await syncAssetRefs(f, html)
}

function frameRowOf(f: Frame) {
  return {
    id: f.id,
    canvasId: f.canvasId,
    pageId: f.pageId ?? null,
    name: f.name,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    html: f.html,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    updatedBy: f.updatedBy,
    demo: f.demo ?? null,
    hidden: f.hidden ?? null,
    locked: f.locked ?? null,
    z: f.z ?? null,
    rotation: f.rotation ?? null,
    approval: f.approval ?? null,
  }
}

/** A frame whose latest state is not yet stored: waiting on its debounce,
 *  its write in flight, or its write failed. Its canvas must stay loaded. */
export function frameWritePending(frameId: string): boolean {
  return dirtyFrames.has(frameId)
}

/** Write again a dirty frame with nothing scheduled or in flight: one whose
 *  write failed. The idle sweep calls this for the frames that keep their
 *  canvas from being dropped. */
export function retryFrameWrite(f: Frame) {
  if (dirtyFrames.has(f.id) && !frameTimers.has(f.id) && !writesInFlight.has(f.id)) saveFrame(f)
}

/** Move a frame to another page without touching its html, for a frame
 *  whose canvas is not loaded (store.init's repair of an orphaned frame). */
export function saveFramePage(frameId: string, pageId: string) {
  swallow(writeFramePage(frameId, pageId))
}

async function writeFramePage(frameId: string, pageId: string) {
  await db.update(t.frames).set({ pageId }).where(eq(t.frames.id, frameId))
}

/** ids per query when frame html is read by id */
const HTML_READ_BATCH = 200

/** The html of these frames, for store.loadPages; a frame with no row is left out. */
export async function loadFrameHtml(frameIds: readonly string[]): Promise<Map<string, string>> {
  const html = new Map<string, string>()
  for (let at = 0; at < frameIds.length; at += HTML_READ_BATCH) {
    const ids = frameIds.slice(at, at + HTML_READ_BATCH)
    const rows = await db
      .select({ id: t.frames.id, html: t.frames.html })
      .from(t.frames)
      .where(inArray(t.frames.id, ids))
    for (const row of rows) html.set(row.id, row.html)
  }
  return html
}

/** One frame's html, for a render of a frame whose canvas is not loaded. */
export async function loadOneFrameHtml(frameId: string): Promise<string | undefined> {
  const [row] = await db.select({ html: t.frames.html }).from(t.frames).where(eq(t.frames.id, frameId))
  return row?.html
}

const frameMetaColumns = {
  id: t.frames.id,
  canvasId: t.frames.canvasId,
  pageId: t.frames.pageId,
  name: t.frames.name,
  x: t.frames.x,
  y: t.frames.y,
  width: t.frames.width,
  height: t.frames.height,
  createdAt: t.frames.createdAt,
  updatedAt: t.frames.updatedAt,
  updatedBy: t.frames.updatedBy,
  demo: t.frames.demo,
  hidden: t.frames.hidden,
  locked: t.frames.locked,
  z: t.frames.z,
  rotation: t.frames.rotation,
  approval: t.frames.approval,
}

/* Frame design history: one row per burst boundary (see actions.ts), newest
   kept to MAX_FRAME_VERSIONS per frame. Appends are fire-and-forget like every
   other write; reads happen only when someone opens the history. */
const MAX_FRAME_VERSIONS = 50

/* A version write reads the newest row before it inserts, so a frame's
   deletion must queue behind its pending writes (and they behind each
   other), or a late insert could put back history the delete just removed.
   One queue per frame; deleteCanvas waits for every frame of the canvas. */
const versionWrites = new Map<string, { canvasId: string; queued: Promise<unknown> }>()

function queueVersionWrite(frameId: string, canvasId: string, work: () => Promise<unknown>) {
  const previous = versionWrites.get(frameId)?.queued ?? Promise.resolve()
  const queued = previous.then(work, work)
  versionWrites.set(frameId, { canvasId, queued })
  swallow(queued.finally(() => versionWrites.get(frameId)?.queued === queued && versionWrites.delete(frameId)))
}

/** A version is stored like a frame's row: its instances as references, made when its turn
 *  to be written comes, once the canvas's queued component writes have landed (a reference
 *  needs its definition's row). A preview or a restore renders them from the components as
 *  they are then. */
export function saveFrameVersion(version: FrameVersion) {
  queueVersionWrite(version.frameId, version.canvasId, async () => {
    if (componentsOf?.(version.canvasId)?.length) await pendingComponentWrites(version.canvasId)
    await appendFrameVersion({ ...version, html: atRest(version.canvasId, version.html) })
  })
}

/** Settles once every queued version write the filter picks has landed. */
function pendingVersionWrites(pick: (frameId: string, canvasId: string) => boolean) {
  const queued = [...versionWrites].filter(([frameId, e]) => pick(frameId, e.canvasId)).map(([, e]) => e.queued)
  return Promise.allSettled(queued)
}

async function appendFrameVersion(version: FrameVersion) {
  /* a burst that ended where it began (an edit typed and reverted) would
     snapshot the same state twice — the newest row already holds it. Size
     counts: the same document at another frame size is a state of its own */
  const [latest] = await db
    .select({ html: t.frameVersions.html, width: t.frameVersions.width, height: t.frameVersions.height })
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, version.frameId))
    .orderBy(desc(t.frameVersions.savedAt))
    .limit(1)
  if (latest && latest.html === version.html && latest.width === version.width && latest.height === version.height)
    return
  await db.insert(t.frameVersions).values({
    id: version.id,
    frameId: version.frameId,
    canvasId: version.canvasId,
    html: version.html,
    width: version.width,
    height: version.height,
    savedAt: version.savedAt,
    savedBy: version.savedBy,
    savedByKind: version.savedByKind ?? null,
  })
  const excess = await db
    .select({ id: t.frameVersions.id })
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, version.frameId))
    .orderBy(desc(t.frameVersions.savedAt))
    .offset(MAX_FRAME_VERSIONS)
  if (excess.length) {
    await db.delete(t.frameVersions).where(
      inArray(
        t.frameVersions.id,
        excess.map((e) => e.id),
      ),
    )
  }
}

function frameVersionKind(kind: string | null): ActorKind | undefined {
  return kind === 'user' || kind === 'agent' ? kind : undefined
}

/** Newest first, without the HTML — the list stays light however large the
 *  designs are; `getFrameVersion` fetches one in full. */
export async function listFrameVersions(frameId: string): Promise<FrameVersionInfo[]> {
  /* a replace files its version behind the response; the list that follows
     it must show it */
  await pendingVersionWrites((id) => id === frameId)
  const rows = await db
    .select({
      id: t.frameVersions.id,
      frameId: t.frameVersions.frameId,
      canvasId: t.frameVersions.canvasId,
      width: t.frameVersions.width,
      height: t.frameVersions.height,
      savedAt: t.frameVersions.savedAt,
      savedBy: t.frameVersions.savedBy,
      savedByKind: t.frameVersions.savedByKind,
      htmlBytes: sql<number>`length(${t.frameVersions.html})`,
    })
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, frameId))
    .orderBy(desc(t.frameVersions.savedAt))
  return rows.map((row) => ({
    id: row.id,
    frameId: row.frameId,
    canvasId: row.canvasId,
    width: row.width,
    height: row.height,
    savedAt: row.savedAt,
    savedBy: row.savedBy,
    savedByKind: frameVersionKind(row.savedByKind),
    htmlBytes: Number(row.htmlBytes),
  }))
}

/** One version in full; undefined when the id is unknown OR belongs to
 *  another frame, so a caller can never read across frames by id alone. */
export async function getFrameVersion(frameId: string, versionId: string): Promise<FrameVersion | undefined> {
  const [row] = await db
    .select()
    .from(t.frameVersions)
    .where(and(eq(t.frameVersions.id, versionId), eq(t.frameVersions.frameId, frameId)))
    .limit(1)
  if (!row) return undefined
  return {
    id: row.id,
    frameId: row.frameId,
    canvasId: row.canvasId,
    width: row.width,
    height: row.height,
    savedAt: row.savedAt,
    savedBy: row.savedBy,
    savedByKind: frameVersionKind(row.savedByKind),
    htmlBytes: row.html.length,
    html: row.html,
  }
}

/* A frame's stored HTML is its source: an asset only a component's stylesheet names (a
   background image) is in what the canvas composes into the frame, not in the row. The
   server hands over that view (server/index.ts, `composedHtml`); without one, the HTML as
   stored is read. */
let assetView: (canvasId: string, html: string) => string = (_canvasId, html) => html

export function viewAssetsThrough(view: (canvasId: string, html: string) => string) {
  assetView = view
}

/* asset_refs is a projection of the frame as it renders: recompute this frame's full ref
   set on every durable write (never increment/decrement — nothing to drift). A change to
   a component's stylesheet writes no frame, so an asset it starts to name joins a frame's
   refs with that frame's own next write. */
/** A frame rendered again in memory with no write of it (a component it uses changed its
 *  markup, store.rerenderFrame): the assets it shows may have changed with the component. */
export function refreshAssetRefs(frame: Frame) {
  swallow(syncAssetRefs(frame, frame.html))
}

async function syncAssetRefs(frame: Pick<Frame, 'id' | 'canvasId'>, html: string) {
  const frameId = frame.id
  const ids = [...extractAssetIds(assetView(frame.canvasId, html))]
  await db.delete(t.assetRefs).where(eq(t.assetRefs.frameId, frameId))
  if (ids.length) {
    await db
      .insert(t.assetRefs)
      .values(ids.map((assetId) => ({ assetId, frameId })))
      .onConflictDoNothing()
  }
}

export function deleteCanvas(canvasId: string) {
  /* refs must go before the frames rows the subquery reads */
  swallow(
    db
      .delete(t.assetRefs)
      .where(
        inArray(
          t.assetRefs.frameId,
          db.select({ id: t.frames.id }).from(t.frames).where(eq(t.frames.canvasId, canvasId)),
        ),
      )
      .then(() => db.delete(t.frames).where(eq(t.frames.canvasId, canvasId))),
  )
  /* a queued task or feedback write (a run's reply, then its completion)
     would otherwise re-insert its row after the delete */
  swallow(pendingRowWrites(taskWrites, canvasId).then(() => db.delete(t.tasks).where(eq(t.tasks.canvasId, canvasId))))
  swallow(
    pendingRowWrites(feedbackWrites, canvasId).then(() =>
      db.delete(t.feedback).where(eq(t.feedback.canvasId, canvasId)),
    ),
  )
  swallow(db.delete(t.comments).where(eq(t.comments.canvasId, canvasId)))
  swallow(db.delete(t.activity).where(eq(t.activity.canvasId, canvasId)))
  swallow(db.delete(t.guidelines).where(eq(t.guidelines.canvasId, canvasId)))
  swallow(
    pendingComponentWrites(canvasId).then(async () => {
      await db.delete(t.components).where(eq(t.components.canvasId, canvasId))
      await db.delete(t.componentRevisions).where(eq(t.componentRevisions.canvasId, canvasId))
      const prefix = componentKey(canvasId, '')
      for (const key of revisionsFiled.keys()) if (key.startsWith(prefix)) revisionsFiled.delete(key)
    }),
  )
  swallow(db.delete(t.storybookSources).where(eq(t.storybookSources.canvasId, canvasId)))
  swallow(db.delete(t.libraryComponents).where(eq(t.libraryComponents.canvasId, canvasId)))
  swallow(db.delete(t.guidelineVersions).where(eq(t.guidelineVersions.canvasId, canvasId)))
  swallow(
    pendingTokenWrites(canvasId).then(() => db.delete(t.designTokens).where(eq(t.designTokens.canvasId, canvasId))),
  )
  swallow(
    pendingVersionWrites((_, c) => c === canvasId).then(() =>
      db.delete(t.frameVersions).where(eq(t.frameVersions.canvasId, canvasId)),
    ),
  )
  swallow(db.delete(t.memoryReferences).where(eq(t.memoryReferences.canvasId, canvasId)))
  swallow(db.delete(t.decisions).where(eq(t.decisions.canvasId, canvasId)))
  swallow(db.delete(t.memoryProposals).where(eq(t.memoryProposals.canvasId, canvasId)))
  swallow(db.delete(t.canvasMembers).where(eq(t.canvasMembers.canvasId, canvasId)))
  swallow(db.delete(t.canvases).where(eq(t.canvases.id, canvasId)))
}

export function deleteFrame(frameId: string) {
  dirtyFrames.delete(frameId)
  const timer = frameTimers.get(frameId)
  if (timer) {
    clearTimeout(timer)
    frameTimers.delete(frameId)
  }
  swallow(db.delete(t.frames).where(eq(t.frames.id, frameId)))
  swallow(db.delete(t.assetRefs).where(eq(t.assetRefs.frameId, frameId)))
  queueVersionWrite(frameId, versionWrites.get(frameId)?.canvasId ?? '', () =>
    db.delete(t.frameVersions).where(eq(t.frameVersions.frameId, frameId)),
  )
}

/** The frame/element a prompt card was scoped to, or nothing when the row
 *  carries none or it no longer parses. */
function scopeField(scope: string | null): Pick<AgentTask, 'scope'> {
  if (!scope) return {}
  try {
    const parsed = parseCardScope(JSON.parse(scope))
    return parsed ? { scope: parsed } : {}
  } catch {
    return {}
  }
}

/** The connection a card was sent to, or nothing when the row carries none
 *  or it no longer parses (the card then runs on the Settings default). */
function runnerField(runner: string | null): Pick<AgentTask, 'runner'> {
  if (!runner) return {}
  try {
    const parsed = parseRunnerPick(JSON.parse(runner))
    return parsed ? { runner: parsed } : {}
  } catch {
    return {}
  }
}

/** A structured card's kind + payload, or nothing when the row is a prompt
 *  card or its payload no longer parses (the card then reads as a plain one). */
function repoCardFields(kind: string | null, payload: string | null): Pick<AgentTask, 'kind' | 'payload'> {
  if (!kind || !payload) return {}
  try {
    return { kind: kind as RepoCardKind, payload: JSON.parse(payload) as RepoCardPayload }
  } catch {
    return {}
  }
}

/* Task rows are written as whole snapshots and never awaited by callers, so
   two quick edits could otherwise race on the pool and leave the older one
   in the table. Writes to the same task queue behind each other instead. */
/* queued writes per row id, with the canvas each belongs to, so deleting a
   canvas can wait for its rows' writes instead of having one land after */
interface QueuedWrite {
  canvasId: string
  write: Promise<unknown>
}

/** Chain `write` after the row's earlier writes, in order. */
function queueRowWrite(queue: Map<string, QueuedWrite>, id: string, canvasId: string, write: () => Promise<unknown>) {
  const queued = (queue.get(id)?.write ?? Promise.resolve()).then(write, write)
  queue.set(id, { canvasId, write: queued })
  swallow(queued.finally(() => queue.get(id)?.write === queued && queue.delete(id)))
}

/** Settles once every write queued so far for this canvas's rows has. */
function pendingRowWrites(queue: Map<string, QueuedWrite>, canvasId: string): Promise<unknown> {
  return Promise.allSettled([...queue.values()].filter((q) => q.canvasId === canvasId).map((q) => q.write))
}

const taskWrites = new Map<string, QueuedWrite>()

export function saveTask(canvasId: string, task: AgentTask) {
  const row = {
    id: task.id,
    canvasId,
    agentName: task.agentName,
    agentKey: task.agentKey ?? null,
    owner: task.owner ?? null,
    color: task.color,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt ?? null,
    auto: task.auto ?? false,
    queuedBy: task.queuedBy ?? null,
    queuedByUserId: task.queuedByUserId ?? null,
    claimedAt: task.claimedAt ?? null,
    failedAt: task.failedAt ?? null,
    failureReason: task.failureReason ?? null,
    pipeline: task.pipeline?.join(',') ?? null,
    stage: task.stage ?? null,
    attachments: task.attachments?.join(',') ?? null,
    kind: task.kind ?? null,
    payload: task.payload ? JSON.stringify(task.payload) : null,
    scope: task.scope ? JSON.stringify(task.scope) : null,
    frameIds: task.frameIds?.join(',') ?? null,
    runner: task.runner ? JSON.stringify(task.runner) : null,
    reply: task.reply ?? null,
  }
  const write = () =>
    db
      .insert(t.tasks)
      .values(row)
      .onConflictDoUpdate({
        target: t.tasks.id,
        set: {
          endedAt: row.endedAt,
          status: row.status,
          agentName: row.agentName,
          agentKey: row.agentKey,
          color: row.color,
          claimedAt: row.claimedAt,
          failedAt: row.failedAt,
          failureReason: row.failureReason,
          pipeline: row.pipeline,
          stage: row.stage,
          frameIds: row.frameIds,
          reply: row.reply,
        },
      })
  queueRowWrite(taskWrites, task.id, canvasId, write)
}

/* One feedback row is often saved twice in a row (its reply, then its
   completion), and each write carries the whole state. Without an order the
   older write can land last and undo the newer one, so writes per row queue. */
const feedbackWrites = new Map<string, QueuedWrite>()

export function saveFeedback(fb: TaskFeedback) {
  const row = {
    id: fb.id,
    taskId: fb.taskId,
    canvasId: fb.canvasId,
    agentName: fb.agentName,
    targetAgent: fb.targetAgent ?? null,
    fromName: fb.from,
    fromUserId: fb.fromUserId ?? null,
    text: fb.text,
    at: fb.at,
    deliveredAt: fb.deliveredAt ?? null,
    claimedBy: fb.claimedBy ?? null,
    claimedByResident: fb.claimedByResident ?? null,
    completedAt: fb.completedAt ?? null,
    failedAt: fb.failedAt ?? null,
    failureReason: fb.failureReason ?? null,
    runner: fb.runner ? JSON.stringify(fb.runner) : null,
    reply: fb.reply ?? null,
  }
  const write = () =>
    db
      .insert(t.feedback)
      .values(row)
      .onConflictDoUpdate({
        target: t.feedback.id,
        set: {
          deliveredAt: row.deliveredAt,
          claimedBy: row.claimedBy,
          claimedByResident: row.claimedByResident,
          completedAt: row.completedAt,
          failedAt: row.failedAt,
          failureReason: row.failureReason,
          reply: row.reply,
        },
      })
  queueRowWrite(feedbackWrites, fb.id, fb.canvasId, write)
}

export function saveComment(c: ElementComment) {
  swallow(writeComment(c))
}

/** The comment's write, for a caller that must know it landed. */
export function saveCommentNow(c: ElementComment): Promise<void> {
  return writeComment(c)
}

async function writeComment(c: ElementComment): Promise<void> {
  const row = {
    id: c.id,
    canvasId: c.canvasId,
    frameId: c.frameId ?? null,
    elementId: c.elementId ?? null,
    elementOrigin: c.elementOrigin ?? null,
    /* the pre-element-id anchor is spent once the comment is saved again */
    selector: null,
    snippet: c.snippet,
    pageId: c.pageId ?? null,
    x: c.x ?? null,
    y: c.y ?? null,
    fromName: c.from,
    fromUserId: c.fromUserId ?? null,
    text: c.text,
    at: c.at,
    forAgent: c.forAgent ?? false,
    targetAgent: c.targetAgent ?? null,
    claimedBy: c.claimedBy ?? null,
    claimedAt: c.claimedAt ?? null,
    failedAt: c.failedAt ?? null,
    failureReason: c.failureReason ?? null,
    resolvedBy: c.resolvedBy ?? null,
    resolvedAt: c.resolvedAt ?? null,
    parentId: c.parentId ?? null,
  }
  await db
    .insert(t.comments)
    .values(row)
    .onConflictDoUpdate({
      target: t.comments.id,
      set: {
        /* a moved thread keeps its id and takes a new anchor */
        frameId: row.frameId,
        elementId: row.elementId,
        elementOrigin: row.elementOrigin,
        selector: row.selector,
        snippet: row.snippet,
        pageId: row.pageId,
        x: row.x,
        y: row.y,
        /* a request handed back to the person is no longer the agent's */
        forAgent: row.forAgent,
        claimedBy: row.claimedBy,
        claimedAt: row.claimedAt,
        failedAt: row.failedAt,
        failureReason: row.failureReason,
        resolvedBy: row.resolvedBy,
        resolvedAt: row.resolvedAt,
      },
    })
}

export function saveActivity(canvasId: string, item: ActivityItem) {
  swallow(
    db.insert(t.activity).values({
      id: item.id,
      canvasId,
      actorName: item.actorName,
      actorKind: item.actorKind,
      actorColor: item.actorColor,
      message: item.message,
      frameId: item.frameId ?? null,
      at: item.at,
    }),
  )
}

/** Flush pending debounced frame writes and queued version writes (called
 *  on shutdown): a design must not survive a restart without its history. */
export async function flush(getFrame: (id: string) => Frame | undefined): Promise<void> {
  /* a component write waiting out a retry gets its last try now: a frame's row waits for
     its canvas's component writes (it may hold references to them), and must not sit out
     the wait behind one */
  draining = true
  for (const wake of [...retryWaits]) wake()
  /* every dirty frame, a failed write included, not only the debounced ones */
  const ids = [...dirtyFrames.keys()]
  for (const [, timer] of frameTimers) clearTimeout(timer)
  frameTimers.clear()
  await Promise.allSettled(
    ids.map((id) => {
      const f = getFrame(id)
      return f ? writeFrame(f) : Promise.resolve()
    }),
  )
  await pendingVersionWrites(() => true)
  await pendingComponentWrites()
}

/* ------------------------------------------------------------------ */
/* Boot hydration                                                     */
/* ------------------------------------------------------------------ */

export interface Hydrated {
  canvases: Canvas[]
  tasks: Map<string, AgentTask[]> // canvasId -> newest first
  feedback: Map<string, TaskFeedback[]>
  comments: Map<string, ElementComment[]>
  /** comment id -> the positional CSS path an element comment was anchored
   *  by before element ids; `backfillElementIds` turns each into a stamp */
  legacyCommentSelectors: Map<string, string>
  activity: Map<string, ActivityItem[]>
  decisions: Map<string, DesignDecision[]>
  proposals: Map<string, MemoryProposal[]>
}

const LOG_CAP = 100

/* every column but the retired inline history, which is most of the table's bytes */
const { legacyHistory: _legacyHistory, ...componentColumns } = getTableColumns(t.components)

export async function hydrate(): Promise<Hydrated> {
  const [
    canvasRows,
    frameRows,
    taskRows,
    feedbackRows,
    commentRows,
    activityRows,
    guidelineRows,
    componentRows,
    revisionRowsStored,
    tokenRows,
    referenceRows,
    decisionRows,
    proposalRows,
    memberRows,
  ] = await Promise.all([
    db.select().from(t.canvases),
    /* every column but html: frame HTML is most of the database and loads
       per canvas when something needs it (store.load) */
    db.select(frameMetaColumns).from(t.frames),
    db.select().from(t.tasks).orderBy(desc(t.tasks.startedAt)),
    db.select().from(t.feedback).orderBy(desc(t.feedback.at)),
    db.select().from(t.comments).orderBy(desc(t.comments.at)),
    db.select().from(t.activity).orderBy(desc(t.activity.at)),
    db.select().from(t.guidelines).orderBy(t.guidelines.name),
    db.select(componentColumns).from(t.components).orderBy(t.components.name),
    db.select().from(t.componentRevisions).orderBy(t.componentRevisions.rev),
    db.select().from(t.designTokens).orderBy(t.designTokens.order, t.designTokens.name),
    db.select().from(t.memoryReferences).orderBy(desc(t.memoryReferences.pinnedAt)),
    db.select().from(t.decisions).orderBy(desc(t.decisions.at)),
    db.select().from(t.memoryProposals).orderBy(desc(t.memoryProposals.at)),
    db.select().from(t.canvasMembers).orderBy(t.canvasMembers.addedAt),
  ])

  const canvases: Canvas[] = canvasRows.map((c) => ({
    id: c.id,
    name: c.name,
    pages: c.pages ?? undefined,
    ...(c.guides?.length ? { guides: c.guides } : {}),
    ...(c.tokenThemes?.length ? { tokenThemes: c.tokenThemes } : {}),
    ownerId: c.ownerId ?? undefined,
    /* 'view' / 'comment' / 'edit'; null and anything unknown read as private */
    linkAccess: storedLinkAccess(c.linkAccess),
    ...(c.publishedAt != null ? { publishedAt: c.publishedAt } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(isCommunityCategory(c.category) ? { category: c.category } : {}),
    ...(c.copyCount ? { copyCount: c.copyCount } : {}),
    ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    frames: [],
  }))
  const byId = new Map(canvases.map((c) => [c.id, c]))
  for (const m of memberRows) {
    const c = byId.get(m.canvasId)
    if (c) (c.memberIds ??= []).push(m.userId)
  }
  for (const f of frameRows) {
    const frame = {
      ...f,
      pageId: f.pageId ?? undefined,
      demo: f.demo ?? undefined,
      hidden: f.hidden ?? undefined,
      locked: f.locked ?? undefined,
      z: f.z ?? undefined,
      rotation: f.rotation ?? undefined,
    } as Frame
    unloadHtml(frame)
    byId.get(f.canvasId)?.frames.push(frame)
  }
  for (const c of canvases) c.frames.sort(byStack)
  for (const r of referenceRows) {
    const c = byId.get(r.canvasId)
    if (!c) continue
    ;(c.references ??= []).push({
      id: r.id,
      frameId: r.frameId,
      title: r.title,
      html: r.html,
      width: r.width,
      height: r.height,
      pinnedBy: r.pinnedBy,
      pinnedAt: r.pinnedAt,
    })
  }
  /* oldest first, as bumpRevision keeps them */
  const histories = new Map<string, ComponentSnapshot[]>()
  for (const { canvasId, componentId, renderRev, ...kept } of revisionRowsStored) {
    const entry: ComponentSnapshot = renderRev == null ? kept : { ...kept, renderRev }
    const key = componentKey(canvasId, componentId)
    const history = histories.get(key)
    if (history) history.push(entry)
    else histories.set(key, [entry])
  }
  revisionsFiled.clear()
  for (const row of componentRows) {
    const c = byId.get(row.canvasId)
    if (!c) continue
    const { canvasId: _canvasId, code, source, status, deletedAt, deletedBy, renderRev, ...def } = row
    const history = (histories.get(componentKey(row.canvasId, row.id)) ?? []).slice(-MAX_COMPONENT_HISTORY)
    noteRevisionsFiled(row.canvasId, row.id, history)
    const read: ComponentDef = {
      ...def,
      ...(renderRev != null && renderRev < def.rev ? { renderRev } : {}),
      history,
      ...(code ? { code } : {}),
      ...(source ? { source } : {}),
      ...(status === 'deleted' ? { status, deletedAt: deletedAt ?? def.updatedAt, deletedBy: deletedBy ?? '' } : {}),
    }
    storedDefs.add(read)
    ;(c.components ??= []).push(read)
  }
  for (const g of guidelineRows) {
    const c = byId.get(g.canvasId)
    if (!c) continue
    ;(c.guidelines ??= []).push({
      name: g.name,
      markdown: g.markdown,
      ...(g.title != null ? { title: g.title } : {}),
      updatedAt: g.updatedAt,
      updatedBy: g.updatedBy,
      ...(g.x != null ? { x: g.x } : {}),
      ...(g.y != null ? { y: g.y } : {}),
    })
  }
  for (const row of tokenRows) {
    const c = byId.get(row.canvasId)
    if (!c) continue
    ;(c.tokens ??= []).push({
      name: row.name,
      type: row.type as TokenType,
      value: row.value,
      ...(row.themes && Object.keys(row.themes).length ? { themes: row.themes } : {}),
      ...(row.description != null ? { description: row.description } : {}),
      order: row.order,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    })
  }

  const now = Date.now()
  const interruptedReason = 'The agent stopped before finishing. Retry when you are ready.'
  const tasks = new Map<string, AgentTask[]>()
  for (const row of taskRows) {
    const list = tasks.get(row.canvasId) ?? []
    /* A task still open across a restart belongs to an agent that's gone.
       Ordinary status tasks close; claimed board cards pause in a visible
       failed state and require a human retry. */
    const isOpenCard = row.queuedBy != null && row.endedAt == null
    /* the cap bounds history, never open work: an unfinished card older than
       the newest hundred rows still belongs on the board (same rule as
       actions.trimTaskLog keeps in memory) */
    if (list.length >= LOG_CAP && !isOpenCard) continue
    const endedAt = isOpenCard ? undefined : (row.endedAt ?? now)
    const interruptedCard = isOpenCard && !!row.agentName
    const failedAt = row.failedAt ?? (interruptedCard ? now : undefined)
    const failureReason = row.failureReason ?? (interruptedCard ? interruptedReason : undefined)
    if (row.endedAt == null && !isOpenCard) swallow(db.update(t.tasks).set({ endedAt }).where(eq(t.tasks.id, row.id)))
    if (interruptedCard && row.failedAt == null) {
      swallow(db.update(t.tasks).set({ failedAt, failureReason }).where(eq(t.tasks.id, row.id)))
    }
    list.push({
      id: row.id,
      agentName: row.agentName,
      ...(row.agentKey != null ? { agentKey: row.agentKey } : {}),
      ...(row.owner != null ? { owner: row.owner } : {}),
      color: row.color,
      status: row.status,
      startedAt: row.startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(row.auto ? { auto: true } : {}),
      ...(row.queuedBy != null ? { queuedBy: row.queuedBy } : {}),
      ...(row.queuedByUserId != null ? { queuedByUserId: row.queuedByUserId } : {}),
      ...(row.claimedAt != null ? { claimedAt: row.claimedAt } : {}),
      ...(failedAt !== undefined ? { failedAt } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(row.pipeline ? { pipeline: row.pipeline.split(',').filter(Boolean) } : {}),
      ...(row.stage != null ? { stage: row.stage } : {}),
      ...(row.attachments ? { attachments: row.attachments.split(',').filter(Boolean) } : {}),
      ...repoCardFields(row.kind, row.payload),
      ...scopeField(row.scope),
      ...(row.frameIds ? { frameIds: row.frameIds.split(',').filter(Boolean) } : {}),
      ...runnerField(row.runner),
      ...(row.reply != null ? { reply: row.reply } : {}),
    })
    tasks.set(row.canvasId, list)
  }

  const feedback = new Map<string, TaskFeedback[]>()
  for (const row of feedbackRows) {
    const list = feedback.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    /* only resident runs are in-process; feedback claimed by an outside MCP
       agent may still be in flight elsewhere, so it is left alone. The claim
       records which it was, since a custom agent may share an outside agent's
       name; a claim from before that record could only be a built-in's */
    const interrupted =
      (row.claimedByResident ?? roleByAgentName(row.claimedBy ?? undefined, AGENT_ROLES) != null) &&
      row.deliveredAt != null &&
      row.completedAt == null &&
      row.failedAt == null
    const failedAt = row.failedAt ?? (interrupted ? now : undefined)
    const failureReason = row.failureReason ?? (interrupted ? interruptedReason : undefined)
    if (interrupted) swallow(db.update(t.feedback).set({ failedAt, failureReason }).where(eq(t.feedback.id, row.id)))
    list.push({
      id: row.id,
      taskId: row.taskId,
      canvasId: row.canvasId,
      agentName: row.agentName,
      ...(row.targetAgent != null ? { targetAgent: row.targetAgent } : {}),
      from: row.fromName,
      ...(row.fromUserId != null ? { fromUserId: row.fromUserId } : {}),
      ...runnerField(row.runner),
      text: row.text,
      at: row.at,
      ...(row.deliveredAt != null ? { deliveredAt: row.deliveredAt } : {}),
      ...(row.claimedBy != null ? { claimedBy: row.claimedBy } : {}),
      ...(row.claimedByResident != null ? { claimedByResident: row.claimedByResident } : {}),
      ...(row.completedAt != null ? { completedAt: row.completedAt } : {}),
      ...(failedAt !== undefined ? { failedAt } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(row.reply != null ? { reply: row.reply } : {}),
    })
    feedback.set(row.canvasId, list)
  }

  const comments = new Map<string, ElementComment[]>()
  const legacyCommentSelectors = new Map<string, string>()
  for (const row of commentRows) {
    const list = comments.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    if (row.elementId == null && row.frameId != null && row.selector && row.selector !== 'body') {
      legacyCommentSelectors.set(row.id, row.selector)
    }
    const interrupted = row.claimedBy != null && row.resolvedAt == null && row.failedAt == null
    const failedAt = row.failedAt ?? (interrupted ? now : undefined)
    const failureReason = row.failureReason ?? (interrupted ? interruptedReason : undefined)
    if (interrupted) swallow(db.update(t.comments).set({ failedAt, failureReason }).where(eq(t.comments.id, row.id)))
    list.push({
      id: row.id,
      canvasId: row.canvasId,
      ...(row.frameId != null ? { frameId: row.frameId } : {}),
      ...(row.elementId != null ? { elementId: row.elementId } : {}),
      ...(row.elementOrigin != null ? { elementOrigin: row.elementOrigin } : {}),
      snippet: row.snippet,
      ...(row.pageId != null ? { pageId: row.pageId } : {}),
      ...(row.x != null ? { x: row.x } : {}),
      ...(row.y != null ? { y: row.y } : {}),
      from: row.fromName,
      ...(row.fromUserId != null ? { fromUserId: row.fromUserId } : {}),
      text: row.text,
      at: row.at,
      ...(row.forAgent ? { forAgent: true } : {}),
      ...(row.targetAgent != null ? { targetAgent: row.targetAgent } : {}),
      ...(row.claimedBy != null ? { claimedBy: row.claimedBy } : {}),
      ...(row.claimedAt != null ? { claimedAt: row.claimedAt } : {}),
      ...(failedAt !== undefined ? { failedAt } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(row.resolvedBy != null ? { resolvedBy: row.resolvedBy } : {}),
      ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
      ...(row.parentId != null ? { parentId: row.parentId } : {}),
    })
    comments.set(row.canvasId, list)
  }

  const activity = new Map<string, ActivityItem[]>()
  for (const row of activityRows) {
    const list = activity.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      actorName: row.actorName,
      actorKind: row.actorKind as ActivityItem['actorKind'],
      actorColor: row.actorColor,
      message: row.message,
      frameId: row.frameId ?? undefined,
      at: row.at,
    })
    activity.set(row.canvasId, list)
  }

  const decisions = new Map<string, DesignDecision[]>()
  for (const row of decisionRows) {
    const list = decisions.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      text: row.text,
      ...(row.summary != null ? { summary: row.summary } : {}),
      source: row.source as DesignDecision['source'],
      ...(row.frameId != null ? { frameId: row.frameId } : {}),
      from: row.fromName,
      ...(row.agentName != null ? { agentName: row.agentName } : {}),
      at: row.at,
      ...(row.distilledAt != null ? { distilledAt: row.distilledAt } : {}),
    })
    decisions.set(row.canvasId, list)
  }

  const proposals = new Map<string, MemoryProposal[]>()
  for (const row of proposalRows) {
    const list = proposals.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      guideName: row.guideName,
      ...(row.guideTitle != null ? { guideTitle: row.guideTitle } : {}),
      rule: row.rule,
      rationale: row.rationale,
      basedOn: row.basedOn.split(',').filter(Boolean),
      at: row.at,
      status: row.status as MemoryProposal['status'],
      ...(row.resolvedBy != null ? { resolvedBy: row.resolvedBy } : {}),
      ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
    })
    proposals.set(row.canvasId, list)
  }

  return { canvases, tasks, feedback, comments, legacyCommentSelectors, activity, decisions, proposals }
}

/** One-time import of the pre-DB data/store.json so existing canvases survive. */
export async function importLegacyJson(): Promise<Canvas[] | null> {
  const file = path.join(process.cwd(), 'data', 'store.json')
  let parsed: Canvas[]
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  for (const c of parsed) {
    await db
      .insert(t.canvases)
      .values({ id: c.id, name: c.name, createdAt: c.createdAt, updatedAt: c.updatedAt })
      .onConflictDoNothing()
    for (const f of c.frames) await writeFrame(f)
  }
  fs.renameSync(file, `${file}.imported`)
  console.log(`[db] imported ${parsed.length} canvas(es) from legacy store.json`)
  return parsed
}
