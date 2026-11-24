import {
  MAX_COMPONENTS,
  MAX_COMPONENT_NAME,
  stableJson,
  isDeleted,
  type ComponentDef,
  type LibraryChange,
  type LibraryComponent,
} from '../shared/components.ts'
import type { Canvas } from '../shared/types.ts'
import { libraryLandingPageId } from '../shared/pages.ts'
import * as persist from './db/persist.ts'
import { afterCommit, recordUndo } from './journal.ts'
import { store } from './store.ts'
import { getWorkspace, isActive } from './workspaces.ts'

/**
 * Workspace component libraries: what each library canvas has published, and
 * how a canvas in the same workspace takes a published component up. A canvas
 * is a library while it has published snapshots; it serves the workspace it is
 * in. Mirrored in memory like components, since frame writes read it.
 * Spec: .context/specs/workspace-component-library.md.
 */

const published = new Map<string, LibraryComponent[]>()

/** Replace a canvas's publication (none = it publishes nothing). Journaled like every store
 *  write (server/journal.ts): undone with the operation, its rows written at the commit. */
function setPublished(canvasId: string, next: LibraryComponent[]) {
  const before = published.get(canvasId)
  if (next.length) published.set(canvasId, next)
  else published.delete(canvasId)
  recordUndo(() => {
    if (published.get(canvasId) !== (next.length ? next : undefined)) return
    if (before) published.set(canvasId, before)
    else published.delete(canvasId)
  })
}

export async function hydrateLibraries(): Promise<void> {
  published.clear()
  for (const snapshot of await persist.loadLibraryComponents()) {
    const list = published.get(snapshot.canvasId)
    if (list) list.push(snapshot)
    else published.set(snapshot.canvasId, [snapshot])
  }
}

/** What a canvas has published, whether or not anyone may use it right now. */
export function publishedOn(canvasId: string): LibraryComponent[] {
  return published.get(canvasId) ?? []
}

export function isLibrary(canvasId: string): boolean {
  return publishedOn(canvasId).length > 0
}

/** Where a library canvas opens: see `libraryLandingPageId`. Reads frame
 *  metadata only, so it needs no frame HTML loaded. */
export function landingPageOf(canvas: Canvas): string | undefined {
  const snapshots = publishedOn(canvas.id)
  if (!snapshots.length) return undefined
  return libraryLandingPageId(
    canvas,
    snapshots.map((snapshot) => snapshot.id),
  )
}

/** Why a canvas cannot publish or use a library, or null when it can: libraries
 *  belong to a workspace whose plan is live (every workspace, with billing off). */
export function libraryBlock(
  canvas: Pick<Canvas, 'workspaceId'>,
): { reason: 'no_workspace' } | { reason: 'plan_required'; workspaceId: string } | null {
  if (!canvas.workspaceId) return { reason: 'no_workspace' }
  const workspace = getWorkspace(canvas.workspaceId)
  if (!workspace) return { reason: 'no_workspace' }
  return isActive(workspace) ? null : { reason: 'plan_required', workspaceId: workspace.id }
}

export interface Library {
  canvasId: string
  name: string
  components: LibraryComponent[]
}

/** The libraries a canvas designs with: every other canvas of its workspace
 *  that has published. It goes by the canvas, like fonts, so a guest editing a
 *  workspace canvas has its library too. */
export function librariesForCanvas(canvas: Pick<Canvas, 'id' | 'workspaceId'>): Library[] {
  if (libraryBlock(canvas)) return []
  const libraries: Library[] = []
  for (const [canvasId, components] of published) {
    if (canvasId === canvas.id || !components.length) continue
    const source = store.getCanvas(canvasId)
    if (!source || source.workspaceId !== canvas.workspaceId) continue
    /* a component its library has deleted is published only as what others are built from
       (see `publication`): it comes along with them, and is not offered on its own */
    const offered = components.filter((entry) => !isDeleted(source.components?.find((def) => def.id === entry.id)))
    if (offered.length) libraries.push({ canvasId, name: source.name, components: offered })
  }
  return libraries.sort((a, b) => a.name.localeCompare(b.name))
}

/** Every library of a workspace, for its settings page. */
export function librariesOfWorkspace(workspaceId: string): Library[] {
  return librariesForCanvas({ id: '', workspaceId })
}

