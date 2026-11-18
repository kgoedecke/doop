import { serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { canvasPages, COMPONENTS_PAGE } from '../shared/pages.ts'
import {
  BIND_ATTR,
  COMPONENT_ATTR,
  INSTANCE_ATTR,
  OVERRIDES_ATTR,
  MAX_COMPONENTS,
  MAX_COMPONENT_DESCRIPTION,
  MAX_COMPONENT_NAME,
  PART_ATTR,
  PROP_TYPES,
  REV_ATTR,
  SLOT_ATTR,
  SOURCE_CSS_ATTR,
  USE_TAG,
  activeComponents,
  componentSignature,
  isDeleted,
  isPropName,
  type ComponentCode,
  type ComponentDef,
  type ComponentProp,
  type InstanceOverrides,
  type LibraryComponent,
  type PartOverride,
} from '../shared/components.ts'
import { ELEMENT_ID_ATTR } from '../shared/elementId.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import { decodeQuotes, familyKey, fontFaceRule, usesFamily, type CustomFont } from '../shared/fonts.ts'
import { fontsForCanvas } from './fonts.ts'
import * as actions from './actions.ts'
import { blankComponent, bumpRevision, contextFor, referencesComponent, withinRevision } from './components.ts'
import { unmatchedSelectors } from './componentCss.ts'
import {
  alignParts,
  attrOf,
  compactDocument,
  detachedMarkup,
  elementCount,
  findAllMarked,
  findMarked,
  inferBindings,
  innermost,
  isElement,
  kidsOf,
  measureTree,
  parseTemplateRoot,
  fitsIn,
  isTableContext,
  isTablePart,
  rootFragment,
  tableScaffold,
  partsOf,
  readInstance,
  renderInstance,
  setAttr,
  shapeOf,
  splice,
  stampParts,
  useMarkup,
  withDetachedCss,
} from './componentEngine.ts'
import {
  adoptFromLibrary,
  findInLibraries,
  isLibrary,
  LibraryAdoptError,
  libraryBlock,
  libraryChanges,
  librariesForCanvas,
  originOf,
  publishable,
  publishedOn,
  publishLibrary as writeLibrary,
  snapshotClosure,
  unpublishLibrary as dropLibrary,
  type LibraryChangeEntry,
} from './componentLibrary.ts'
import { env } from './env.ts'
import { resolveElement } from './elementIds.ts'
import * as propagation from './propagation.ts'
import { optional, parse, parseFragment, usage as workUsage, WorkBudgetError } from './workBudget.ts'
import { afterCommit, atomic, checkpoint, transaction } from './journal.ts'
import { usageByComponent, usageOf, type ComponentUsage } from './componentUsage.ts'
import { store } from './store.ts'
import { mayPublishLibrary } from './workspaces.ts'

/**
 * What a person or an agent can do with components. Each operation ends in an
 * ordinary frame write through actions.ts, so history, sign-off, the room and
 * propagation all behave as they do for any other edit. The MCP tools, the
 * resident agent and the REST routes share these, so they cannot drift apart.
 * Spec: .context/specs/components.md.
 */

export class ComponentError extends Error {}

/** A library action on a canvas that may not have one: personal, or in a
 *  workspace whose plan lapsed. Routes turn it into the upgrade prompt. */
export class LibraryPlanError extends ComponentError {
  constructor(
    message: string,
    /** the workspace that needs a plan; undefined when the canvas is in none */
    readonly workspaceId?: string,
  ) {
    super(message)
  }
}

/** Publishing where the workspace keeps it to its owner and admins. REST answers 403. */
export class LibraryPublisherError extends ComponentError {}

type Element = Tree.Element

function fail(message: string): never {
  throw new ComponentError(message)
}

/** A component in use, by id or name. A deleted one is not found here: see findDeletedComponent. */
export function findComponent(canvasId: string, ref: string): ComponentDef | undefined {
  const def = contextFor(canvasId).find(ref)
  return isDeleted(def) ? undefined : def
}

/** A soft-deleted component, by id or name (a name an active component has means that one). */
export function findDeletedComponent(canvasId: string, ref: string): ComponentDef | undefined {
  const def = contextFor(canvasId).find(ref)
  return isDeleted(def) ? def : undefined
}

function requireComponent(canvasId: string, ref: string): ComponentDef {
  const def = contextFor(canvasId).find(ref)
  if (def && !isDeleted(def)) return def
  if (def)
    fail(
      `“${def.name}” was deleted from this canvas. Its instances keep their look but no longer follow it. Restore it first (restore_component) to use or change it.`,
    )
  const names = activeComponents(store.getComponents(canvasId)).map((candidate) => candidate.name)
  fail(`no component “${ref}” on this canvas${names.length ? ` — it has: ${names.join(', ')}` : ''}`)
}

function requireFrame(canvasId: string, frameId: string): Frame {
  const frame = store.getFrame(frameId)
  if (!frame || frame.canvasId !== canvasId) fail(`no frame ${frameId} on this canvas`)
  return frame
}

function validName(name: string, canvasId: string, except?: string): string {
  const clean = name.replace(/["<>]/g, '').trim().slice(0, MAX_COMPONENT_NAME)
  if (!clean) fail('a component needs a name')
  /* a deleted component does not hold its name: restoring it finds another if it must */
  const taken = activeComponents(store.getComponents(canvasId)).some(
    (def) => def.id !== except && def.name.toLowerCase() === clean.toLowerCase(),
  )
  if (taken) fail(`this canvas already has a component named “${clean}” — update it, or pick another name`)
  return clean
}

/** The name itself when no component here has it, else "<name> (library)",
 *  "<name> (library 2)", … so two imports of a shared name stay apart. */
export function freeName(canvasId: string, name: string, label = 'library'): string {
  const names = new Set(activeComponents(store.getComponents(canvasId)).map((def) => def.name.toLowerCase()))
  if (!names.has(name.toLowerCase())) return name
  for (let n = 1; ; n++) {
    /* the suffix always fits: a name at the limit is shortened to make room, then checked */
    const suffix = n === 1 ? ` (${label})` : ` (${label} ${n})`
    const candidate = `${name.slice(0, MAX_COMPONENT_NAME - suffix.length).trimEnd()}${suffix}`
    if (!names.has(candidate.toLowerCase())) return candidate
  }
}

/** The @font-face rules an imported component carries along: faces of the
 *  library canvas's own fonts that its markup or CSS names and the target's
 *  library cannot supply, since the font pass there knows only that library. */
export function facesToCarry(
  origin: Pick<ComponentDef, 'template' | 'rawCss'>,
  sourceLibrary: readonly CustomFont[],
  targetLibrary: readonly CustomFont[],
): string {
  const have = new Set(targetLibrary.map((font) => familyKey(font.family)))
  const text = decodeQuotes(`${origin.template}\n${origin.rawCss}`)
  const used = new Map<string, boolean>()
  return sourceLibrary
    .filter((font) => {
      const key = familyKey(font.family)
      if (have.has(key)) return false
      if (!used.has(key)) used.set(key, usesFamily(text, font.family))
      return used.get(key)
    })
    .map(fontFaceRule)
    .join('\n')
}

function importedCss(targetCanvasId: string, sourceCanvasId: string, origin: ComponentDef): string {
  const target = store.getCanvas(targetCanvasId)
  const source = store.getCanvas(sourceCanvasId)
  if (!target || !source) return origin.rawCss
  const faces = facesToCarry(origin, fontsForCanvas(source), fontsForCanvas(target))
  return withCarriedFaces(origin.rawCss, faces)
}

/** A stylesheet's opening statements, which must stay first for the browser to
 *  honour them: @charset, @import and @layer statement lists. */
const LEADING_STATEMENTS = /^(?:\s*(?:@charset\s[^;]*;|@import\s[^;]*;|@layer\s[^{;]*;))*\s*/

/** The carried faces placed as the source canvas has them: after the sheet's
 *  leading @import statements (which the browser ignores once any other rule
 *  precedes them), before the component's own rules, so a face the CSS
 *  declares itself still wins. */
export function withCarriedFaces(rawCss: string, faces: string): string {
  if (!faces) return rawCss
  const lead = LEADING_STATEMENTS.exec(rawCss)?.[0] ?? ''
  const rest = rawCss.slice(lead.length)
  return `${lead}${lead && !lead.endsWith('\n') ? '\n' : ''}${faces}\n${rest}`
}

export function validProps(props: unknown): ComponentProp[] {
  if (props === undefined) return []
  if (!Array.isArray(props)) fail('props must be a list')
  return props.map((raw: Partial<ComponentProp>) => {
    if (!isPropName(raw?.name))
      fail(
        `prop name “${String(raw?.name)}” must be lowercase letters, digits and hyphens, and not one <doop-use> keeps for itself (component, id, class, style, overrides, slot, data-doop-*)`,
      )
    const type = raw.type ?? (raw.options?.length ? 'enum' : 'text')
    if (!PROP_TYPES.includes(type)) fail(`prop “${raw.name}” has unknown type “${String(type)}”`)
    if (type === 'enum' && !raw.options?.length) fail(`enum prop “${raw.name}” needs options`)
    return {
      name: raw.name,
      type,
      ...(raw.default !== undefined
        ? { default: String(raw.default) }
        : type === 'enum'
          ? { default: raw.options![0]! }
          : {}),
      ...(raw.options?.length ? { options: raw.options.map(String) } : {}),
      ...(raw.description ? { description: String(raw.description).slice(0, 300) } : {}),
    }
  })
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export { usageOf, type ComponentUsage }

export function usageExample(def: Pick<ComponentDef, 'name' | 'props' | 'slots'>): string {
  const props = def.props
    .filter((prop) => prop.type !== 'boolean')
    .slice(0, 4)
    .map((prop) => ` ${prop.name}="${prop.options?.[0] ?? `…`}"`)
    .join('')
  const slots = def.slots.map((slot) => `<template slot="${slot.name}">…</template>`).join('')
  return `<${USE_TAG} component="${def.name}"${props}>${slots}</${USE_TAG}>`
}

/** The catalog of a canvas (or of some of its components): usage for all of them comes from
 *  one pass over the canvas's frames, not one per component (server/componentUsage.ts). */
export function catalog(
  canvas: Canvas,
  defs: ComponentDef[] = activeComponents(canvas.components),
  usage = usageByComponent(canvas),
) {
  return defs.map((def) => catalogEntry(canvas, def, usage.get(def.id) ?? { instances: 0, frames: [] }))
}

/** Deleted components something on the canvas still shows: their instances keep their look
 *  and follow nothing, until the component is restored or they are detached. */
export function deletedComponentsInUse(canvas: Canvas, usage = usageByComponent(canvas)) {
  return (canvas.components ?? []).flatMap((def) => {
    const used = isDeleted(def) ? usage.get(def.id) : undefined
    return used?.instances
      ? [
          {
            id: def.id,
            name: def.name,
            instances: used.instances,
            frames: used.frames.length,
            deleted_by: def.deletedBy ?? '',
            deleted_at: new Date(def.deletedAt ?? def.updatedAt).toISOString(),
          },
        ]
      : []
  })
}

/** The one-line catalog entry: little to read, enough to use the component without another call. */
export function catalogEntry(canvas: Canvas, def: ComponentDef, usage = usageOf(canvas, def.id)) {
  return {
    id: def.id,
    name: def.name,
    signature: componentSignature(def),
    ...(def.description ? { description: def.description } : {}),
    usage: usageExample(def),
    instances: usage.instances,
    ...(def.source?.library ? libraryLink(def) : def.mainFrameId ? {} : { main_missing: true }),
    ...(def.code ? { code: def.code } : {}),
    ...updateAvailable(canvas, def),
  }
}

/** A component on another canvas, as something to import: what it is and how to
 *  use it. Not how often it is used there: counting reads that canvas's frame
 *  HTML, which is loaded per canvas and is not this caller's to load. */
export function importableEntry(def: ComponentDef) {
  return {
    id: def.id,
    name: def.name,
    signature: componentSignature(def),
    ...(def.description ? { description: def.description } : {}),
    usage: usageExample(def),
    ...(def.code ? { code: def.code } : {}),
  }
}

/** Where a linked component is changed: its library canvas, not here. */
function libraryLink(def: ComponentDef) {
  const canvasId = def.source!.canvasId
  return {
    library: {
      canvas_id: canvasId,
      name: store.getCanvas(canvasId)?.name ?? canvasId,
      /* the publication this follows; `rev` beside it counts changes on this canvas */
      rev: def.source!.rev,
    },
  }
}

function updateAvailable(canvas: Canvas, def: ComponentDef) {
  if (!def.source) return {}
  const origin = def.source.library
    ? originOf(canvas, def)
    : store.getComponents(def.source.canvasId).find((candidate) => candidate.id === def.source?.componentId)
  return origin && origin.rev > def.source.rev
    ? { library_update_available: { from_rev: def.source.rev, to_rev: origin.rev, canvas_id: def.source.canvasId } }
    : {}
}

export function componentDetail(canvas: Canvas, def: ComponentDef) {
  const parts = [...partsOf(def.template).entries()].map(([key, info]) => ({
    key,
    tag: info.el.tagName,
    ...(attrOf(info.el, 'class') ? { class: attrOf(info.el, 'class') } : {}),
    ...(info.textProp ? { text_prop: info.textProp } : {}),
    ...(info.isSlot ? { slot: attrOf(info.el, SLOT_ATTR) } : {}),
    ...(info.isUse ? { component: attrOf(info.el, 'component') } : {}),
  }))
  const usage = usageOf(canvas, def.id)
  return {
    ...catalogEntry(canvas, def, usage),
    rev: def.rev,
    props: def.props,
    slots: def.slots,
    /* what update_component's html and find/replace work on */
    template: def.template,
    css: def.rawCss,
    parts,
    main_frame_id: def.mainFrameId,
    main_image_url: def.mainFrameId ? `/i/${def.mainFrameId}.png?scale=2` : null,
    usage_by_frame: usage.frames,
    versions: def.history.map((entry) => ({ rev: entry.rev, saved_at: entry.savedAt, saved_by: entry.savedBy })),
    updated_by: def.updatedBy,
    updated_at: new Date(def.updatedAt).toISOString(),
  }
}

/** A frame's HTML the way agents read it. */
export function compactFrameHtml(frame: Frame): string {
  return compactDocument(frame.html, contextFor(frame.canvasId))
}

/** Every instance in a frame: what each is, its props, what it overrides. */
export function instancesIn(frame: Frame) {
  const ctx = contextFor(frame.canvasId)
  return findMarked(frame.html, INSTANCE_ATTR).flatMap((found) => {
    const id = attrOf(found.el, INSTANCE_ATTR)!
    const def = ctx.find(id)
    const state = readInstance(found.el, def, ctx)
    if (!state) return []
    return [
      {
        instance_id: state.instanceId,
        component: def?.name ?? id,
        /* its component was deleted: it keeps its look, follows nothing and takes no props */
        ...(isDeleted(def) ? { component_deleted: true } : {}),
        component_id: id,
        props: state.overrides.props ?? {},
        overridden_parts: Object.keys(state.overrides.parts ?? {}),
      },
    ]
  })
}

/* ------------------------------------------------------------------ */
/* Creating                                                            */
/* ------------------------------------------------------------------ */

export interface CreateFromElement {
  name: string
  description?: string
  props?: ComponentProp[]
  code?: ComponentCode
  frameId: string
  /** a data-doop-id, or an element path */
  element: string
  autoProps?: boolean
  /** also turn every other element of the same shape on the canvas into an instance */
  replaceMatching?: boolean
}

export interface CreateResult {
  component: ComponentDef
  converted: { frameId: string; instances: number }[]
  /** props named for the author, from what each element is: worth a look, and a rename */
  inferred: string[]
  /** replace_matching ran out of work budget part of the way: the component is made and
   *  `converted` lists what was linked, but frames after those were not looked at */
  matching_stopped?: true
}

function checkCapacity(canvasId: string) {
  if (activeComponents(store.getComponents(canvasId)).length >= MAX_COMPONENTS)
    fail(`a canvas holds at most ${MAX_COMPONENTS} components`)
}

/** An element named by its data-doop-id, whatever wrote it (Doop stamps six characters, an
 *  agent may write "me3-tabbar"), else by an element path (`body > main > section:nth-of-type(2)`).
 *  Only the six-character form was tried as an id, so an agent's own ids found nothing. */
function findElement(doc: Tree.Document, element: string): Element | undefined {
  const stack: Tree.ChildNode[] = [...doc.childNodes]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!isElement(node)) continue
    if (attrOf(node, ELEMENT_ID_ATTR) === element) return node
    stack.push(...node.childNodes)
  }
  return resolveElement(doc, element)
}

function withinInstance(el: Element): boolean {
  for (
    let node: Tree.ParentNode | null = el.parentNode;
    node && isElement(node as Element);
    node = (node as Element).parentNode
  ) {
    if (attrOf(node as Element, INSTANCE_ATTR) !== undefined) return true
  }
  return false
}

export const createComponentFromElement = atomic(function createComponentFromElement(
  canvasId: string,
  input: CreateFromElement,
  actor: Actor,
): CreateResult {
  checkCapacity(canvasId)
  const name = validName(input.name, canvasId)
  const props = validProps(input.props)
  const frame = requireFrame(canvasId, input.frameId)
  const located = locate(frame.html, input.element)
  if (!located) fail(`no element “${input.element}” in frame ${frame.id} — use a data-doop-id from get_frame`)
  const { el } = located
  if (['html', 'head', 'body'].includes(el.tagName)) fail('pick an element inside the page, not the whole document')
  if (attrOf(el, COMPONENT_ATTR)) fail('that element is already a component’s main')
  if (attrOf(el, INSTANCE_ATTR)) fail('that element is an instance — detach it first to make a new component from it')
  if (withinInstance(el)) fail('that element sits inside an instance — edit its main, or detach the instance first')

  const shape = shapeOf(el)
  const def = blankComponent({ name, description: clip(input.description), props, code: input.code, by: actor.name })
  /* one unit: a write that fails leaves no main-less component holding the name */
  const inferred = transaction(() => {
    store.saveComponent(canvasId, def)
    setAttr(el, COMPONENT_ATTR, def.id)
    stampParts(el)
    const bound = input.autoProps !== false && !hasBindings(el) ? inferBindings(el) : []
    const html = splice(frame.html, [{ start: located.start, end: located.end, text: serializeOuter(el) }])
    actions.updateFrame(frame.id, { html }, actor)
    actions.logComponent(canvasId, actor, `made “${requireComponent(canvasId, def.id).name}” a component`)
    return bound
  })
  const saved = requireComponent(canvasId, def.id)
  const matching = input.replaceMatching
    ? convertMatching(canvasId, shape, saved, actor)
    : { converted: [], stopped: false }
  return {
    component: requireComponent(canvasId, def.id),
    converted: matching.converted,
    inferred,
    ...(matching.stopped ? { matching_stopped: true as const } : {}),
  }
})

const clip = (text: string | undefined) => text?.slice(0, MAX_COMPONENT_DESCRIPTION)

function hasBindings(el: Element): boolean {
  /* on a <doop-use> it binds nothing, so it is no sign the author named their props */
  if (el.tagName === USE_TAG) return false
  if (attrOf(el, BIND_ATTR) !== undefined) return true
  return kidsOf(el).some(hasBindings)
}

function locate(html: string, element: string) {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const el = findElement(doc, element)
  const location = el?.sourceCodeLocation
  return el && location ? { el, start: location.startOffset, end: location.endOffset } : undefined
}

function mainFrameDoc(def: ComponentDef, root: string, rawCss: string): string {
  return `<!doctype html>
<html>
<head>
${def.head.join('\n')}
<style ${SOURCE_CSS_ATTR}="${def.id}">
${rawCss}
</style>
</head>
<body style="margin:0;padding:24px;background:transparent">
${tableScaffold(root)(root)}
</body>
</html>`
}

function componentsPageId(canvasId: string, actor: Actor): string {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  const pages = canvasPages(canvas)
  const existing = pages.find((page) => page.name === COMPONENTS_PAGE)
  if (existing) return existing.id
  const id = `page-${Date.now().toString(36)}`
  const next = actions.setCanvasPages(canvasId, [...pages, { id, name: COMPONENTS_PAGE }], actor)
  return next.find((page) => page.name === COMPONENTS_PAGE)?.id ?? pages[0]!.id
}

function singleRoot(html: string): Element {
  const roots = kidsOf(rootFragment(html.trim())).filter((el) => el.tagName !== 'style' && el.tagName !== 'script')
  if (roots.length === 1) return roots[0]!
  const wrapper = kidsOf(parseFragment(`<div>${html.trim()}</div>`))[0]
  if (!wrapper) fail('html must hold an element')
  return wrapper
}

export interface CreateFromHtml {
  name: string
  description?: string
  props?: ComponentProp[]
  code?: ComponentCode
  html: string
  css?: string
  width?: number
  height?: number
  autoProps?: boolean
}

/** A new design with nowhere to live yet: its main goes on the Components page, as a frame of its own. */
export const createComponentFromHtml = atomic(function createComponentFromHtml(
  canvasId: string,
  input: CreateFromHtml,
  actor: Actor,
): CreateResult {
  checkCapacity(canvasId)
  const name = validName(input.name, canvasId)
  const def = blankComponent({
    name,
    description: clip(input.description),
    props: validProps(input.props),
    code: input.code,
    by: actor.name,
  })
  /* nothing of a create that fails stays: the definition, the Components page it may have
     made and the main's frame are undone together (the unit this function is) */
  store.saveComponent(canvasId, def)
  const root = singleRoot(input.html)
  const inferred = input.autoProps !== false && !hasBindings(root) ? inferBindings(root) : []
  setAttr(root, COMPONENT_ATTR, def.id)
  writeNewMain(canvasId, def, serializeOuter(root), input.css ?? '', actor, input.width, input.height)
  const component = requireComponent(canvasId, def.id)
  /* the component is made: a note that cannot be worked out within budget is left out */
  if (input.css) optional(() => reportCssNotKept(component, input.css!))
  actions.logComponent(canvasId, actor, `created component “${name}”`)
  return { component, converted: [], inferred }
})

const MAX_SELECTORS_NAMED = 8

/** Rules handed over as a component's CSS that it did not keep: said in the result of the call
 *  that passed them, since the main's frame still shows them and nothing else would. */
function reportCssNotKept(def: ComponentDef, css: string) {
  const frame = def.mainFrameId ? store.getFrame(def.mainFrameId) : undefined
  const main = frame
    ? findMarked(frame.html, COMPONENT_ATTR).find((found) => attrOf(found.el, COMPONENT_ATTR) === def.id)
    : undefined
  if (!frame || !main) return
  const variants = def.props.filter((prop) => prop.type === 'enum').map((prop) => `data-${prop.name}`)
  const selectors = unmatchedSelectors(css, main.el, variants)
  if (!selectors.length) return
  const more = selectors.length - MAX_SELECTORS_NAMED
  const named = `${selectors.slice(0, MAX_SELECTORS_NAMED).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  actions.addComponentIssue(frame.id, {
    code: 'css_not_kept',
    message: `these CSS rules name nothing in “${def.name}” and were not kept: ${named}. A component keeps the rules for its own elements. To restyle a component nested in it, start the selector at one of its own elements (.card .btn), which applies inside this component only; to restyle that component everywhere, update_component it instead.`,
  })
}

function writeNewMain(
  canvasId: string,
  def: ComponentDef,
  root: string,
  rawCss: string,
  actor: Actor,
  width = 480,
  height = 240,
): Frame {
  /* one unit: when the main cannot be written, its empty frame (and a Components page made
     for it) does not stay behind */
  return transaction(() => {
    const pageId = componentsPageId(canvasId, actor)
    const frame = actions.createFrame(canvasId, { name: def.name, pageId, width, height, html: '' }, actor)
    if (!frame) fail('canvas not found')
    actions.updateFrame(frame.id, { html: mainFrameDoc(def, root, rawCss) }, actor)
    return store.getFrame(frame.id) ?? frame
  })
}

/* ------------------------------------------------------------------ */
/* Updating                                                            */
/* ------------------------------------------------------------------ */

export interface UpdateInput {
  name?: string
  description?: string
  props?: ComponentProp[]
  code?: ComponentCode | null
  html?: string
  css?: string
  /** a library pull only: the stylesheet and font tags its revision relies on */
  head?: string[]
  find?: string
  replace?: string
  expectedRev?: number
  dryRun?: boolean
}

export interface UpdateResult {
  component: ComponentDef
  dry_run: boolean
  /** what changing this does: read before a sweeping edit, or after to see what moved */
  impact: {
    instances: number
    frames: { id: string; name: string; instances: number; approved: boolean }[]
    approvals_affected: number
    overrides_orphaned: { frame_id: string; instance_id: string; parts: string[] }[]
    /** frames with overridden instances that were not examined, because reading them all
     *  would have used up the operation's work budget: overrides_orphaned may be missing some */
    overrides_unchecked_frames?: number
  }
  /** How the change reaches the instances in `impact.frames` (absent in a dry run):
   *  `queued` rewrites them in the background, a frame per tick; `deferred` means the
   *  server has propagation switched off and each frame follows on its own next write;
   *  `none` means nothing instances render from changed. */
  propagation?: { status: 'queued' | 'deferred' | 'none'; frames: number }
}

function propagationOf(canvasId: string, before: ComponentDef, impact: UpdateResult['impact']) {
  const after = requireComponent(canvasId, before.id)
  const frames = impact.frames.filter((frame) => frame.id !== after.mainFrameId).length
  if (actions.propagationPending(canvasId, before.id)) return { status: 'queued' as const, frames }
  const moved = after.rev !== before.rev && env.DOOP_DEFER_COMPONENT_PROPAGATION
  return moved ? { status: 'deferred' as const, frames } : { status: 'none' as const, frames: 0 }
}

/** The share of an operation's parse budget the impact report may use: the write it
 *  precedes needs the rest. */
const IMPACT_BUDGET_SHARE = 0.25

/** Instances whose overrides name a part the new template no longer has. Only frames that
 *  can hold one are parsed: frames using the component (from the usage index, no scan) whose
 *  instances either carry an overrides marker or fill a slot / nest a component at a part the
 *  new template drops. A plain restyle of a component with no overridden instance parses nothing. */
function orphanedOverrides(canvas: Canvas, def: ComponentDef, template: string, frames: ComponentUsage['frames']) {
  const keys = new Set(partsOf(template).keys())
  /* content read from the DOM rather than the marker (readInstance): held by every instance */
  const structuralGone = [...partsOf(def.template).entries()].some(
    ([key, info]) => (info.isSlot || info.isUse) && !keys.has(key),
  )
  const ctx = contextFor(canvas.id)
  const orphaned: UpdateResult['impact']['overrides_orphaned'] = []
  const limit = env.DOOP_WORK_BUDGET_PARSE_MB * 1024 * 1024 * IMPACT_BUDGET_SHARE
  const spentBefore = workUsage().parsedBytes
  let unchecked = 0
  for (const used of frames) {
    const frame = store.getFrame(used.id)
    if (!frame || (!structuralGone && !frame.html.includes(OVERRIDES_ATTR))) continue
    if (limit && workUsage().parsedBytes - spentBefore + frame.html.length > limit) {
      unchecked += 1
      continue
    }
    for (const found of findMarked(frame.html, INSTANCE_ATTR)) {
      if (attrOf(found.el, INSTANCE_ATTR) !== def.id) continue
      const state = readInstance(found.el, def, ctx)
      const parts = Object.keys(state?.overrides.parts ?? {}).filter((key) => !keys.has(key))
      if (state && parts.length) orphaned.push({ frame_id: frame.id, instance_id: state.instanceId, parts })
    }
  }
  return { orphaned, unchecked }
}

/** A rewrite of the main: old element keys carried over wherever tag and place line up,
 *  bindings and all, so overrides on instances survive an agent resending the markup. */
function alignedRoot(html: string, def: ComponentDef): Element {
  const root = singleRoot(html)
  alignParts(root, parseTemplateRoot(def.template))
  setAttr(root, COMPONENT_ATTR, def.id)
  return root
}

function nextHtml(def: ComponentDef, input: UpdateInput): string | undefined {
  if (input.find !== undefined) {
    const count = def.template.split(input.find).length - 1
    if (count === 0)
      fail(
        def.rawCss.includes(input.find)
          ? 'find text is in the CSS, and find + replace works on the template only — pass the whole changed stylesheet as css (get_component returns the current one)'
          : 'find text is not in the template — read it with get_component. find + replace works on the template markup only; CSS is replaced whole through css',
      )
    if (count > 1) fail(`find text occurs ${count} times — include more context so it matches once`)
    return def.template.replace(input.find, input.replace ?? '')
  }
  return input.html
}

export const updateComponent = atomic(function updateComponent(
  canvasId: string,
  ref: string,
  input: UpdateInput,
  actor: Actor,
): UpdateResult {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  const def = requireComponent(canvasId, ref)
  if (def.source?.library && !input.dryRun)
    fail(
      `“${def.name}” comes from the workspace library on canvas ${def.source.canvasId}: change it there and publish, then sync_component here. For one instance that must differ, use update_instances.`,
    )
  if (input.expectedRev !== undefined && input.expectedRev !== def.rev)
    fail(
      `component “${def.name}” is at revision ${def.rev}, not ${input.expectedRev} — someone changed it; read it again`,
    )
  const html = nextHtml(def, input)
  const nextRoot = html !== undefined ? alignedRoot(html, def) : undefined
  const usage = usageOf(canvas, def.id)
  const overrides = nextRoot
    ? orphanedOverrides(canvas, def, stampedTemplate(nextRoot), usage.frames)
    : { orphaned: [], unchecked: 0 }
  const impact: UpdateResult['impact'] = {
    instances: usage.instances,
    frames: usage.frames,
    approvals_affected: usage.frames.filter((frame) => frame.approved).length,
    overrides_orphaned: overrides.orphaned,
    ...(overrides.unchecked ? { overrides_unchecked_frames: overrides.unchecked } : {}),
  }
  if (input.dryRun) return { component: def, dry_run: true, impact }

  const nextProps = input.props !== undefined ? validProps(input.props) : undefined
  const propsChanged = nextProps !== undefined && JSON.stringify(nextProps) !== JSON.stringify(def.props)
  /* this function is one unit (server/journal.ts): a refusal anywhere in it, the work budget
     included, undoes the name, props and revision saved below along with the main's write */
  const writesMain = nextRoot !== undefined || input.css !== undefined || input.props !== undefined
  const root = writesMain ? (nextRoot ?? alignedRoot(def.template, def)) : undefined
  const meta: ComponentDef = {
    ...(propsChanged ? bumpRevision(def, actor.name) : def),
    ...(input.name !== undefined ? { name: validName(input.name, canvasId, def.id) } : {}),
    ...(input.description !== undefined ? { description: clip(input.description) ?? '' } : {}),
    ...(nextProps ? { props: nextProps } : {}),
    ...(input.head ? { head: input.head } : {}),
    updatedAt: Date.now(),
    updatedBy: actor.name,
  }
  if (input.code === null) delete meta.code
  else if (input.code !== undefined) meta.code = input.code
  store.saveComponent(canvasId, meta)

  if (root) {
    const write = () => writeMain(canvasId, meta, root, input.css, actor, input.head ? def.head : undefined)
    /* the props above opened a revision: the main's write is the rest of it, not another */
    if (propsChanged) withinRevision(canvasId, def.id, write)
    else write()
  } else actions.broadcastComponent(canvasId, requireComponent(canvasId, def.id), actor)
  /* new defaults change what instances render even when the main's markup did not move */
  if (propsChanged) actions.queuePropagation(canvasId, [requireComponent(canvasId, def.id)], actor)
  if (input.name !== undefined && def.mainFrameId && store.getFrame(def.mainFrameId)?.name === def.name) {
    actions.updateFrame(def.mainFrameId, { name: meta.name }, actor)
  }
  /* the update has landed: a note that cannot be worked out within budget is left out,
     never turned into a refusal of what is already done */
  if (input.css) optional(() => reportCssNotKept(requireComponent(canvasId, def.id), input.css!))
  actions.logComponent(canvasId, actor, `updated component “${meta.name}”`)
  return {
    component: requireComponent(canvasId, def.id),
    dry_run: false,
    impact,
    propagation: propagationOf(canvasId, def, impact),
  }
})

function stampedTemplate(root: Element): string {
  const clone = kidsOf(rootFragment(serializeOuter(root)))[0]!
  stampParts(clone)
  return serializeOuter(clone)
}

/** Put new markup in the main's place, or give the component a new main if it lost it. */
const leadingTagOf = (markup: string) => /<([a-z][\w-]*)/i.exec(markup)?.[1]?.toLowerCase() ?? 'element'

function writeMain(
  canvasId: string,
  def: ComponentDef,
  root: Element,
  css: string | undefined,
  actor: Actor,
  replacedHead?: string[],
) {
  const frame = def.mainFrameId ? store.getFrame(def.mainFrameId) : undefined
  const rendered = serializeOuter(root)
  const located = frame
    ? findMarked(frame.html, COMPONENT_ATTR).find((found) => attrOf(found.el, COMPONENT_ATTR) === def.id)
    : undefined
  if (!frame || !located) {
    writeNewMain(canvasId, def, rendered, css ?? def.rawCss, actor)
    return
  }
  /* a main that becomes a table part gets a table around it where it stands; one that stops being
     one cannot stay in the row that holds it */
  const parent = located.el.parentNode && 'tagName' in located.el.parentNode ? located.el.parentNode.tagName : 'body'
  let text = rendered
  if (!fitsIn(rendered, parent)) {
    /* outside any table a new table can go where the main stood; inside one it would break it */
    if (isTablePart(rendered) && !isTableContext(parent)) text = tableScaffold(rendered)(rendered)
    else
      fail(
        `the main of “${def.name}” sits inside a <${parent}>, which cannot hold a <${leadingTagOf(rendered)}>: keep a root a <${parent}> can hold (it is a <${located.el.tagName}> now), or move the main out of the table first`,
      )
  }
  let html = splice(frame.html, [{ start: located.start, end: located.end, text }])
  if (css !== undefined) html = withSourceCss(html, def.id, css)
  if (replacedHead) html = withHeadTags(html, replacedHead, def.head)
  actions.updateFrame(frame.id, { html }, actor)
}

/** The main's frame is where a component's head tags are read from, so that is where new ones go. */
function withHeadTags(html: string, previous: string[], next: string[]): string {
  let out = html
  for (const tag of previous) if (!next.includes(tag)) out = out.replace(tag, '')
  const missing = next.filter((tag) => !out.includes(tag))
  if (!missing.length) return out
  const head = /<\/head\s*>/i.exec(out)
  const block = `${missing.join('\n')}\n`
  return head ? `${out.slice(0, head.index)}${block}${out.slice(head.index)}` : `${block}${out}`
}

function withSourceCss(html: string, id: string, css: string): string {
  const block = `<style ${SOURCE_CSS_ATTR}="${id}">\n${css}\n</style>`
  const existing = new RegExp(`<style[^>]*\\b${SOURCE_CSS_ATTR}="${id}"[^>]*>[\\s\\S]*?</style>`, 'i')
  if (existing.test(html)) return html.replace(existing, () => block)
  const head = /<\/head\s*>/i.exec(html)
  return head ? `${html.slice(0, head.index)}${block}\n${html.slice(head.index)}` : `${block}\n${html}`
}

export function restoreComponentVersion(canvasId: string, ref: string, rev: number, actor: Actor): UpdateResult {
  const def = requireComponent(canvasId, ref)
  const snapshot = def.history.find((entry) => entry.rev === rev)
  if (!snapshot) {
    const kept = def.history.map((entry) => entry.rev).join(', ')
    fail(`revision ${rev} of “${def.name}” is not kept${kept ? ` — kept: ${kept}` : ''}`)
  }
  return updateComponent(
    canvasId,
    def.id,
    { html: snapshot.template, css: snapshot.rawCss, head: snapshot.head, props: snapshot.props },
    actor,
  )
}

/* ------------------------------------------------------------------ */
/* Instances                                                           */
/* ------------------------------------------------------------------ */

export type InstancePosition = 'append' | 'prepend' | 'before' | 'after'

export interface InsertInput {
  frameId: string
  component: string
  props?: Record<string, string>
  /** inside or beside this element (a data-doop-id or selector); the page body when unset */
  target?: string
  position?: InstancePosition
}

function useFor(def: ComponentDef, props: Record<string, string> | undefined, instanceId = ''): string {
  const state = { instanceId, componentId: def.id, rev: def.rev, overrides: props ? { props } : {} }
  return useMarkup(def.name, state, def, undefined)
}

export const insertInstance = atomic(function insertInstance(
  canvasId: string,
  input: InsertInput,
  actor: Actor,
): { frame: Frame; instanceId: string } {
  const def = requireComponent(canvasId, input.component)
  const frame = requireFrame(canvasId, input.frameId)
  const markup = useFor(def, input.props)
  const position = input.position ?? 'append'
  const html = insertAt(frame.html, markup, input.target, position)
  const before = new Set(instanceIds(frame.html))
  const next = actions.updateFrame(frame.id, { html }, actor)
  if (!next) fail('frame not found')
  /* the instance is placed: if its id cannot be read back within budget, get_frame has it */
  const instanceId = optional(() => instanceIds(next.html).find((id) => !before.has(id))) ?? ''
  return { frame: next, instanceId }
})

function instanceIds(html: string): string[] {
  return findMarked(html, INSTANCE_ATTR).flatMap((found) => attrOf(found.el, ELEMENT_ID_ATTR) ?? [])
}

function insertAt(html: string, markup: string, target: string | undefined, position: InstancePosition): string {
  if (target) {
    const doc = parse(html, { sourceCodeLocationInfo: true })
    const el = findElement(doc, target)
    const location = el?.sourceCodeLocation
    if (!location) fail(`no element “${target}” in this frame — use a data-doop-id from get_frame`)
    if (position === 'before')
      return splice(html, [{ start: location.startOffset, end: location.startOffset, text: markup }])
    if (position === 'after')
      return splice(html, [{ start: location.endOffset, end: location.endOffset, text: markup }])
    if (!location.startTag) fail('that element has no source tag to insert into')
    if (position === 'prepend')
      return splice(html, [{ start: location.startTag.endOffset, end: location.startTag.endOffset, text: markup }])
    const at = location.endTag?.startOffset ?? location.endOffset
    return splice(html, [{ start: at, end: at, text: markup }])
  }
  const bodyClose = /<\/body\s*>/i.exec(html)
  if (position === 'prepend') {
    const bodyOpen = /<body\b[^>]*>/i.exec(html)
    if (bodyOpen) {
      const at = bodyOpen.index + bodyOpen[0].length
      return splice(html, [{ start: at, end: at, text: markup }])
    }
  }
  if (bodyClose) return splice(html, [{ start: bodyClose.index, end: bodyClose.index, text: markup }])
  return html + markup
}

export interface InstanceChange {
  instanceId: string
  /** merged over current props; "" clears one back to the component's value */
  props?: Record<string, string>
  /** merged per part: { "<part key>": { style: { color: "red" }, text: "…", hidden: true } } */
  overrides?: Record<string, PartOverride>
  /** true clears everything; a list clears those parts */
  reset?: boolean | string[]
  detach?: boolean
}

function applyChange(state: InstanceOverrides, change: InstanceChange): InstanceOverrides {
  let parts = { ...state.parts }
  let props = { ...state.props }
  if (change.reset === true) {
    parts = {}
    props = {}
  } else if (Array.isArray(change.reset)) for (const key of change.reset) delete parts[key]
  for (const [name, value] of Object.entries(change.props ?? {})) {
    if (value === '') delete props[name]
    else props[name] = value
  }
  for (const [key, part] of Object.entries(change.overrides ?? {})) parts[key] = { ...parts[key], ...part }
  return {
    ...(Object.keys(props).length ? { props } : {}),
    ...(Object.keys(parts).length ? { parts } : {}),
  }
}

/** One frame write however many instances change, so the whole batch is one undo step. */
export const changeInstances = atomic(function changeInstances(
  canvasId: string,
  frameId: string,
  changes: InstanceChange[],
  actor: Actor,
): { frame: Frame; missing: string[] } {
  const frame = requireFrame(canvasId, frameId)
  const ctx = contextFor(canvasId)
  const pending = new Map(changes.map((change) => [change.instanceId, change]))
  const seen = new Set<string>()
  let html = frame.html
  /* innermost first, a pass at a time: a change inside an instance is read back by the one around it */
  for (;;) {
    const found = findAllMarked(html, INSTANCE_ATTR).filter((el) => pending.has(attrOf(el.el, ELEMENT_ID_ATTR) ?? ''))
    if (!found.length) break
    const edits: { start: number; end: number; text: string }[] = []
    const detached: ComponentDef[] = []
    for (const located of innermost(found)) {
      const id = attrOf(located.el, ELEMENT_ID_ATTR) ?? ''
      const change = pending.get(id)!
      pending.delete(id)
      seen.add(id)
      const def = ctx.find(attrOf(located.el, INSTANCE_ATTR)!)
      if (change.detach) {
        if (def) detached.push(def)
        edits.push({ start: located.start, end: located.end, text: detachedMarkup(located.el, def) })
        continue
      }
      if (!def) continue
      if (isDeleted(def))
        fail(
          `“${def.name}” was deleted, so this instance no longer follows anything and cannot take props or overrides. Restore the component (restore_component), or detach the instance and edit it as plain markup.`,
        )
      const state = readInstance(located.el, ctx.atRev(def.id, Number(attrOf(located.el, REV_ATTR))) ?? def, ctx)
      if (!state) continue
      validateProps(def, change.props)
      const rendered = renderInstance(def, def, applyChange(state.overrides, change), id, { ctx, stack: [] })
      if (!rendered) continue
      /* below another instance, this root is that instance's part */
      const part = attrOf(located.el, PART_ATTR)
      if (part) setAttr(rendered, PART_ATTR, part)
      edits.push({ start: located.start, end: located.end, text: serializeOuter(rendered) })
    }
    html = detached.reduce(withDetachedCss, splice(html, edits))
  }
  const next = html !== frame.html ? actions.updateFrame(frame.id, { html }, actor) : frame
  if (!next) fail('frame not found')
  return { frame: next, missing: changes.map((change) => change.instanceId).filter((id) => !seen.has(id)) }
})

/** Every instance of one component in this markup, cut loose with its look. */
function detachAll(html: string, def: ComponentDef): { html: string; count: number } {
  let next = html
  let count = 0
  for (;;) {
    const found = findAllMarked(next, INSTANCE_ATTR).filter((el) => attrOf(el.el, INSTANCE_ATTR) === def.id)
    if (!found.length) return { html: count ? withDetachedCss(next, def) : next, count }
    const batch = innermost(found)
    count += batch.length
    next = splice(
      next,
      batch.map((located) => ({ start: located.start, end: located.end, text: detachedMarkup(located.el, def) })),
    )
  }
}

function validateProps(def: ComponentDef, props: Record<string, string> | undefined) {
  for (const [name, value] of Object.entries(props ?? {})) {
    const prop = def.props.find((candidate) => candidate.name === name)
    if (!prop)
      fail(`${def.name} has no prop “${name}” — it has ${def.props.map((p) => p.name).join(', ') || 'no props'}`)
    if (value !== '' && prop.type === 'enum' && prop.options?.length && !prop.options.includes(value))
      fail(`${def.name}: "${value}" is not a value of ${name} — use ${prop.options.join(' | ')}`)
  }
}

export interface DetachQueued {
  /** false when nothing on the canvas uses the component */
  queued: boolean
  instances: number
  frames: number
}

/**
 * Delete a component, softly: the definition is kept and marked deleted, and NO frame is
 * written. Its instances keep the markup they have, byte for byte, and stop following
 * anything; new uses are refused; a component built from it keeps rendering as it did. The
 * main's markup stays where it is, frozen (an edit to it is an edit to that frame only).
 * restoreComponent undoes it. Cutting the instances loose is its own act: detachAllInstances.
 */
export const deleteComponent = atomic(function deleteComponent(canvasId: string, ref: string, actor: Actor) {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  const already = findDeletedComponent(canvasId, ref)
  if (already) fail(`“${already.name}” is already deleted — restore_component brings it back`)
  const def = requireComponent(canvasId, ref)
  const usage = usageOf(canvas, def.id)
  const deleted: ComponentDef = { ...def, status: 'deleted', deletedAt: Date.now(), deletedBy: actor.name }
  store.saveComponent(canvasId, deleted)
  actions.broadcastComponent(canvasId, deleted, actor)
  const kept = usage.instances
  actions.logComponent(
    canvasId,
    actor,
    `deleted component “${def.name}”${kept ? `; ${kept} instance${kept === 1 ? ' keeps its' : 's keep their'} look` : ''}`,
  )
  return { deleted: def.name, component_id: def.id, instances_kept: kept, frames: usage.frames.length }
})

export interface RestoreResult {
  component: ComponentDef
  /** `kept`: its main was still on the canvas; `written`: a new main was made from the
   *  definition; `none`: it comes from a workspace library and has no main here */
  main: 'kept' | 'written' | 'none'
}

/** Bring a deleted component back. Its instances were never changed, so they follow it again
 *  as they are. The main is the markup that still carries its marker if any does (edits made
 *  to it while the component was deleted become a new revision, like any edit of a main);
 *  otherwise a main is written from the kept definition. */
export const restoreComponent = atomic(function restoreComponent(
  canvasId: string,
  ref: string,
  actor: Actor,
): RestoreResult {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  const def = findDeletedComponent(canvasId, ref)
  if (!def) {
    const active = findComponent(canvasId, ref)
    fail(
      active
        ? `“${active.name}” is not deleted, so there is nothing to restore`
        : `no deleted component “${ref}” on this canvas`,
    )
  }
  checkCapacity(canvasId)
  const marker = `${COMPONENT_ATTR}="${def.id}"`
  const remembered = def.mainFrameId ? store.getFrame(def.mainFrameId) : undefined
  const home = [remembered, ...canvas.frames].find((frame) => frame?.html.includes(marker))
  const { status: _status, deletedAt: _deletedAt, deletedBy: _deletedBy, ...kept } = def
  const active: ComponentDef = {
    ...kept,
    /* its name may have been given to another component since */
    name: freeName(canvasId, def.name, 'restored'),
    mainFrameId: home?.id ?? null,
    updatedAt: Date.now(),
    updatedBy: actor.name,
  }
  /* one unit: when no main can be written (the work budget) it stays deleted, not half back */
  store.saveComponent(canvasId, active)
  let main: RestoreResult['main'] = 'none'
  if (active.source?.library) main = 'none'
  else if (home) {
    /* an ordinary write of the frame as it is: the main is read again, so what it holds
       now and the definition agree, and a difference reaches the instances */
    actions.updateFrame(home.id, { html: home.html }, actor)
    main = 'kept'
  } else {
    writeMain(canvasId, active, alignedRoot(active.template, active), undefined, actor)
    main = 'written'
  }
  const component = requireComponent(canvasId, def.id)
  actions.broadcastComponent(canvasId, component, actor)
  actions.logComponent(canvasId, actor, `restored component “${component.name}”`)
  return { component, main }
})

/** Cut every instance of a component loose, keeping its look: plain markup, no longer linked.
 *  Runs in the background queue, a frame per tick (server/propagation.ts), so it returns
 *  what it queued, not what it did. For a deleted component this is how its leftovers stop
 *  being instances; for one in use it leaves the component with none. */
export function detachAllInstances(canvasId: string, ref: string, actor: Actor): DetachQueued {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  const def = findDeletedComponent(canvasId, ref) ?? requireComponent(canvasId, ref)
  const usage = usageOf(canvas, def.id)
  /* queued with the commit of the operation that asked */
  if (usage.instances) afterCommit(() => propagation.enqueue('detach', canvasId, [def.id], actor))
  return { queued: usage.instances > 0, instances: usage.instances, frames: usage.frames.length }
}

/** One frame's turn in the detach queue: an ordinary write, so history is filed, sign-off on
 *  an approved frame goes back to review and the room sees it. */
function detachInFrame(
  canvasId: string,
  frameId: string,
  componentIds: string[],
  actor: Actor,
): propagation.FrameOutcome {
  const frame = store.getFrame(frameId)
  if (!frame || frame.canvasId !== canvasId) return {}
  /* a frame an agent is streaming into is not rewritten under it. The request is kept until
     the stream closes (actions.finishStream resumes it), not dropped and not retried meanwhile */
  if (actions.isFrameMidStream(frameId)) return { defer: true }
  let html = frame.html
  let count = 0
  for (const id of componentIds) {
    const def = store.getComponents(canvasId).find((candidate) => candidate.id === id)
    if (!def || !referencesComponent(html, id)) continue
    const cut = detachAll(html, def)
    html = cut.html
    count += cut.count
  }
  if (!count) return {}
  const wasApproved = frame.approval?.status === 'ready_for_dev'
  const updated = actions.updateFrame(frame.id, { html }, actor)
  if (!updated) return {}
  return { count, touched: { id: updated.id, name: updated.name, approvalLost: wasApproved } }
}

function detachDrained(canvasId: string, report: propagation.DrainReport, actor: Actor) {
  if (!report.count) return
  const names = report.components.flatMap((id) => {
    const def = store.getComponents(canvasId).find((candidate) => candidate.id === id)
    return def ? [`“${def.name}”`] : []
  })
  const frames = report.frames.length
  actions.logComponent(
    canvasId,
    actor,
    `detached ${report.count} instance${report.count === 1 ? '' : 's'} of ${names.join(', ')} in ${frames} frame${frames === 1 ? '' : 's'}; ${report.count === 1 ? 'it keeps its' : 'they keep their'} look as plain markup`,
  )
}

propagation.registerFrameTask('detach', { frame: detachInFrame, drained: detachDrained })

/* ------------------------------------------------------------------ */
/* Finding what should be a component                                  */
/* ------------------------------------------------------------------ */

interface Occurrence {
  frame: Frame
  el: Element
}

const NOT_CANDIDATES = new Set([
  'svg',
  'path',
  'style',
  'script',
  'html',
  'head',
  'body',
  'br',
  'hr',
  'option',
  'title',
  'meta',
  'link',
])

function collectShapes(canvas: Canvas): { shapes: Map<string, Occurrence[]>; sizes: Map<Element, number> } {
  const shapes = new Map<string, Occurrence[]>()
  const sizes = new Map<Element, number>()
  for (const frame of canvas.frames) {
    if (frame.demo) continue
    const doc = parse(frame.html, { sourceCodeLocationInfo: true })
    const measured = measureTree(doc)
    const stack: Tree.ChildNode[] = [...doc.childNodes]
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (!isElement(node)) continue
      if (attrOf(node, INSTANCE_ATTR) !== undefined || attrOf(node, COMPONENT_ATTR) !== undefined) continue
      if (node.tagName === 'svg' || node.tagName === 'head' || node.tagName === 'style' || node.tagName === 'script')
        continue
      stack.push(...node.childNodes)
      if (NOT_CANDIDATES.has(node.tagName)) continue
      const info = measured.get(node)
      /* something worth naming: styled, or more than a lone tag */
      if (!info?.shape || (info.size < 2 && !attrOf(node, 'class'))) continue
      sizes.set(node, info.size)
      const list = shapes.get(info.shape)
      if (list) list.push({ frame, el: node })
      else shapes.set(info.shape, [{ frame, el: node }])
    }
  }
  return { shapes, sizes }
}

function pathTo(el: Element): string {
  const steps: string[] = []
  let node: Element | undefined = el
  while (node && node.tagName !== 'html') {
    const parent: Tree.ParentNode | null = node.parentNode
    if (!parent) break
    const tag: string = node.tagName
    const nth = kidsOf(parent)
      .filter((kid) => kid.tagName === tag)
      .indexOf(node)
    steps.unshift(`${tag}:nth-of-type(${nth + 1})`)
    node = isElement(parent as Element) ? (parent as Element) : undefined
  }
  return steps.join(' > ')
}

function textSample(el: Element): string {
  const parts: string[] = []
  const stack: Tree.ChildNode[] = [...el.childNodes].reverse()
  for (let node = stack.pop(); node && parts.join(' ').length < 80; node = stack.pop()) {
    if (node.nodeName === '#text') parts.push((node as Tree.TextNode).value.trim())
    else if (isElement(node)) stack.push(...[...node.childNodes].reverse())
  }
  return parts.filter(Boolean).join(' ').slice(0, 80)
}

function suggestedName(el: Element): string {
  const fromClass = attrOf(el, 'class')
    ?.split(/\s+/)
    .find((name) => /^[a-zA-Z][a-zA-Z-]{2,}$/.test(name) && !/^(flex|grid|block|inline|relative|absolute)/.test(name))
  const raw = attrOf(el, 'data-name') ?? fromClass ?? el.tagName
  return raw
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Repeated structures on a canvas, largest payoff first: what an agent or a person
 *  should turn into components, typically in a canvas that grew without any. Groups
 *  under `minOccurrences`, or spread over fewer than `minFrames` frames, never hide the
 *  repeats inside them. */
export function findComponentCandidates(canvas: Canvas, limit = 12, minOccurrences = 2, minFrames = 1) {
  const { shapes, sizes } = collectShapes(canvas)
  const groups = [...shapes]
    .filter(([, occurrences]) => occurrences.length >= minOccurrences)
    .map(([shape, occurrences]) => ({ shape, occurrences, size: sizes.get(occurrences[0]!.el) ?? 1 }))
    .sort((a, b) => b.size * b.occurrences.length - a.size * a.occurrences.length)
  const covered = new Set<Element>()
  const candidates: ReturnType<typeof describeCandidate>[] = []
  for (const group of groups) {
    const fresh = group.occurrences.filter((occurrence) => !covered.has(occurrence.el))
    if (fresh.length < minOccurrences) continue
    if (new Set(fresh.map((occurrence) => occurrence.frame.id)).size < minFrames) continue
    /* everything inside a repeated block is repeated as well: the block is the finding */
    for (const occurrence of fresh) markCovered(occurrence.el, covered)
    candidates.push(describeCandidate(group.shape, fresh, group.size))
    if (candidates.length >= limit) break
  }
  return candidates
}

function markCovered(el: Element, covered: Set<Element>) {
  const stack = [el]
  for (let next = stack.pop(); next; next = stack.pop()) {
    covered.add(next)
    stack.push(...kidsOf(next))
  }
}

function describeCandidate(shape: string, occurrences: Occurrence[], size: number) {
  const first = occurrences[0]!
  return {
    suggested_name: suggestedName(first.el),
    occurrences: occurrences.length,
    frames: new Set(occurrences.map((occurrence) => occurrence.frame.id)).size,
    elements_each: size,
    sample_text: textSample(first.el),
    example: { frame_id: first.frame.id, frame_name: first.frame.name, element: pathTo(first.el) },
    shape: shape.slice(0, 160),
  }
}

function convertMatching(canvasId: string, shape: string | undefined, def: ComponentDef, actor: Actor) {
  const canvas = store.getCanvas(canvasId)
  const converted: CreateResult['converted'] = []
  if (!canvas || !shape) return { converted, stopped: false }
  /* a sub-commit: the component is made and stays, whatever becomes of the matching */
  checkpoint()
  try {
    const template = parseTemplateRoot(def.template)
    if (!template) return { converted, stopped: false }
    convertFrames(canvas, shape, template, def, actor, converted)
  } catch (error) {
    /* the component exists and the frames so far are linked (each was sub-committed as it
       was done): out of budget, the rest is left for another call rather than reported as
       a change that never happened */
    if (!(error instanceof WorkBudgetError)) throw error
    return { converted, stopped: true }
  }
  return { converted, stopped: false }
}

function convertFrames(
  canvas: Canvas,
  shape: string,
  template: Element,
  def: ComponentDef,
  actor: Actor,
  converted: CreateResult['converted'],
) {
  for (const frame of [...canvas.frames]) {
    /* a locked frame is not to be edited, however good the reason */
    if (frame.demo || frame.locked) continue
    const doc = parse(frame.html, { sourceCodeLocationInfo: true })
    const measured = measureTree(doc)
    const edits: { start: number; end: number; text: string }[] = []
    const stack: Tree.ChildNode[] = [...doc.childNodes]
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (!isElement(node)) continue
      if (attrOf(node, INSTANCE_ATTR) !== undefined || attrOf(node, COMPONENT_ATTR) !== undefined) continue
      const location = node.sourceCodeLocation
      if (location && measured.get(node)?.shape === shape) {
        keyLike(node, template)
        setAttr(node, INSTANCE_ATTR, def.id)
        setAttr(node, REV_ATTR, String(def.rev))
        if (!attrOf(node, ELEMENT_ID_ATTR)) setAttr(node, ELEMENT_ID_ATTR, newId())
        edits.push({ start: location.startOffset, end: location.endOffset, text: serializeOuter(node) })
        continue
      }
      stack.push(...node.childNodes)
    }
    if (!edits.length) continue
    /* the next prepare diffs each against the template: differing words become props */
    actions.updateFrame(frame.id, { html: splice(frame.html, edits) }, actor)
    converted.push({ frameId: frame.id, instances: edits.length })
    /* a sub-commit per frame: one that is linked stays linked if a later one is refused */
    checkpoint()
  }
}

function keyLike(el: Element, template: Element) {
  const key = attrOf(template, PART_ATTR)
  if (key) setAttr(el, PART_ATTR, key)
  const kids = kidsOf(el).filter((kid) => kid.tagName !== 'style' && kid.tagName !== 'script')
  const templateKids = kidsOf(template).filter((kid) => kid.tagName !== 'style' && kid.tagName !== 'script')
  kids.forEach((kid, index) => {
    const match = templateKids[index]
    if (match) keyLike(kid, match)
  })
}

function newId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (const byte of bytes) id += alphabet[byte % alphabet.length]
  return id
}

/** Elements on a frame that look exactly like an existing component but are not instances of it. */
export function lookalikesIn(frame: Frame): { component: string; occurrences: number; usage: string }[] {
  const defs = activeComponents(store.getComponents(frame.canvasId)).filter((def) => def.template)
  if (!defs.length) return []
  const shapes = new Map(
    defs.flatMap((def) => {
      const root = parseTemplateRoot(def.template)
      const shape = root ? shapeOf(root) : undefined
      return root && shape && elementCount(root) + (attrOf(root, 'class') ? 1 : 0) >= 2 ? [[shape, def] as const] : []
    }),
  )
  if (!shapes.size) return []
  const counts = new Map<ComponentDef, number>()
  const doc = parse(frame.html)
  const measured = measureTree(doc)
  const stack: Tree.ChildNode[] = [...doc.childNodes]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!isElement(node)) continue
    if (attrOf(node, INSTANCE_ATTR) !== undefined || attrOf(node, COMPONENT_ATTR) !== undefined) continue
    const shape = measured.get(node)?.shape
    const def = shape ? shapes.get(shape) : undefined
    if (def) {
      counts.set(def, (counts.get(def) ?? 0) + 1)
      continue
    }
    stack.push(...node.childNodes)
  }
  return [...counts].map(([def, occurrences]) => ({ component: def.name, occurrences, usage: usageExample(def) }))
}

/* ------------------------------------------------------------------ */
/* Libraries: another canvas's component, pulled in on request.         */
/* ------------------------------------------------------------------ */

/** Copy a component (and what it is built from) from a canvas this person can read.
 *  It is linked to its origin: changes there show as an available update here and
 *  arrive only when someone pulls them, so a library can never silently change a
 *  canvas, or withdraw its approvals. */
export function importComponent(
  targetCanvasId: string,
  sourceCanvasId: string,
  ref: string,
  actor: Actor,
): ComponentDef {
  const target = store.getCanvas(targetCanvasId)
  if (!target) fail('canvas not found')
  const shared = librariesForCanvas(target).find((library) => library.canvasId === sourceCanvasId)
  if (shared) return useLibraryComponent(target, sourceCanvasId, ref, actor)
  const origin = findComponent(sourceCanvasId, ref)
  if (!origin) fail(`no component “${ref}” on canvas ${sourceCanvasId}`)
  refuseSiblings(targetCanvasId, sourceCanvasId, origin)
  const progress: ImportProgress = { seen: new Set(), pending: [], kept: [] }
  try {
    /* one unit: what is not sub-committed below is undone when the import is refused */
    transaction(() => importDependencies(targetCanvasId, sourceCanvasId, origin, actor, progress))
  } catch (error) {
    throw afterImportRefusal(progress, error)
  }
  return requireComponent(targetCanvasId, origin.id)
}

/** What an import has done so far, so a refusal part of the way can be told truly. */
interface ImportProgress {
  seen: Set<string>
  /** what it has done since its last sub-commit: undone if it is refused now */
  pending: string[]
  /** what its sub-commits have made permanent */
  kept: string[]
}

/** A component already here was brought up to date: a complete update, which stays whatever
 *  happens next. The sub-commit keeps everything done before it too (the components this
 *  import made on the way are what the update is built from), so a refusal later leaves a
 *  consistent prefix, and running the import again continues from it. */
function keepImportProgress(progress: ImportProgress) {
  progress.kept.push(...progress.pending)
  progress.pending = []
  checkpoint()
}

/** An import of several components ran out of work budget. What it had sub-committed stays,
 *  and the error says so; everything after that was undone by its write boundary, so an
 *  import that only makes new components lands whole or not at all. */
function afterImportRefusal(progress: ImportProgress, error: unknown): unknown {
  if (!(error instanceof WorkBudgetError) || !progress.kept.length) return error
  return error.afterPartialWork(progress.kept.join(', '))
}

/** A canvas and its copies share component ids. The same id here, not pulled from this library,
 *  is this canvas's own component: importing over it would replace its main and every instance.
 *  Checked for the whole set before anything is written, so a refusal leaves nothing half imported. */
function refuseSiblings(targetCanvasId: string, sourceCanvasId: string, origin: ComponentDef) {
  const local = store.getComponents(targetCanvasId)
  const seen = new Set<string>()
  const stack = [origin]
  for (let def = stack.pop(); def; def = stack.pop()) {
    if (seen.has(def.id)) continue
    seen.add(def.id)
    const existing = local.find((candidate) => candidate.id === def!.id)
    if (existing && existing.source?.canvasId !== sourceCanvasId)
      fail(
        `this canvas already has its own component “${existing.name}” (${existing.id}), shared with canvas ${sourceCanvasId} because one was copied from the other; importing would replace it, so edit it here instead`,
      )
    for (const match of def.template.matchAll(/component="([^"]+)"/g)) {
      const dependency = contextFor(sourceCanvasId).find(match[1]!)
      if (dependency) stack.push(dependency)
    }
  }
}

function importDependencies(
  targetCanvasId: string,
  sourceCanvasId: string,
  origin: ComponentDef,
  actor: Actor,
  progress: ImportProgress,
): boolean {
  if (progress.seen.has(origin.id)) return false
  progress.seen.add(origin.id)
  let changed = false
  for (const match of origin.template.matchAll(/component="([^"]+)"/g)) {
    /* deleted ones too: a component built from a deleted one still renders it, frozen */
    const dependency = contextFor(sourceCanvasId).find(match[1]!)
    if (dependency && importDependencies(targetCanvasId, sourceCanvasId, dependency, actor, progress)) changed = true
  }
  const existing = store.getComponents(targetCanvasId).find((def) => def.id === origin.id)
  if (!existing && isDeleted(origin)) {
    /* deleted at its source: copied as it stands, still deleted and with no main, so it is
       there for what is built from it to render and not to be used by itself */
    const now = Date.now()
    const frozen: ComponentDef = {
      ...origin,
      rawCss: importedCss(targetCanvasId, sourceCanvasId, origin),
      mainFrameId: null,
      history: [],
      source: { canvasId: sourceCanvasId, componentId: origin.id, rev: origin.rev },
      createdAt: now,
      updatedAt: now,
      updatedBy: actor.name,
    }
    store.saveComponent(targetCanvasId, frozen)
    progress.pending.push(`“${frozen.name}” imported`)
    actions.broadcastComponent(targetCanvasId, frozen, actor)
    return true
  }
  if (existing) {
    /* deleted here: frozen, whatever its origin has become */
    if (isDeleted(existing)) return changed
    if (existing.source?.canvasId === sourceCanvasId && existing.source.rev === origin.rev) return changed
    pullFrom(targetCanvasId, existing, origin, sourceCanvasId, actor)
    progress.pending.push(`“${existing.name}” updated`)
    keepImportProgress(progress)
    return true
  }
  checkCapacity(targetCanvasId)
  const def = blankComponent({
    id: origin.id,
    name: freeName(targetCanvasId, origin.name),
    description: origin.description,
    props: origin.props,
    ...(origin.code ? { code: origin.code } : {}),
    source: { canvasId: sourceCanvasId, componentId: origin.id, rev: origin.rev },
    by: actor.name,
  })
  const root = parseTemplateRoot(origin.template)
  if (!root) fail(`component “${origin.name}” has no markup`)
  store.saveComponent(targetCanvasId, { ...def, head: origin.head })
  progress.pending.push(`“${def.name}” imported`)
  setAttr(root, COMPONENT_ATTR, def.id)
  writeNewMain(
    targetCanvasId,
    { ...def, head: origin.head },
    serializeOuter(root),
    importedCss(targetCanvasId, sourceCanvasId, origin),
    actor,
  )
  actions.logComponent(targetCanvasId, actor, `imported component “${def.name}” from a library`)
  return true
}

function pullFrom(
  targetCanvasId: string,
  local: ComponentDef,
  origin: ComponentDef,
  sourceCanvasId: string,
  actor: Actor,
) {
  updateComponent(
    targetCanvasId,
    local.id,
    {
      html: origin.template,
      css: importedCss(targetCanvasId, sourceCanvasId, origin),
      head: origin.head,
      props: origin.props,
      description: origin.description,
    },
    actor,
  )
  const saved = requireComponent(targetCanvasId, local.id)
  store.saveComponent(targetCanvasId, {
    ...saved,
    source: { canvasId: sourceCanvasId, componentId: origin.id, rev: origin.rev },
  })
}

/** Bring an imported component up to its library's current revision. */
export function syncComponent(canvasId: string, ref: string, actor: Actor, canRead: (canvasId: string) => boolean) {
  const def = requireComponent(canvasId, ref)
  if (!def.source) fail(`“${def.name}” was not imported from a library`)
  if (def.source.library) {
    const { component, updated } = pullFromLibrary(canvasId, def, actor)
    return { component, updated }
  }
  if (!canRead(def.source.canvasId)) fail('this account cannot read that library canvas')
  const origin = findComponent(def.source.canvasId, def.source.componentId)
  if (!origin) fail('its library no longer has this component')
  /* the whole tree: a nested component can move without this one moving, and this one can start using new ones */
  const progress: ImportProgress = { seen: new Set(), pending: [], kept: [] }
  const source = def.source.canvasId
  let updated: boolean
  try {
    updated = transaction(() => importDependencies(canvasId, source, origin, actor, progress))
  } catch (error) {
    throw afterImportRefusal(progress, error)
  }
  return { component: requireComponent(canvasId, def.id), updated }
}

/* ------------------------------------------------------------------ */
/* Workspace libraries: published once, used on every canvas there.     */
/* Spec: .context/specs/workspace-component-library.md.                 */
/* ------------------------------------------------------------------ */

function requireLibraryPlan(canvas: Canvas, doing: string) {
  const block = libraryBlock(canvas)
  if (!block) return
  if (block.reason === 'no_workspace')
    throw new LibraryPlanError(
      `${doing} needs this canvas to be in a workspace: shared component libraries are part of the Team plan. Tell the person, who can move the canvas into a workspace from Home.`,
    )
  throw new LibraryPlanError(
    `${doing} needs this canvas's workspace to be on the Team plan. Tell the person, who can upgrade it from the workspace's billing page.`,
    block.workspaceId,
  )
}

/** Whether the workspace's publish setting lets this person publish from the
 *  canvas (true where there is no workspace: the plan check speaks there). */
export function mayPublishFrom(canvas: Pick<Canvas, 'workspaceId'>, userId: string | undefined): boolean {
  return !canvas.workspaceId || mayPublishLibrary(canvas.workspaceId, userId)
}

/** The one gate on who publishes and withdraws: REST, MCP and the resident
 *  agent all reach the library through the two functions that call it. */
function requireLibraryPublisher(canvas: Canvas, userId: string | undefined) {
  if (mayPublishFrom(canvas, userId)) return
  throw new LibraryPublisherError(
    "Publishing to this workspace's library is limited to its owner and admins. One of them can publish this, or change who may publish in the workspace's General settings.",
  )
}

/** A published component as the catalog lists it, ready to use by name. */
export function libraryEntry(snapshot: LibraryComponent) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    signature: componentSignature(snapshot),
    ...(snapshot.description ? { description: snapshot.description } : {}),
    usage: usageExample(snapshot),
    /* the publication's version: what a preview of it is keyed by */
    rev: snapshot.rev,
    ...(snapshot.code ? { code: snapshot.code } : {}),
  }
}

/** What the canvas's workspace libraries publish that it does not use yet. */
export function libraryCatalog(canvas: Canvas) {
  const linked = new Set(
    (canvas.components ?? []).flatMap((def) => (def.source?.library ? [`${def.source.canvasId}:${def.id}`] : [])),
  )
  return librariesForCanvas(canvas).flatMap((library) => {
    const components = library.components.filter((entry) => !linked.has(`${entry.canvasId}:${entry.id}`))
    return components.length
      ? [{ canvas_id: library.canvasId, canvas_name: library.name, components: components.map(libraryEntry) }]
      : []
  })
}

/** Take a published component up on this canvas (a no-op when it already is). */
export const useLibraryComponent = atomic(function useLibraryComponent(
  canvas: Canvas,
  libraryCanvasId: string,
  ref: string,
  actor: Actor,
): ComponentDef {
  requireLibraryPlan(canvas, 'Using a library component')
  const snapshot = findInLibraries(canvas, ref).find((entry) => entry.canvasId === libraryCanvasId)
  if (!snapshot) {
    const names = publishedOn(libraryCanvasId).map((entry) => entry.name)
    fail(
      `that library does not publish “${ref}”${names.length ? ` — it publishes: ${names.join(', ')}` : ''}. Its owner may need to publish it first.`,
    )
  }
  try {
    actions.announceAdopted(canvas.id, adoptFromLibrary(canvas.id, snapshot, actor.name), actor)
  } catch (error) {
    if (error instanceof LibraryAdoptError) fail(error.message)
    throw error
  }
  return requireComponent(canvas.id, snapshot.id)
})

/** A linked definition takes its library's published state: a new revision here,
 *  carried to every instance like any change to a main. */
function relink(canvasId: string, def: ComponentDef, snapshot: LibraryComponent, actor: Actor): ComponentDef {
  const bumped = bumpRevision(def, actor.name)
  const next: ComponentDef = {
    ...bumped,
    /* a link's revision is the publication it shows, so a frame's markers and the
       library agree on the number; never below the next local one, for links
       made before the two were kept together */
    rev: Math.max(bumped.rev, snapshot.rev),
    description: snapshot.description,
    template: snapshot.template,
    css: snapshot.css,
    rawCss: snapshot.rawCss,
    head: snapshot.head,
    props: snapshot.props,
    slots: snapshot.slots,
    source: { canvasId: snapshot.canvasId, componentId: snapshot.id, rev: snapshot.rev, library: true },
  }
  if (snapshot.code) next.code = snapshot.code
  else delete next.code
  store.saveComponent(canvasId, next)
  return next
}

/** `quiet` leaves the activity line to the caller (updateLibraryConsumers writes one per canvas). */
const pullFromLibrary = atomic(function pullFromLibrary(
  canvasId: string,
  def: ComponentDef,
  actor: Actor,
  quiet: boolean = false,
) {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  const origin = originOf(canvas, def)
  if (!origin) fail(`its library no longer publishes “${def.name}”; it stays as it is here`)
  /* the whole tree: a nested component can move without this one moving, and this one can start using new ones */
  const closure = snapshotClosure(origin)
  /* all of it fits, or none of it is written: a pull refused half way would leave
     some definitions on the new publication and their instances on the old one */
  const before = store.getComponents(canvasId)
  let missing = 0
  for (const snapshot of closure) {
    const local = before.find((candidate) => candidate.id === snapshot.id)
    if (!local) missing += 1
    else if (!local.source?.library || local.source.canvasId !== snapshot.canvasId)
      fail(
        `this update is built from “${snapshot.name}”, and this canvas has a component of its own under that id (“${local.name}”, ${local.id}; one canvas was copied from the other), so nothing was changed. Rename is not enough: detach or delete that component here first, or keep the version this canvas has.`,
      )
  }
  if (before.length + missing > MAX_COMPONENTS)
    fail(
      `this update needs ${missing} more component${missing === 1 ? '' : 's'}, and a canvas holds at most ${MAX_COMPONENTS}; nothing was changed`,
    )
  const changed: ComponentDef[] = []
  const added: ComponentDef[] = []
  for (const snapshot of closure) {
    const local = store.getComponents(canvasId).find((candidate) => candidate.id === snapshot.id)
    if (!local) {
      try {
        added.push(...adoptFromLibrary(canvasId, snapshot, actor.name))
      } catch (error) {
        if (error instanceof LibraryAdoptError) fail(error.message)
        throw error
      }
    } else if (
      /* a component this canvas deleted is frozen at the design it had: a pull of what is
         built from it (or of anything else) leaves its template, CSS and revision alone */
      !isDeleted(local) &&
      local.source?.library &&
      local.source.canvasId === snapshot.canvasId &&
      local.source.rev < snapshot.rev
    )
      changed.push(relink(canvasId, local, snapshot, actor))
  }
  actions.announceAdopted(canvasId, added, actor)
  let frames: actions.PropagationReport['frames'] = []
  if (changed.length) {
    /* before the instances are rewritten, so each frame's token block has what the new CSS names */
    actions.carryLibraryTokens(canvasId, changed, actor)
    frames = framesUsing(
      canvas,
      changed.map((entry) => entry.id),
    )
    actions.queuePropagation(canvasId, changed, actor)
    if (!quiet)
      actions.logComponent(
        canvasId,
        actor,
        `updated ${changed.map((entry) => `“${entry.name}”`).join(', ')} from the workspace library`,
      )
  }
  return {
    component: requireComponent(canvasId, def.id),
    updated: changed.length > 0 || added.length > 0,
    /* what moved, for a caller reporting on it */
    changed: changed.map((entry) => entry.name),
    /* the frames queued to follow: they are rewritten in the background, one per tick */
    frames,
  }
})

/** The frames holding an instance of any of these components: what a change to them is
 *  queued for. Following a component keeps a frame's sign-off. */
function framesUsing(canvas: Canvas, componentIds: string[]): actions.PropagationReport['frames'] {
  const frames = new Map<string, actions.PropagationReport['frames'][number]>()
  for (const id of componentIds)
    for (const frame of usageOf(canvas, id).frames)
      frames.set(frame.id, { id: frame.id, name: frame.name, approvalLost: false })
  return [...frames.values()]
}

export interface LibraryStatus {
  /** whether this canvas has published anything */
  library: boolean
  changes: LibraryChangeEntry[]
  published_at?: number
  published_by?: string
}

/** A canvas as a library: what it has published and what publishing now would change. */
export function libraryStatus(canvas: Canvas): LibraryStatus {
  const snapshots = publishedOn(canvas.id)
  const latest = snapshots.reduce<LibraryComponent | undefined>(
    (newest, entry) => (!newest || entry.publishedAt > newest.publishedAt ? entry : newest),
    undefined,
  )
  return {
    library: isLibrary(canvas.id),
    changes: libraryChanges(canvas),
    ...(latest ? { published_at: latest.publishedAt, published_by: latest.publishedBy } : {}),
  }
}

/** The workspace's canvases using what this library publishes, and which of their
 *  links are behind its latest publication: where a publish still has to be pulled. */
export function libraryConsumers(canvas: Canvas) {
  if (!canvas.workspaceId) return []
  const snapshots = publishedOn(canvas.id)
  return store.allCanvases().flatMap((other) => {
    if (other.id === canvas.id || other.workspaceId !== canvas.workspaceId) return []
    const linked = activeComponents(other.components).filter(
      (def) => def.source?.library && def.source.canvasId === canvas.id,
    )
    if (!linked.length) return []
    const behind = linked.filter((def) => {
      const snapshot = snapshots.find((entry) => entry.id === def.source?.componentId)
      return !!snapshot && snapshot.rev > (def.source?.rev ?? 0)
    })
    return [
      {
        canvas_id: other.id,
        canvas_name: other.name,
        components: linked.map((def) => def.name),
        ...(behind.length ? { update_waiting: behind.map((def) => def.name) } : {}),
      },
    ]
  })
}

/** The linked components on a canvas whose library has published something newer. */
export function waitingLibraryUpdates(canvas: Canvas): ComponentDef[] {
  return activeComponents(canvas.components).filter((def) => {
    const origin = originOf(canvas, def)
    return !!origin && !!def.source && origin.rev > def.source.rev
  })
}

/** Publish this canvas's components to its workspace: all of them, or the ones named
 *  (each with what it is built from). Other canvases see an update and pull it when they choose.
 *  `publisherId` is the account acting (the agent's person, for an agent), checked against the
 *  workspace's publish setting; a dry run is checked too, so an agent hears the refusal first. */
export const publishToLibrary = atomic(function publishToLibrary(
  canvasId: string,
  refs: readonly string[] | undefined,
  actor: Actor,
  publisherId: string | undefined,
  dryRun: boolean = false,
) {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  requireLibraryPlan(canvas, 'Publishing a library')
  requireLibraryPublisher(canvas, publisherId)
  const ids = refs?.map((ref) => {
    const def = requireComponent(canvasId, ref)
    if (def.source?.library)
      fail(`“${def.name}” comes from another library and is published there, not from this canvas`)
    if (!publishable(def)) fail(`“${def.name}” has no design yet, so there is nothing to publish`)
    return def.id
  })
  if (!ids && !(canvas.components ?? []).some(publishable) && !isLibrary(canvasId))
    fail('this canvas has no components of its own to publish — make one with create_component first')
  const result = writeLibrary(canvas, ids, actor.name, dryRun)
  if (!dryRun && (result.published.length || result.removed.length)) {
    const count = result.published.length
    actions.logComponent(
      canvasId,
      actor,
      count
        ? `published ${count} component${count === 1 ? '' : 's'} to the workspace library`
        : 'removed components from the workspace library',
    )
    actions.broadcastLibrary(canvas, actor)
  }
  return { dry_run: dryRun, ...result, library: libraryStatus(canvas) }
})

/** Stop offering this canvas's components to the workspace. Nothing changes on canvases using them. */
export const unpublishFromLibrary = atomic(function unpublishFromLibrary(
  canvasId: string,
  refs: readonly string[] | undefined,
  actor: Actor,
  publisherId: string | undefined,
) {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  requireLibraryPublisher(canvas, publisherId)
  const ids = refs?.map(
    (ref) => publishedOn(canvasId).find((entry) => entry.id === ref || entry.name === ref)?.id ?? ref,
  )
  const gone = dropLibrary(canvasId, ids)
  if (gone.length) {
    actions.logComponent(
      canvasId,
      actor,
      `stopped sharing ${gone.length} component${gone.length === 1 ? '' : 's'} with the workspace`,
    )
    actions.broadcastLibrary(canvas, actor)
  }
  return { unpublished: gone.map((entry) => ({ id: entry.id, name: entry.name })), library: libraryStatus(canvas) }
})

/* ---- update everywhere: the one way a publication is pushed ---- */

export interface LibraryUpdateOptions {
  /** report what would change and change nothing */
  dryRun?: boolean
  /** may the acting account change that canvas? one it may not is skipped and reported */
  canEdit: (canvasId: string) => boolean
  /** may it open that canvas? one it may not is reported without its id and name */
  canRead: (canvasId: string) => boolean
  /** who is acting: where a workspace keeps publishing to its owner and admins,
   *  sending a library's changes to every canvas is theirs too */
  publisherId: string | undefined
}

export interface LibraryConsumerUpdate {
  canvas_id: string
  canvas_name: string
  /** the linked components brought up to the publication */
  updated: string[]
  /** frames rewritten; in a dry run, the frames holding an instance of what would update */
  frames_changed: number
  /** always 0: a frame following its components keeps its sign-off (2026-11-12). Kept so
   *  readers of the report do not break */
  approvals_withdrawn: number
}

export interface LibrarySkippedConsumer {
  /** absent for a canvas the account cannot open */
  canvas_id?: string
  canvas_name?: string
  reason: 'no_edit_access' | 'failed'
  message: string
}

export interface LibraryUpdateReport {
  dry_run: boolean
  library: { canvas_id: string; canvas_name: string }
  canvases: LibraryConsumerUpdate[]
  skipped: LibrarySkippedConsumer[]
}

/** The links on a canvas that pulling this library's publication would move: the ones
 *  behind it and, as pullFromLibrary walks them, whatever they are built from that is behind too. */
function staleLinks(canvas: Canvas, libraryCanvasId: string): ComponentDef[] {
  const stale = new Map<string, ComponentDef>()
  for (const def of waitingLibraryUpdates(canvas)) {
    const origin = def.source?.canvasId === libraryCanvasId ? originOf(canvas, def) : undefined
    if (!origin) continue
    for (const snapshot of snapshotClosure(origin)) {
      const local = (canvas.components ?? []).find((candidate) => candidate.id === snapshot.id)
      if (
        local &&
        !isDeleted(local) &&
        local.source?.library &&
        local.source.canvasId === snapshot.canvasId &&
        local.source.rev < snapshot.rev
      )
        stale.set(local.id, local)
    }
  }
  return [...stale.values()]
}

function previewConsumerUpdate(canvas: Canvas, libraryCanvasId: string): LibraryConsumerUpdate | undefined {
  const stale = staleLinks(canvas, libraryCanvasId)
  if (!stale.length) return undefined
  const frames = new Map<string, boolean>()
  for (const def of stale) for (const frame of usageOf(canvas, def.id).frames) frames.set(frame.id, false)
  return {
    canvas_id: canvas.id,
    canvas_name: canvas.name,
    updated: stale.map((def) => def.name),
    frames_changed: frames.size,
    approvals_withdrawn: [...frames.values()].filter(Boolean).length,
  }
}

/** Pull the library's publication into one loaded canvas. A refusal part of the way
 *  leaves what was already pulled in place, so both halves are returned. */
function pullIntoConsumer(canvas: Canvas, library: Canvas, actor: Actor) {
  const updated = new Set<string>()
  const frames = new Map<string, boolean>()
  let refusal: string | undefined
  try {
    for (const def of waitingLibraryUpdates(canvas)) {
      if (def.source?.canvasId !== library.id) continue
      const pulled = pullFromLibrary(canvas.id, def, actor, true)
      for (const name of pulled.changed) updated.add(name)
      for (const frame of pulled.frames) frames.set(frame.id, frame.approvalLost || frames.get(frame.id) === true)
    }
  } catch (error) {
    if (!(error instanceof ComponentError)) throw error
    refusal = error.message
  }
  if (updated.size)
    actions.logComponent(
      canvas.id,
      actor,
      `updated ${[...updated].map((name) => `“${name}”`).join(', ')} from the workspace library “${library.name}”, which was updated on every canvas using it`,
    )
  const update: LibraryConsumerUpdate | undefined = updated.size
    ? {
        canvas_id: canvas.id,
        canvas_name: canvas.name,
        updated: [...updated],
        frames_changed: frames.size,
        approvals_withdrawn: [...frames.values()].filter(Boolean).length,
      }
    : undefined
  return { update, refusal }
}

/** Bring every canvas of the workspace that uses this library up to its latest
 *  publication, in one step. Publishing never does this: it is its own act, by someone
 *  who may edit each canvas it changes, and it reports canvas by canvas what it did.
 *  Each pull is the ordinary one (pullFromLibrary): history is filed, approved frames
 *  keep their sign-off and the canvas's room is told.
 *
 *  Frame HTML is loaded per canvas (store.load), and a pull reads and rewrites the
 *  consumer's frames, so each consumer is loaded and held while it is worked on: one
 *  at a time, so a workspace of many canvases is never all in memory for this. */
export async function updateLibraryConsumers(
  libraryCanvasId: string,
  actor: Actor,
  options: LibraryUpdateOptions,
): Promise<LibraryUpdateReport> {
  const library = store.getCanvas(libraryCanvasId)
  if (!library) fail('canvas not found')
  requireLibraryPlan(library, 'Updating the canvases that use a library')
  requireLibraryPublisher(library, options.publisherId)
  if (!isLibrary(library.id))
    fail('this canvas has not published a library, so no canvas follows it — publish_library comes first')
  const report: LibraryUpdateReport = {
    dry_run: options.dryRun === true,
    library: { canvas_id: library.id, canvas_name: library.name },
    canvases: [],
    skipped: [],
  }
  for (const consumer of libraryConsumers(library)) {
    if (!consumer.update_waiting) continue
    const named = options.canRead(consumer.canvas_id)
      ? { canvas_id: consumer.canvas_id, canvas_name: consumer.canvas_name }
      : {}
    if (!options.canEdit(consumer.canvas_id)) {
      report.skipped.push({
        ...named,
        reason: 'no_edit_access',
        message: 'this account may not edit that canvas; someone who can has to pull the update there',
      })
      continue
    }
    const canvas = await store.load(consumer.canvas_id)
    /* deleted, or moved out of the workspace, while an earlier canvas was being read */
    if (!canvas) continue
    const release = store.hold(canvas.id)
    try {
      if (report.dry_run) {
        const preview = previewConsumerUpdate(canvas, library.id)
        if (preview) report.canvases.push(preview)
        continue
      }
      const { update, refusal } = pullIntoConsumer(canvas, library, actor)
      /* a sub-commit per canvas: its pull is sent and its frames enter the queue now, before
         the wait below (which would otherwise wait on a queue nothing has reached yet), and
         a canvas that is done stays done if a later one is refused */
      checkpoint()
      if (update) {
        /* the pull only queued its frames: wait here, canvas held, for what it really changed.
           The wait blocks nothing (the queue works a frame per tick), and keeps the canvases
           this walks through in memory one at a time. */
        const drained = (await propagation.whenCanvasIdle(canvas.id)).propagate
        report.canvases.push({
          ...update,
          frames_changed: drained?.frames.length ?? 0,
          approvals_withdrawn: drained?.frames.filter((frame) => frame.approvalLost).length ?? 0,
        })
      }
      if (refusal) report.skipped.push({ ...named, reason: 'failed', message: refusal })
    } finally {
      release()
    }
  }
  if (!report.dry_run && report.canvases.length) {
    const count = report.canvases.length
    actions.logComponent(
      library.id,
      actor,
      `updated ${count} canvas${count === 1 ? '' : 'es'} to this library’s latest publication`,
    )
    /* the library's own panel counts who is behind: it reads again */
    actions.broadcastLibrary(library, actor)
  }
  return report
}
