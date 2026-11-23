import { createHash } from 'node:crypto'
import { serializeOuter } from 'parse5'
import { indexOfAscii } from '../shared/asciiSearch.ts'
import {
  INSTANCE_ATTR,
  PART_ATTR,
  REV_ATTR,
  USE_TAG,
  isDeleted,
  isHollow,
  renderRevOf,
  type ComponentDef,
} from '../shared/components.ts'
import { ELEMENT_ID_ATTR, isElementId } from '../shared/elementId.ts'
import { componentClosure } from '../shared/frameCompose.ts'
import type { Canvas } from '../shared/types.ts'
import {
  LOST_USE_ATTR,
  UnrenderableUse,
  attrOf,
  contextOfDefs,
  expandUses,
  findMarked,
  holdsHollow,
  lostUsePlaceholder,
  placeholdUses,
  prepareInstances,
  reconcileInstance,
  renderInstance,
  reviveLostUses,
  setAttr,
  splice,
  useMarkup,
  type EngineContext,
} from './componentEngine.ts'
import { env } from './env.ts'

/**
 * A frame at rest and a frame awake. In memory and on the wire a frame's HTML is
 * its rendered source: every component instance written out in full, which is what
 * the room, comments, element ids, exports and the engine read. At rest (the
 * `frames.html` and `frame_versions.html` columns) an instance is a reference,
 * `<doop-use component="<id>" id="…" …>` with its props, overrides and slot content,
 * and is rendered from its component when the frame is read. So a change to a
 * component's markup rewrites no frame: a frame on a page nobody has open is
 * rendered at the component's current markup when the page is next read.
 *
 *  - `restingHtml`: rendered → at rest. An instance becomes a reference only when
 *    the reference, expanded right now, gives exactly the markup the write pipeline
 *    would hold for it (its edits reconciled into overrides, rendered at the current
 *    revision). Anything else stays written out: an instance of a component that is
 *    unknown, deleted, hollow or not yet stored, one that cannot render, one without
 *    an element id, one whose state does not survive the short form.
 *  - `wakingHtml`: at rest → rendered. A reference whose component cannot render
 *    is never dropped: a hollow definition falls back to its newest kept revision
 *    that has markup, and failing that the reference stays in the frame as a visible
 *    placeholder that keeps its text (`lostUsePlaceholder`), which the next save
 *    stores as the reference again. Instances stored written out (every frame from
 *    before this, and the ones kept back above) are brought up to their component's
 *    current revision, as the propagation queue used to do by rewriting them.
 *
 * Both read a mix of the two forms. `DOOP_COMPACT_FRAME_STORAGE=false` is the
 * temporary switch back to storing rendered HTML; reading is the same either way.
 */

/** Does this canvas keep its frames at rest as references? */
export function storesCompactly(canvas: Canvas | undefined): boolean {
  return env.DOOP_COMPACT_FRAME_STORAGE && !!canvas
}

export interface RestOptions {
  /** is this definition in the database as it stands? A reference to one that is not
   *  (its write still queued, or failed) would have nothing to render from after a
   *  restart, so its instances stay written out. Every definition, without it. */
  stored?: (def: ComponentDef) => boolean
}

/* What an instance's markup becomes at rest: its reference, or null to leave it written
   out. Kept by a hash of the markup, where it stands and the state of every definition it
   renders from, so a frame saved again pays only for the instances that changed. */
const MAX_KEPT_REFERENCES = 50_000
const references = new Map<string, string | null>()

function remember(key: string, reference: string | null) {
  references.set(key, reference)
  if (references.size <= MAX_KEPT_REFERENCES) return
  for (const oldest of references.keys()) {
    references.delete(oldest)
    if (references.size <= MAX_KEPT_REFERENCES * 0.9) break
  }
}

/** For a test or a benchmark that measures the work itself. */
export function forgetKeptReferences() {
  references.clear()
}

/** A context that renders or refuses: nothing is left out of what it renders. */
function strictContext(defs: readonly ComponentDef[]): EngineContext {
  return { ...contextOfDefs(() => defs), lost: () => UNRENDERED }
}

/* never equal to anything a component renders */
const UNRENDERED = '\u0000unrendered\u0000'

/** Can this reference be rendered whole from these definitions, everything its template
 *  nests included? A placeholder is only made a reference again for a write once it can: a
 *  write renders what it can and records what is missing as hidden, which would outlive the
 *  repair of the definition. */
export function rendersWhole(use: string, defs: readonly ComponentDef[]): boolean {
  try {
    return !expandUses(use, strictContext(defs), [], 0, { final: true }).includes(UNRENDERED)
  } catch {
    return false
  }
}

/* A definition is replaced, never changed in place (store.saveComponent), so the object is
   the state: each gets a number of its own the first time it is seen here. */
const serials = new WeakMap<ComponentDef, number>()
let nextSerial = 1

