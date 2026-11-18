import { customAlphabet } from 'nanoid'
import { serializeOuter } from 'parse5'
import {
  COMPONENT_ATTR,
  CSS_ATTR,
  HEAD_ATTR,
  INSTANCE_ATTR,
  MAX_COMPONENT_HISTORY,
  OVERRIDES_ATTR,
  PART_ATTR,
  PROPS_ATTR,
  REV_ATTR,
  USE_TAG,
  isDeleted,
  type ComponentDef,
  type ComponentIssue,
  type ComponentProp,
} from '../shared/components.ts'
import { extractComponentCss, frameHeadTags, frameStylesheets } from './componentCss.ts'
import {
  attrOf,
  derivePropsAndSlots,
  expandUses,
  findMarked,
  holdsHollow,
  renderInstance,
  reconcileInstance,
  setAttr,
  splice,
  stampParts,
  syncComponentHead,
  templateFromMain,
  usedComponentIds,
  type EngineContext,
} from './componentEngine.ts'
import { adoptFromLibrary, findInLibraries, LibraryAdoptError } from './componentLibrary.ts'
import { store } from './store.ts'
import { noteCanvas } from './workBudget.ts'
import type { Canvas } from '../shared/types.ts'

/**
 * Where components meet the frame store. Every frame write is prepared here
 * first: `<doop-use>` written out, a changed main folded into its component,
 * instances reconciled and brought up to the current revision, and exactly the
 * right stylesheets put in the head. Sync, so no write can slip between the
 * read and the commit. Spec: .context/specs/components.md.
 */

const componentSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 9)

export function newComponentId(): string {
  return `c${componentSuffix()}`
}

/** A write may take up a component its workspace library publishes, the first
 *  time something names it: `added` collects the definitions that joined the canvas. */
export interface LibraryAdoption {
  by: string
  added: ComponentDef[]
}

export function contextFor(canvasId: string, adoption?: LibraryAdoption): EngineContext {
  const defs = () => store.getComponents(canvasId)
  const issues: ComponentIssue[] = []
  /* an id is exact, deleted or not: markup already on the canvas points at it. A name means
     the component in use; a deleted one answers to its name only when nothing else has it,
     so that asking for it says "deleted" rather than "unknown" */
  const local = (ref: string) => {
    const wanted = ref.trim().toLowerCase()
    const named = defs().filter((def) => def.name.toLowerCase() === wanted)
    return defs().find((def) => def.id === ref) ?? named.find((def) => !isDeleted(def)) ?? named[0]
  }
  const find = (ref: string) =>
    local(ref) ?? (adoption && ref ? fromLibrary(canvasId, ref, adoption, issues) : undefined)
  return {
    find,
    atRev(id, rev) {
      const def = defs().find((candidate) => candidate.id === id)
      if (!def) return undefined
      if (def.rev === rev) return def
      const snapshot = def.history.find((entry) => entry.rev === rev)
      return snapshot ? { id, name: def.name, rev, template: snapshot.template, props: snapshot.props } : undefined
    },
    issues,
  }
}

/** Nothing on the canvas has this name: its workspace library may. A local
 *  component always wins the name, so this is reached only for a new one. */
function fromLibrary(
  canvasId: string,
  ref: string,
  adoption: LibraryAdoption,
  issues: ComponentIssue[],
): ComponentDef | undefined {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return undefined
  const candidates = findInLibraries(canvas, ref)
  const [snapshot] = candidates
  if (!snapshot) return undefined
  if (candidates.length > 1) {
    const where = candidates.map(
      (entry) => `${store.getCanvas(entry.canvasId)?.name ?? entry.canvasId} (${entry.canvasId})`,
    )
    issues.push({
      code: 'library_ambiguous',
      message: `“${ref}” is published by more than one library: ${where.join(', ')}. Call import_component with the source_canvas_id you mean, then use it.`,
    })
    return undefined
  }
  try {
    adoption.added.push(...adoptFromLibrary(canvasId, snapshot, adoption.by))
  } catch (error) {
    if (!(error instanceof LibraryAdoptError)) throw error
    issues.push({ code: 'unknown_component', message: error.message })
    return undefined
  }
  return store.getComponents(canvasId).find((def) => def.id === snapshot.id)
}

export function referencesComponent(html: string, id: string): boolean {
  return html.includes(` ${INSTANCE_ATTR}="${id}"`) || html.includes(` ${COMPONENT_ATTR}="${id}"`)
}

function touchesComponents(html: string): boolean {
  return (
    html.includes(INSTANCE_ATTR) ||
    html.includes(COMPONENT_ATTR) ||
    html.includes(CSS_ATTR) ||
    html.includes(HEAD_ATTR) ||
    html.toLowerCase().includes(`<${USE_TAG}`)
  )
}