function matches(snapshot: LibraryComponent, ref: string): boolean {
  return snapshot.id === ref || snapshot.name.toLowerCase() === ref.trim().toLowerCase()
}

/** Published components a canvas could use under this name or id, across its libraries. */
export function findInLibraries(canvas: Pick<Canvas, 'id' | 'workspaceId'>, ref: string): LibraryComponent[] {
  return librariesForCanvas(canvas).flatMap((library) => library.components.filter((entry) => matches(entry, ref)))
}

export function publishedSnapshot(canvasId: string, componentId: string): LibraryComponent | undefined {
  return publishedOn(canvasId).find((entry) => entry.id === componentId)
}

/** The snapshot a linked definition follows, while its library still serves this canvas. */
export function originOf(canvas: Pick<Canvas, 'id' | 'workspaceId'>, def: ComponentDef): LibraryComponent | undefined {
  if (!def.source?.library) return undefined
  const source = store.getCanvas(def.source.canvasId)
  if (!source || source.workspaceId !== canvas.workspaceId || !canvas.workspaceId) return undefined
  return publishedSnapshot(def.source.canvasId, def.source.componentId)
}

/* ------------------------------------------------------------------ */
/* Publishing                                                          */
/* ------------------------------------------------------------------ */

function nestedRefs(template: string): string[] {
  return [...template.matchAll(/component="([^"]+)"/g)].map((match) => match[1]!)
}

/** Which other library each nested component of a definition is linked to, on its canvas today. */
function nestedSources(canvasId: string, def: ComponentDef): Record<string, string> | undefined {
  const defs = store.getComponents(canvasId)
  const sources: Record<string, string> = {}
  for (const ref of nestedRefs(def.template)) {
    const nested = defs.find((candidate) => candidate.id === ref || candidate.name === ref)
    if (nested?.source?.library) sources[nested.id] = nested.source.canvasId
  }
  return Object.keys(sources).length ? sources : undefined
}

function sameAsPublished(canvasId: string, def: ComponentDef, snapshot: LibraryComponent): boolean {
  return (
    stableJson(nestedSources(canvasId, def) ?? {}) === stableJson(snapshot.nested ?? {}) &&
    def.name === snapshot.name &&
    def.description === snapshot.description &&
    def.template === snapshot.template &&
    def.css === snapshot.css &&
    JSON.stringify(def.head) === JSON.stringify(snapshot.head) &&
    JSON.stringify(def.props) === JSON.stringify(snapshot.props) &&
    JSON.stringify(def.slots) === JSON.stringify(snapshot.slots) &&
    JSON.stringify(def.code ?? null) === JSON.stringify(snapshot.code ?? null)
  )
}

/** The canvas's own component, with a design to show. */
function ownDesign(def: ComponentDef): boolean {
  return !def.source?.library && def.rev > 0 && !!def.template
}

/** A component a library canvas can publish: its own, with a design to show, and in use. */
export function publishable(def: ComponentDef): boolean {
  return ownDesign(def) && !isDeleted(def)
}

/** Everything a publication of this canvas holds: the components it can publish, and the
 *  deleted ones those are built from. A deleted component is frozen, not gone: a published
 *  Card that nests a deleted Button still renders that Button, so a canvas using the Card
 *  needs the Button's snapshot too. It rides along as a dependency only (never offered on
 *  its own, see `librariesForCanvas`), and leaves the publication when nothing in use is
 *  built from it any more. */
function publication(canvas: Canvas): ComponentDef[] {
  const inUse = (canvas.components ?? []).filter(publishable)
  const frozen = withDependencies(
    canvas,
    inUse.map((def) => def.id),
  ).filter((def) => isDeleted(def) && ownDesign(def))
  return [...inUse, ...frozen]
}

export interface LibraryChangeEntry {
  id: string
  name: string
  change: LibraryChange
}

/** What publishing this canvas now would do, component by component. */
export function libraryChanges(canvas: Canvas): LibraryChangeEntry[] {
  const snapshots = publishedOn(canvas.id)
  const local = publication(canvas)
  const entries: LibraryChangeEntry[] = local.map((def) => {
    const snapshot = snapshots.find((entry) => entry.id === def.id)
    const change: LibraryChange = !snapshot
      ? 'new'
      : sameAsPublished(canvas.id, def, snapshot)
        ? 'unchanged'
        : 'changed'
    return { id: def.id, name: def.name, change }
  })
  for (const snapshot of snapshots) {
    if (!local.some((def) => def.id === snapshot.id))
      entries.push({ id: snapshot.id, name: snapshot.name, change: 'removed' })
  }
  return entries
}