/** A number of its own for this state of a definition (the object: see above). */
export function definitionSerial(def: ComponentDef): number {
  return serialOf(def)
}

function serialOf(def: ComponentDef): number {
  let serial = serials.get(def)
  if (serial === undefined) serials.set(def, (serial = nextSerial++))
  return serial
}

/* every instance marker in a piece of markup: the instance itself, and the ones nested in it */
const INSTANCE_IDS = new RegExp(`\\s${INSTANCE_ATTR}="([^"]+)"`, 'g')

/** The state of everything this instance's markup renders from: its own component, the ones
 *  its template nests, and the ones placed in its slots and overrides, which its reference
 *  names too. Undefined when a definition it needs is not in the database yet: a reference
 *  is only as good as the rows it renders from after a restart. */
function signatureOf(text: string, defs: readonly ComponentDef[], options: RestOptions): string | undefined {
  const ids = new Set<string>()
  for (const match of text.matchAll(INSTANCE_IDS)) if (match[1]) ids.add(match[1])
  const closure = componentClosure([...ids], defs)
  if (options.stored && !closure.every(options.stored)) return undefined
  return closure.map(serialOf).join(',')
}

/**
 * The HTML a frame is stored as: each outermost instance as its reference, where that
 * is lossless (see the top of this file), the rest of the document byte for byte. A
 * placeholder for a reference that could not be rendered is stored as that reference.
 */
export function restingHtml(html: string, defs: readonly ComponentDef[], options: RestOptions = {}): string {
  if (!env.DOOP_COMPACT_FRAME_STORAGE) return html
  if (!html.includes(INSTANCE_ATTR)) return reviveLostUses(html)
  const ctx = contextOfDefs(() => defs)
  const strict = strictContext(defs)
  const edits: { start: number; end: number; text: string }[] = []
  for (const found of findMarked(html, INSTANCE_ATTR)) {
    const id = attrOf(found.el, INSTANCE_ATTR) ?? ''
    const def = defs.find((candidate) => candidate.id === id)
    if (!def || isDeleted(def) || isHollow(def)) continue
    const text = html.slice(found.start, found.end)
    const signature = signatureOf(text, defs, options)
    if (signature === undefined) continue
    /* where it stands: the parser reads the same markup differently inside a table */
    const parent = found.el.parentNode && 'tagName' in found.el.parentNode ? found.el.parentNode.tagName : ''
    const key = createHash('sha256').update(`${signature}\u0000${parent}\u0000${text}`).digest('base64')
    let reference = references.get(key)
    if (reference === undefined) {
      reference = referenceFor(found.el, def, ctx, strict) ?? null
      remember(key, reference)
    }
    if (reference !== null) edits.push({ start: found.start, end: found.end, text: reference })
  }
  return reviveLostUses(edits.length ? splice(html, edits) : html)
}

type InstanceElement = Parameters<typeof reconcileInstance>[0]

/** The reference for one instance, when expanding it now gives exactly what the write
 *  pipeline would hold for that instance. */
function referenceFor(
  el: InstanceElement,
  def: ComponentDef,
  ctx: EngineContext,
  strict: EngineContext,
): string | undefined {
  /* its id is what comments and links name: one without would get a new id on every read */
  if (!isElementId(attrOf(el, ELEMENT_ID_ATTR)) || holdsHollow(el, ctx)) return undefined
  try {
    const state = reconcileInstance(el, ctx)
    if (!state) return undefined
    const part = attrOf(el, PART_ATTR)
    const rendered = renderInstance(def, def, state.overrides, state.instanceId, {
      ctx: strict,
      stack: [],
    })
    if (!rendered) return undefined
    setAttr(rendered, PART_ATTR, part ?? null)
    const expected = serializeOuter(rendered)
    /* by id, so a rename cannot break it; with its place in a main and its element id */
    const reference = useMarkup(def.id, state, def, part, true)
    /* an instance of a deleted component placed in it (a slot, rewritten children) keeps the
       markup it has, which only the written-out form holds: read back as a reference it
       would render from whatever its own nested components had become */
    if (namesDeleted(reference, ctx)) return undefined
    return expandUses(reference, strict, [], 0, { final: true }) === expected ? reference : undefined
  } catch (error) {
    if (error instanceof UnrenderableUse) return undefined
    throw error
  }
}

const USE_REFS = new RegExp(`<${USE_TAG}\\s+component="([^"]+)"`, 'g')

function namesDeleted(reference: string, ctx: EngineContext): boolean {
  for (const match of reference.matchAll(USE_REFS)) if (isDeleted(ctx.find(match[1] ?? ''))) return true
  return false
}

/** Would these two documents be stored as the same HTML? */
export function sameAtRest(a: string, b: string, defs: readonly ComponentDef[]): boolean {
  return a === b || restingHtml(a, defs) === restingHtml(b, defs)
}