function closureOf(ids: Iterable<string>, canvasId: string): ComponentDef[] {
  const defs = store.getComponents(canvasId)
  const seen = new Map<string, ComponentDef>()
  const stack = [...ids]
  for (let id = stack.pop(); id; id = stack.pop()) {
    if (seen.has(id)) continue
    const def = defs.find((candidate) => candidate.id === id)
    if (!def) continue
    seen.set(id, def)
    for (const match of def.template.matchAll(/component="([^"]+)"/g)) {
      const nested = defs.find((candidate) => candidate.id === match[1] || candidate.name === match[1])
      if (nested) stack.push(nested.id)
    }
  }
  /* dependencies first, so a nested component's rules come before the ones built on them */
  return [...seen.values()].reverse()
}

/** Would a template using these components put `id` inside itself? */
function wouldCycle(canvasId: string, id: string, template: string): boolean {
  const defs = store.getComponents(canvasId)
  const stack = [...template.matchAll(/component="([^"]+)"/g)].map((match) => match[1]!)
  const seen = new Set<string>()
  for (let ref = stack.pop(); ref; ref = stack.pop()) {
    const def = defs.find((candidate) => candidate.id === ref || candidate.name === ref)
    if (!def || seen.has(def.id)) continue
    if (def.id === id) return true
    seen.add(def.id)
    for (const match of def.template.matchAll(/component="([^"]+)"/g)) stack.push(match[1]!)
  }
  return false
}

export function bumpRevision(def: ComponentDef, by: string): ComponentDef {
  const history = [
    ...def.history,
    {
      rev: def.rev,
      template: def.template,
      rawCss: def.rawCss,
      head: def.head,
      props: def.props,
      savedAt: def.updatedAt,
      savedBy: def.updatedBy,
    },
  ].slice(-MAX_COMPONENT_HISTORY)
  return { ...def, history, rev: def.rev + 1, updatedAt: Date.now(), updatedBy: by }
}

/* Revisions update_component has opened and whose main is still to be written. That write is
   the rest of the same change, so it fills the open revision instead of adding one: the kept
   snapshot stays the state instances were rendered from. Every write is sync, so an entry
   never outlives its update. */
const openRevisions = new Set<string>()

const revisionKey = (canvasId: string, id: string) => `${canvasId}:${id}`

/** Run a main's write as part of the revision `bumpRevision` just opened for this component. */
export function withinRevision<T>(canvasId: string, id: string, write: () => T): T {
  const key = revisionKey(canvasId, id)
  openRevisions.add(key)
  try {
    return write()
  } finally {
    openRevisions.delete(key)
  }
}