/** The chosen components and everything they are built from, by id. */
function withDependencies(canvas: Canvas, ids: readonly string[]): ComponentDef[] {
  const defs = canvas.components ?? []
  const seen = new Map<string, ComponentDef>()
  const stack = [...ids]
  for (let ref = stack.pop(); ref; ref = stack.pop()) {
    const def = defs.find((candidate) => candidate.id === ref || candidate.name === ref)
    if (!def || seen.has(def.id)) continue
    seen.set(def.id, def)
    stack.push(...nestedRefs(def.template))
  }
  return [...seen.values()]
}

/** `previous` is what was published before: a publication's `rev` only ever
 *  rises, since a change that leaves the canvas's own revision alone (a
 *  description, the code mapping, head tags) must still reach the canvases
 *  using it, and they tell an update by a higher `rev`. */
function snapshotOf(
  canvasId: string,
  def: ComponentDef,
  by: string,
  at: number,
  previous: LibraryComponent | undefined,
): LibraryComponent {
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
    ...(def.code ? { code: def.code } : {}),
    ...(nestedSources(canvasId, def) ? { nested: nestedSources(canvasId, def) } : {}),
    rev: previous ? Math.max(def.rev, previous.rev + 1) : def.rev,
    publishedAt: at,
    publishedBy: by,
  }
}

export interface PublishResult {
  published: LibraryChangeEntry[]
  removed: LibraryChangeEntry[]
}

/** Publish the chosen components (all publishable ones when none are named),
 *  each with what it is built from. A published component the canvas no longer
 *  has stops being offered. Entitlement is the caller's check. */
export function publishLibrary(canvas: Canvas, ids: readonly string[] | undefined, by: string): PublishResult {
  const all = publication(canvas)
  /* the chosen ones and what they are built from, deleted dependencies included */
  const chosen = withDependencies(canvas, ids ?? all.map((def) => def.id)).filter((def) => all.includes(def))
  const before = publishedOn(canvas.id)
  const changes = libraryChanges(canvas)
  const changeOf = (id: string) => changes.find((entry) => entry.id === id)
  const result: PublishResult = {
    published: chosen.flatMap((def) => {
      const entry = changeOf(def.id)
      return entry && entry.change !== 'unchanged' ? [entry] : []
    }),
    removed: changes.filter((entry) => entry.change === 'removed'),
  }
  const at = Date.now()
  const next = before.filter((entry) => !result.removed.some((gone) => gone.id === entry.id))
  for (const def of chosen) {
    if (changeOf(def.id)?.change === 'unchanged') continue
    const index = next.findIndex((entry) => entry.id === def.id)
    const snapshot = snapshotOf(canvas.id, def, by, at, next[index])
    if (index === -1) next.push(snapshot)
    else next[index] = snapshot
    afterCommit(() => persist.saveLibraryComponent(snapshot))
  }
  for (const gone of result.removed) afterCommit(() => persist.deleteLibraryComponent(canvas.id, gone.id))
  next.sort((a, b) => a.name.localeCompare(b.name))
  setPublished(canvas.id, next)
  return result
}

/** Stop offering some published components, or the whole library. Canvases
 *  already using them keep their definition and every instance. */
export function unpublishLibrary(canvasId: string, ids?: readonly string[]): LibraryComponent[] {
  const before = publishedOn(canvasId)
  const gone = ids ? before.filter((entry) => ids.includes(entry.id)) : before
  for (const entry of gone) afterCommit(() => persist.deleteLibraryComponent(canvasId, entry.id))
  const kept = before.filter((entry) => !gone.includes(entry))
  setPublished(canvasId, kept)
  return gone
}

/** The canvas is gone: so is what it published, here as in the database (where
 *  the rows go with the canvas's own). Not a withdrawal anyone is told about. */
export function forgetLibrary(canvasId: string) {
  setPublished(canvasId, [])
}

/* ------------------------------------------------------------------ */
/* Using                                                               */
/* ------------------------------------------------------------------ */

export class LibraryAdoptError extends Error {}