/* the two attributes as `markRoot` writes them, side by side */
export const INSTANCE_MARK = new RegExp(`\\s${INSTANCE_ATTR}="([^"]+)" ${REV_ATTR}="(\\d+)"`, 'g')

/** Does this document hold a written-out instance marked older than its component's markup? */
function holdsInstancesBehind(html: string, defs: readonly ComponentDef[]): boolean {
  if (!defs.length || !html.includes(INSTANCE_ATTR)) return false
  for (const match of html.matchAll(INSTANCE_MARK)) {
    const def = defs.find((candidate) => candidate.id === match[1])
    if (def && !isDeleted(def) && !isHollow(def) && Number(match[2]) < renderRevOf(def)) return true
  }
  return false
}

/** A hollow definition as its newest kept revision that still has markup: what its
 *  references render from until its main is written again. */
function fromKeptRevision(def: ComponentDef): ComponentDef | undefined {
  const kept = [...def.history].reverse().find((entry) => entry.template.trim())
  if (!kept) return undefined
  const { renderRev: _renderRev, ...rest } = def
  return {
    ...rest,
    template: kept.template,
    props: kept.props,
    rev: kept.rev,
    ...(kept.renderRev !== undefined ? { renderRev: kept.renderRev } : {}),
  }
}

export interface WakeReport {
  /** references kept as placeholders: nothing to render them from */
  lost: number
  /** hollow definitions rendered from a kept revision */
  revived: string[]
  /** instances stored written out on an older revision were brought up to date: what the
   *  row holds is behind what was read from it */
  upgraded?: boolean
}

/** The context stored HTML is read back with: nothing is dropped (`EngineContext.lost`). */
function wakingContext(defs: readonly ComponentDef[], where: string, report: WakeReport): EngineContext {
  const base = contextOfDefs(() => defs)
  const revived = new Map<string, ComponentDef | undefined>()
  return {
    ...base,
    find(ref) {
      const def = base.find(ref)
      if (!def || !isHollow(def)) return def
      if (!revived.has(def.id)) {
        const kept = fromKeptRevision(def)
        revived.set(def.id, kept)
        if (kept) {
          report.revived.push(def.id)
          console.error(
            `[frames] ${where}: component “${def.name}” (${def.id}) has lost its markup; its stored references are rendered from kept revision ${kept.rev}`,
          )
        }
      }
      return revived.get(def.id) ?? def
    },
    lost(use, ref, why) {
      report.lost++
      const def = base.find(ref)
      console.error(
        `[frames] ${where}: a stored reference to component “${def?.name ?? ref}” (${ref}) could not be rendered (${why}). It is kept in the frame as a placeholder and stored again as it was; repairing the definition restores it.`,
      )
      return lostUsePlaceholder(use, def?.name ?? ref)
    },
  }
}

/**
 * The rendered HTML for a frame read from storage, on a canvas with these components:
 * references written out at their components' current markup, and instances that were
 * stored written out brought up to it. `where` names the frame in what is logged. HTML
 * that holds neither comes back as it is, unparsed.
 */
export function wakingHtml(
  stored: string,
  defs: readonly ComponentDef[],
  where: string,
  report: WakeReport = { lost: 0, revived: [] },
): string {
  const references = holdsReferences(stored)
  if (!references && !holdsInstancesBehind(stored, defs)) return stored
  const ctx = wakingContext(defs, where, report)
  /* not `final`: a reference a stream left half written stays as text, as it was in memory */
  const expanded = references ? expandUses(stored, ctx) : stored
  if (!holdsInstancesBehind(expanded, defs)) return expanded
  try {
    const current = prepareInstances(expanded, ctx, { keepUnknown: true })
    report.upgraded = current !== expanded
    return current
  } catch (error) {
    /* over its budget, or markup the engine cannot walk: the instances stay on the revision
       they were stored at, as a frame the propagation queue skipped did, until its next write */
    console.error(`[frames] ${where}: instances stored on an older revision were left there`, error)
    return expanded
  }
}

/** Stored HTML with every reference kept as a placeholder, nothing rendered: what a frame
 *  is read as when rendering it failed, so its page still opens and nothing is lost (the
 *  next save stores the references again). */
export function placeheldHtml(stored: string, where: string): string {
  console.error(`[frames] ${where}: could not be rendered; its component references are shown as placeholders`)
  return placeholdUses(stored)
}

function holdsReferences(stored: string): boolean {
  return indexOfAscii(stored, `<${USE_TAG}`) !== -1 || stored.includes(LOST_USE_ATTR)
}

/** Is there anything for `wakingHtml` to do? A string scan: most frames need nothing. */
export function needsWaking(stored: string, defs: readonly ComponentDef[]): boolean {
  return holdsReferences(stored) || holdsInstancesBehind(stored, defs)
}