/** `only`: the mains to look at, every other one left as it is (a repair of those definitions). */
function prepareMains(
  canvas: Canvas,
  frameId: string,
  html: string,
  by: string,
  ctx: EngineContext,
  only?: ReadonlySet<string>,
) {
  const changed: ComponentDef[] = []
  const moved: ComponentDef[] = []
  const claimed = new Set<string>()
  const edits: { start: number; end: number; text: string }[] = []
  /* each parses the whole frame, so once per call, not once per main: a frame
     holding hundreds of mains re-parsed itself hundreds of times per propagation */
  let sheetCache: string | undefined
  let headCache: string[] | undefined
  const sheet = () => (sheetCache ??= frameStylesheets(html))
  const headTags = () => [...(headCache ??= frameHeadTags(html))]
  for (const found of findMarked(html, COMPONENT_ATTR)) {
    const id = attrOf(found.el, COMPONENT_ATTR) ?? ''
    if (only && !only.has(id)) continue
    const def = store.getComponents(canvas.id).find((candidate) => candidate.id === id)
    if (!def) {
      /* pasted from a canvas that does not have this component: plain markup here */
      setAttr(found.el, COMPONENT_ATTR, null)
      edits.push({ start: found.start, end: found.end, text: serializeOuter(found.el) })
      ctx.issues.push({
        code: 'unknown_main',
        message: `a main for component ${id} was pasted here without its component, so it is plain markup`,
      })
      continue
    }
    /* frozen: the main of a deleted component is markup of this frame alone. An edit to it
       (an old client's save, a paste) changes neither the definition nor its status */
    if (isDeleted(def)) continue
    const mainElsewhere =
      def.mainFrameId !== null &&
      def.mainFrameId !== frameId &&
      !!store.getFrame(def.mainFrameId)?.html.includes(`${COMPONENT_ATTR}="${id}"`)
    if (claimed.has(id) || mainElsewhere || !frameId || def.source?.library) {
      /* a copy of a main is an instance, the way copying a Figma main is; and a
         library component's main lives on its library canvas, so one pasted
         here (it has no main of its own to be "elsewhere") is an instance too */
      const rendered = renderInstance(def, def, {}, '', { ctx, stack: [] })
      if (rendered) edits.push({ start: found.start, end: found.end, text: serializeOuter(rendered) })
      continue
    }
    claimed.add(id)
    const stamped = stampParts(found.el)
    if (stamped) edits.push({ start: found.start, end: found.end, text: serializeOuter(found.el) })
    const template = templateFromMain(found.el, ctx)
    if (wouldCycle(canvas.id, id, template)) {
      ctx.issues.push({
        code: 'nesting_cycle',
        message: `component “${def.name}” cannot contain itself; its change was not applied to other instances`,
      })
      continue
    }
    const variants = def.props.filter((prop) => prop.type === 'enum').map((prop) => `data-${prop.name}`)
    const { css, rawCss } = extractComponentCss(sheet(), found.el, id, variants)
    const head = headTags()
    const { props, slots } = derivePropsAndSlots(template, def.props)
    const same =
      def.template === template &&
      def.css === css &&
      JSON.stringify(def.head) === JSON.stringify(head) &&
      JSON.stringify(def.props) === JSON.stringify(props) &&
      JSON.stringify(def.slots) === JSON.stringify(slots)
    if (same && def.mainFrameId === frameId) continue
    /* a main coming back with the same content is not a new revision */
    const next: ComponentDef =
      same || def.rev === 0 || openRevisions.has(revisionKey(canvas.id, id))
        ? { ...def, rev: def.rev || 1, updatedAt: Date.now(), updatedBy: by }
        : bumpRevision(def, by)
    const saved = { ...next, template, css, rawCss, head, props, slots, mainFrameId: frameId }
    store.saveComponent(canvas.id, saved)
    if (!same) changed.push(saved)
    else moved.push(saved)
  }
  /* a main this frame held and no longer does: the component lives on without one */
  for (const def of only ? [] : store.getComponents(canvas.id)) {
    if (def.mainFrameId !== frameId || !frameId || claimed.has(def.id) || isDeleted(def)) continue
    if (html.includes(`${COMPONENT_ATTR}="${def.id}"`)) continue
    const saved = { ...def, mainFrameId: null, updatedAt: Date.now(), updatedBy: by }
    store.saveComponent(canvas.id, saved)
    moved.push(saved)
  }
  return { html: edits.length ? splice(html, edits) : html, changed, moved }
}

/**
 * Re-derive these definitions from their mains in this frame, as a write of the frame would,
 * and nothing else: no other main is looked at and no instance is rendered again. `html` is
 * the frame as the pass would leave it; it differs only where a main needed part keys.
 */
export function rederiveFromMains(
  canvas: Canvas,
  frameId: string,
  ids: ReadonlySet<string>,
  by: string,
): { html: string; saved: ComponentDef[] } {
  const frame = store.getFrame(frameId)
  if (!frame) return { html: '', saved: [] }
  const mains = prepareMains(canvas, frameId, frame.html, by, contextFor(canvas.id), ids)
  return { html: mains.html, saved: [...mains.changed, ...mains.moved] }
}

function prepareInstances(html: string, ctx: EngineContext) {
  const edits: { start: number; end: number; text: string }[] = []
  for (const found of findMarked(html, INSTANCE_ATTR)) {
    const id = attrOf(found.el, INSTANCE_ATTR) ?? ''
    const def = ctx.find(id)
    if (!def) {
      /* its component was deleted, or this came from another canvas: plain markup */
      for (const name of [INSTANCE_ATTR, REV_ATTR, PROPS_ATTR, OVERRIDES_ATTR]) setAttr(found.el, name, null)
      edits.push({ start: found.start, end: found.end, text: serializeOuter(found.el) })
      continue
    }
    /* its component was deleted: the instance keeps the markup it has, untouched. So does one
       holding an instance of a hollow component: rendered again, that instance would be lost */
    if (isDeleted(def) || holdsHollow(found.el, ctx)) continue
    const before = serializeOuter(found.el)
    const state = reconcileInstance(found.el, ctx)
    if (!state) continue
    /* only a whole write gets here: nothing more is coming for the content it holds */
    const rendered = renderInstance(def, def, state.overrides, state.instanceId, { ctx, stack: [], final: true })
    if (!rendered) continue
    /* the key it has is its place in what holds it (a main), not the component's own root key */
    setAttr(rendered, PART_ATTR, attrOf(found.el, PART_ATTR) ?? null)
    const after = serializeOuter(rendered)
    if (after !== before) edits.push({ start: found.start, end: found.end, text: after })
  }
  return edits.length ? splice(html, edits) : html
}

export interface PreparedHtml {
  html: string
  issues: ComponentIssue[]
  /** components whose main changed in this write: their other instances need updating */
  changed: ComponentDef[]
  /** components whose main only moved (here, or out of this frame): the room needs the new location */
  moved: ComponentDef[]
  /** components this write took up from the workspace library: the room needs them, and their tokens */
  adopted: ComponentDef[]
}