function freeLibraryName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (library)' : ` (library ${n})`
    const candidate = `${name.slice(0, MAX_COMPONENT_NAME - suffix.length).trimEnd()}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** A snapshot read as a definition, for rendering it where no canvas holds it yet. */
export function snapshotAsDef(snapshot: LibraryComponent): ComponentDef {
  return linkedDef(snapshot, snapshot.name, snapshot.publishedBy)
}

function linkedDef(snapshot: LibraryComponent, name: string, by: string): ComponentDef {
  const now = Date.now()
  return {
    id: snapshot.id,
    name,
    description: snapshot.description,
    template: snapshot.template,
    css: snapshot.css,
    rawCss: snapshot.rawCss,
    head: snapshot.head,
    props: snapshot.props,
    slots: snapshot.slots,
    /* the publication's own number: a linked definition changes only by taking a
       newer publication, so one count serves both and instance markers read true */
    rev: snapshot.rev,
    mainFrameId: null,
    history: [],
    ...(snapshot.code ? { code: snapshot.code } : {}),
    source: { canvasId: snapshot.canvasId, componentId: snapshot.id, rev: snapshot.rev, library: true },
    createdAt: now,
    updatedAt: now,
    updatedBy: by,
  }
}

/** A nested component its own library does not publish: a library can be built
 *  out of another's components (a Plan card around the design system's Button).
 *  The publication recorded which library each of those came from, and that is
 *  the one resolved against. An id alone would not do, since a copied canvas
 *  shares ids and two libraries can publish different designs under one; nor
 *  would the library canvas's link as it is today, which can have moved since. */
function publishedElsewhere(entry: LibraryComponent, ref: string): LibraryComponent | undefined {
  const from = entry.nested?.[ref]
  if (!from) return undefined
  const source = store.getCanvas(from)
  if (!source || source.workspaceId !== store.getCanvas(entry.canvasId)?.workspaceId) return undefined
  return publishedSnapshot(from, ref)
}

/** The snapshot and every published component it is built from, dependencies first. */
export function snapshotClosure(snapshot: LibraryComponent): LibraryComponent[] {
  const seen = new Map<string, LibraryComponent>()
  const visit = (entry: LibraryComponent) => {
    if (seen.has(entry.id)) return
    seen.set(entry.id, entry)
    for (const ref of nestedRefs(entry.template)) {
      const nested =
        publishedOn(entry.canvasId).find((candidate) => matches(candidate, ref)) ?? publishedElsewhere(entry, ref)
      if (nested) visit(nested)
    }
  }
  visit(snapshot)
  return [...seen.values()].reverse()
}

/** Add a published component to a canvas as a linked definition with no main
 *  of its own, along with what it is built from. Returns the definitions that
 *  were added; ones the canvas already links are left as they are, since an
 *  update is pulled on request. Throws before writing anything when an id here
 *  belongs to the canvas's own component (a copied canvas shares ids). */
export function adoptFromLibrary(canvasId: string, snapshot: LibraryComponent, by: string): ComponentDef[] {
  const local = store.getComponents(canvasId)
  const wanted = snapshotClosure(snapshot)
  const missing = wanted.filter((entry) => {
    const existing = local.find((def) => def.id === entry.id)
    if (existing && existing.source?.canvasId !== entry.canvasId)
      throw new LibraryAdoptError(
        `this canvas already has its own component “${existing.name}” (${existing.id}), shared with the library because one canvas was copied from the other; edit it here instead`,
      )
    return !existing
  })
  if (local.length + missing.length > MAX_COMPONENTS)
    throw new LibraryAdoptError(`a canvas holds at most ${MAX_COMPONENTS} components`)
  const taken = new Set(local.map((def) => def.name.toLowerCase()))
  const added: ComponentDef[] = []
  for (const entry of missing) {
    const linked = linkedDef(entry, freeLibraryName(entry.name, taken), by)
    /* one its library has deleted comes only as what another is built from: it is deleted
       here too, so it renders inside that component and is not there to be used by itself */
    const origin = store.getComponents(entry.canvasId).find((candidate) => candidate.id === entry.id)
    const def: ComponentDef = isDeleted(origin)
      ? { ...linked, status: 'deleted', deletedAt: origin?.deletedAt ?? Date.now(), deletedBy: origin?.deletedBy ?? by }
      : linked
    if (!isDeleted(def)) taken.add(def.name.toLowerCase())
    store.saveComponent(canvasId, def)
    added.push(def)
  }
  return added
}