export function prepareFrameHtml(
  canvas: Canvas,
  frameId: string,
  incoming: string,
  by: string,
  priorHtml = '',
): PreparedHtml {
  if (!touchesComponents(incoming)) {
    const lost = frameId && priorHtml.includes(`${COMPONENT_ATTR}="`)
    const moved = lost ? prepareMains(canvas, frameId, incoming, by, contextFor(canvas.id)).moved : []
    return { html: incoming, issues: removedInstanceIssues(priorHtml, incoming), changed: [], moved, adopted: [] }
  }
  const adoption: LibraryAdoption = { by, added: [] }
  const ctx = contextFor(canvas.id, adoption)
  noteCanvas(canvas.id)
  try {
    const expanded = expandUses(incoming, ctx, [], 0, { final: true })
    const mains = prepareMains(canvas, frameId, expanded, by, ctx)
    const instances = prepareInstances(mains.html, ctx)
    const html = syncComponentHead(instances, closureOf(usedComponentIds(instances), canvas.id))
    return {
      html,
      issues: dedupeIssues([...ctx.issues, ...removedInstanceIssues(priorHtml, html)]),
      changed: mains.changed,
      moved: mains.moved,
      adopted: adoption.added,
    }
  } catch (error) {
    /* out of budget part of the way: the operation's write boundary (server/journal.ts)
       undoes a main folded into its definition and a component taken up from the library,
       so neither outlives the frame write that is now not happening.
       Markup nested past the call stack: the write itself still has to land */
    if (!(error instanceof RangeError)) throw error
    return {
      html: incoming,
      issues: [{ code: 'too_deep', message: 'this markup is nested too deeply for its components to be updated' }],
      changed: [],
      moved: [],
      adopted: adoption.added,
    }
  }
}

/* the leading space: an element's attribute, not a selector in a stylesheet */
const INSTANCE_ID = new RegExp(`\\s${INSTANCE_ATTR}="[^"]+"`, 'g')

function removedInstanceIssues(prior: string, next: string): ComponentIssue[] {
  if (!prior.includes(INSTANCE_ATTR)) return []
  const before = prior.match(INSTANCE_ID)?.length ?? 0
  const after = next.match(INSTANCE_ID)?.length ?? 0
  if (after >= before) return []
  const gone = before - after
  return [
    {
      code: 'instance_removed',
      message: `${gone} component instance${gone === 1 ? ' is' : 's are'} gone from this frame. If you meant to keep ${gone === 1 ? 'it' : 'them'}, write <doop-use> (get_frame shows it) rather than plain markup.`,
    },
  ]
}

export function dedupeIssues(issues: ComponentIssue[]): ComponentIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    if (seen.has(issue.message)) return false
    seen.add(issue.message)
    return true
  })
}

/** One chunk of a live stream: components render as they arrive, each stylesheet
 *  once and in place, since the head may already have gone by. The last chunk's
 *  full pass moves them where they belong. */
export function prepareChunk(
  canvas: Canvas,
  chunk: string,
  soFar: string,
  by: string,
): { html: string; issues: ComponentIssue[]; adopted: ComponentDef[] } {
  if (!chunk.toLowerCase().includes(`<${USE_TAG}`)) return { html: chunk, issues: [], adopted: [] }
  const adoption: LibraryAdoption = { by, added: [] }
  const ctx = contextFor(canvas.id, adoption)
  const expanded = expandUses(chunk, ctx)
  const styles = closureOf(usedComponentIds(expanded), canvas.id)
    .filter((def) => def.css.trim() && !soFar.includes(`${CSS_ATTR}="${def.id}"`))
    .map((def) => `<style ${CSS_ATTR}="${def.id}">\n${def.css}\n</style>`)
  /* a use expanded here is gone by the last chunk's pass: what it had to say is said now */
  return { html: `${styles.join('\n')}${expanded}`, issues: ctx.issues, adopted: adoption.added }
}

/** A blank component, before its main has been written: the first prepare fills it in. */
export function blankComponent(input: {
  id?: string
  name: string
  description?: string
  props?: ComponentProp[]
  code?: ComponentDef['code']
  source?: ComponentDef['source']
  by: string
}): ComponentDef {
  const now = Date.now()
  return {
    id: input.id ?? newComponentId(),
    name: input.name,
    description: input.description ?? '',
    template: '',
    css: '',
    rawCss: '',
    head: [],
    props: input.props ?? [],
    slots: [],
    rev: 0,
    mainFrameId: null,
    history: [],
    ...(input.code ? { code: input.code } : {}),
    ...(input.source ? { source: input.source } : {}),
    createdAt: now,
    updatedAt: now,
    updatedBy: input.by,
  }
}
