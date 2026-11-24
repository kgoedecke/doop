import { createHash } from 'node:crypto'
import { indexOfAscii } from '../shared/asciiSearch.ts'
import {
  defaultTreeAdapter,
  html as parse5Html,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterTypes as Tree,
} from 'parse5'
import { parse, parseFragment } from './workBudget.ts'
import { insertIntoHead, stripComponentHead, syncComponentHead, usedComponentIds } from '../shared/frameCompose.ts'
import {
  BIND_ATTR,
  COMPONENT_ATTR,
  CSS_ATTR,
  DETACHED_ATTR,
  DETACHED_CSS_ATTR,
  IF_ATTR,
  INSTANCE_ATTR,
  MAX_INSTANCE_DEPTH,
  MAX_NESTING_DEPTH,
  OVERRIDES_ATTR,
  PART_ATTR,
  PROPS_ATTR,
  REV_ATTR,
  SLOT_ATTR,
  SLOT_SUGGEST_ATTR,
  USE_TAG,
  conditionHolds,
  isDeleted,
  isHollow,
  isPropName,
  renderRevOf,
  stateAtRev,
  parseBindings,
  parseCondition,
  parseStyle,
  serializeStyle,
  stableJson,
  toPropName,
  type ComponentDef,
  type ComponentIssue,
  type ComponentProp,
  type ComponentSlot,
  type InstanceOverrides,
  type PartOverride,
} from '../shared/components.ts'
import { ELEMENT_ID_ATTR, isElementId, newElementId } from '../shared/elementId.ts'

/**
 * The component engine: pure string-and-tree work with no store behind it.
 * - render: a component's template plus an instance's state → full markup
 * - read: an instance's full markup → its state
 * - reconcile: markup somebody edited → the state that explains the edit, by
 *   diffing it against what the instance's own revision would have rendered,
 *   so a save from a client holding an older main is merged, not mistaken for
 *   overrides
 * - compact / expand: full markup ↔ `<doop-use>`
 */

type Element = Tree.Element
type ChildNode = Tree.ChildNode
type ParentNode = Tree.ParentNode

/** `rev` with `renderRev`: the revision its instances are marked with (`renderRevOf`). */
export type Revision = Pick<ComponentDef, 'id' | 'name' | 'template' | 'props' | 'rev' | 'renderRev'>

export interface EngineContext {
  /** a component by id or name */
  find(ref: string): ComponentDef | undefined
  /** a component as it was at a revision, when that revision is still kept */
  atRev(id: string, rev: number): Revision | undefined
  issues: ComponentIssue[]
  /** Reading stored HTML back (server/frameRest.ts): what stands where a `<doop-use>`
   *  cannot be rendered, in place of leaving it out. With it set, a reference is never
   *  dropped: a deleted component still renders (the frame was stored before the
   *  delete), and one that cannot render at all, or holds a component that cannot,
   *  becomes what this returns for its source text. */
  lost?(use: string, ref: string, why: string): string
}

/** A context over a list of definitions as it stands when asked: an id is exact, deleted
 *  or not, since markup already on the canvas points at it; a name means the component
 *  in use, and a deleted one answers to its name only when nothing else has it, so that
 *  asking for it says "deleted" rather than "unknown". */
export function contextOfDefs(defs: () => readonly ComponentDef[]): EngineContext {
  return {
    find(ref) {
      const all = defs()
      const wanted = ref.trim().toLowerCase()
      const named = all.filter((def) => def.name.toLowerCase() === wanted)
      return all.find((def) => def.id === ref) ?? named.find((def) => !isDeleted(def)) ?? named[0]
    },
    atRev(id, rev) {
      const def = defs().find((candidate) => candidate.id === id)
      const state = def && stateAtRev(def, rev)
      if (!def || !state) return undefined
      return state === def ? def : { id, name: def.name, ...state }
    },
    issues: [],
  }
}

/** Thrown while rendering for a context with `lost`: a component nested in the template
 *  being rendered is missing or renders nothing, so the reference that led here is kept
 *  whole (as its placeholder, or as the markup it already was) rather than rendered short. */
export class UnrenderableUse extends Error {
  readonly ref: string
  readonly why: string

  constructor(ref: string, why: string) {
    super(`component “${ref}” cannot be rendered: ${why}`)
    this.ref = ref
    this.why = why
    this.name = 'UnrenderableUse'
  }
}

/** A `<doop-use>` that could not be rendered when its frame was read from storage, kept
 *  visible and whole: the element says which component is missing and carries the
 *  reference's source text, so the next save stores the reference again and a later read
 *  (the definition repaired) renders it. base64url: nothing in it needs escaping, however
 *  a browser serializes the attribute on the way back. */
export const LOST_USE_ATTR = 'data-doop-lost-use'

const LOST_USE_STYLE =
  'display:inline-block;box-sizing:border-box;padding:6px 10px;border:1px dashed #d92d20;border-radius:6px;background:#fff5f4;color:#b42318;font:12px/1.4 system-ui,sans-serif'

export function lostUsePlaceholder(use: string, name: string): string {
  const source = Buffer.from(use, 'utf8').toString('base64url')
  const label = name.replace(/[&<>]/g, ' ')
  return `<div ${LOST_USE_ATTR}="${source}" style="${LOST_USE_STYLE}">Missing component: ${label}</div>`
}

/* wherever the attribute stands among the others: an editor may add its own (an element id) */
const LOST_USE = new RegExp(`<div\\b[^>]*?\\s${LOST_USE_ATTR}="([A-Za-z0-9_-]*)"[^>]*>[^<]*</div>`, 'g')

/** The component a `<doop-use>`'s source text names. */
export function useRef(use: string): string {
  return /\bcomponent\s*=\s*["']([^"']*)["']/i.exec(use)?.[1] ?? ''
}

/** Placeholders turned back into the references they keep; `wanted` picks which (by the
 *  component each names), all of them without it. */
export function reviveLostUses(html: string, wanted?: (ref: string, use: string) => boolean): string {
  if (!html.includes(LOST_USE_ATTR)) return html
  return html.replace(LOST_USE, (placeholder, source: string) => {
    const use = Buffer.from(source, 'base64url').toString('utf8')
    return !wanted || wanted(useRef(use), use) ? use : placeholder
  })
}

export interface InstanceState {
  instanceId: string
  componentId: string
  rev: number
  overrides: InstanceOverrides
}

export const isElement = (node: ChildNode | ParentNode): node is Element => 'tagName' in node

export const attrOf = (el: Element, name: string): string | undefined =>
  el.attrs.find((attr) => attr.name === name)?.value

export function setAttr(el: Element, name: string, value: string | null) {
  const at = el.attrs.findIndex((attr) => attr.name === name)
  if (value === null) {
    if (at !== -1) el.attrs.splice(at, 1)
  } else if (at === -1) el.attrs.push({ name, value })
  else el.attrs[at]!.value = value
}

const elementKids = (node: ParentNode): Element[] => node.childNodes.filter(isElement)

function setText(el: Element, value: string) {
  el.childNodes = [{ nodeName: '#text', value, parentNode: el } as Tree.TextNode]
}

function directText(el: Element): string {
  return el.childNodes
    .map((child) => (child.nodeName === '#text' ? (child as Tree.TextNode).value : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function setChildrenFromHtml(el: Element, markup: string) {
  const fragment = fragmentIn(markup, el.tagName)
  el.childNodes = fragment.childNodes
  for (const child of el.childNodes) child.parentNode = el
}

/* A template is parsed once and kept: rendering an instance clones the kept tree, and
   reading one (its part keys, its bindings) looks at it without changing it. A page of
   thousands of instances of a few components then costs a few parses, not thousands,
   which is what makes expanding stored `<doop-use>` references on every page load
   affordable (server/frameRest.ts). Bounded by count and by the markup held. */
const MAX_KEPT_TEMPLATES = 1000
const MAX_KEPT_TEMPLATE_CHARS = 16_000_000
const keptTemplates = new Map<string, { root: Element | undefined; parts?: Map<string, PartInfo> }>()
let keptTemplateChars = 0

function keptTemplate(template: string) {
  const kept = keptTemplates.get(template)
  if (kept) {
    /* most recently used last */
    keptTemplates.delete(template)
    keptTemplates.set(template, kept)
    return kept
  }
  const entry: { root: Element | undefined; parts?: Map<string, PartInfo> } = {
    root: elementKids(rootFragment(template))[0],
  }
  keptTemplates.set(template, entry)
  keptTemplateChars += template.length
  for (const oldest of keptTemplates.keys()) {
    if (keptTemplates.size <= MAX_KEPT_TEMPLATES && keptTemplateChars <= MAX_KEPT_TEMPLATE_CHARS) break
    if (oldest === template) break
    keptTemplates.delete(oldest)
    keptTemplateChars -= oldest.length
  }
  return entry
}

/** For a test that counts parses. */
export function forgetKeptTemplates() {
  keptTemplates.clear()
  keptTemplateChars = 0
}

function cloneNode<N extends ChildNode>(node: N, parent: ParentNode): N {
  if (!isElement(node)) return { ...node, parentNode: parent }
  const copy = { ...node, attrs: node.attrs.map((attr) => ({ ...attr })), parentNode: parent } as Element
  copy.childNodes = node.childNodes.map((child) => cloneNode(child, copy))
  const content = (node as Tree.Template).content as Tree.DocumentFragment | undefined
  if (content) {
    const fragment = { ...content } as Tree.DocumentFragment
    fragment.childNodes = content.childNodes.map((child) => cloneNode(child, fragment))
    ;(copy as Tree.Template).content = fragment
  }
  return copy as N
}

/** A template's root element, the caller's own to change. */
export function parseTemplateRoot(template: string): Element | undefined {
  const root = keptTemplate(template).root
  if (!root) return undefined
  const holder = { nodeName: '#document-fragment', childNodes: [] } as unknown as Tree.DocumentFragment
  const copy = cloneNode(root, holder)
  holder.childNodes.push(copy)
  return copy
}

/** The kept root itself: to be read, never changed. */
function templateRootShared(template: string): Element | undefined {
  return keptTemplate(template).root
}

/* where a table part can stand: the HTML parser drops a <td> anywhere but in a row */
const TABLE_PARENT: Record<string, string> = {
  td: 'tr',
  th: 'tr',
  tr: 'tbody',
  tbody: 'table',
  thead: 'table',
  tfoot: 'table',
  caption: 'table',
  colgroup: 'table',
  col: 'colgroup',
}

const contextElements = new Map<string, Element>()

function contextElement(tag: string): Element {
  let el = contextElements.get(tag)
  if (!el) {
    el = defaultTreeAdapter.createElement(tag, parse5Html.NS.HTML, []) as Element
    contextElements.set(tag, el)
  }
  return el
}

/** Markup parsed as the content of a `parentTag`: a row's cells stay cells. */
export function fragmentIn(markup: string, parentTag: string | undefined) {
  const parent = parentTag?.toLowerCase()
  return parent && TABLE_CONTEXTS.has(parent) ? parseInContext(contextElement(parent), markup) : parseFragment(markup)
}

/* parse5's other form of parseFragment: the markup read as the content of `context` */
const parseInContext = parseFragment as unknown as (context: Element, markup: string) => Tree.DocumentFragment

const TABLE_CONTEXTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'colgroup'])

/** The first element's tag, past any leading whitespace and comments. */
function leadingTag(markup: string): string | undefined {
  return /^(?:\s|<!--[\s\S]*?-->)*<([a-z][\w-]*)/i.exec(markup)?.[1]?.toLowerCase()
}

/** Can this markup's root stand where `parentTag` holds it? A table part only in its own table
 *  context; anything else nowhere a table part must be (the parser moves it out of a row). */
export function fitsIn(markup: string, parentTag: string): boolean {
  const tag = leadingTag(markup)
  const parent = parentTag.toLowerCase()
  if (tag && TABLE_PARENT[tag]) return ALLOWED_PARENTS[tag]?.has(parent) ?? false
  return !TABLE_CONTEXTS.has(parent)
}

/* every parent a table part may stand in: a row in any section of a table, or straight in one */
const ALLOWED_PARENTS: Record<string, Set<string>> = {
  td: new Set(['tr']),
  th: new Set(['tr']),
  tr: new Set(['tbody', 'thead', 'tfoot', 'table']),
  tbody: new Set(['table']),
  thead: new Set(['table']),
  tfoot: new Set(['table']),
  caption: new Set(['table']),
  colgroup: new Set(['table']),
  col: new Set(['colgroup', 'table']),
}

/** Is `tag` an element whose children the parser keeps to table parts? */
export function isTableContext(tag: string): boolean {
  return TABLE_CONTEXTS.has(tag.toLowerCase())
}

/** Is this markup's root a table part (a cell, a row, a section of a table)? */
export function isTablePart(markup: string): boolean {
  const tag = leadingTag(markup)
  return !!tag && !!TABLE_PARENT[tag]
}

/** One element's markup parsed where it can stand: a table part inside what holds it. */
export function rootFragment(markup: string) {
  const tag = leadingTag(markup)
  return fragmentIn(markup, tag ? TABLE_PARENT[tag] : undefined)
}

/** What a table part needs around it to be a page's markup at all, for a main of its own. */
export function tableScaffold(markup: string): (inner: string) => string {
  const tag = leadingTag(markup)
  const chain: string[] = []
  for (let parent = tag && TABLE_PARENT[tag]; parent; parent = TABLE_PARENT[parent]) chain.unshift(parent)
  if (!tag || !TABLE_PARENT[tag]) return (inner) => inner
  if (chain[0] !== 'table') chain.unshift('table')
  return (inner) =>
    chain.map((t) => `<${t}>`).join('') +
    inner +
    [...chain]
      .reverse()
      .map((t) => `</${t}>`)
      .join('')
}

const JSON_OBJECT = (value: string | undefined): Record<string, unknown> => {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function asStringRecord(value: Record<string, unknown>): Record<string, string> {
  const record: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) if (typeof entry === 'string') record[key] = entry
  return record
}

/** Part overrides from untrusted JSON: a part that is not an object (`null`, written to mean
 *  "remove it") is no override at all, rather than something to trip over later. */
function asPartRecord(value: Record<string, unknown>): Record<string, PartOverride> {
  const record: Record<string, PartOverride> = {}
  for (const [key, entry] of Object.entries(value))
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) record[key] = entry as PartOverride
  return record
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

interface RenderOptions {
  ctx: EngineContext
  /** template ids on the way down: a component inside itself renders nothing below that point.
   *  Slot and override content start a stack of their own: that is instance data, not template. */
  stack: string[]
  /** instances on the way down, whatever put them there: the one bound slot content has */
  depth?: number
  /** diff base: nested instances stay stubs and slots stay empty, each read from the DOM on its own */
  shallow?: boolean
  /** the instance being rendered: what a nested instance's id is derived from */
  ownerId?: string
}

/** A nested instance has no place of its own to keep an id: the template owns its markup, and the
 *  short form leaves it out. So the id follows from where it sits, and every render agrees on it. */
function nestedInstanceId(ownerId: string | undefined, partKey: string | undefined): string {
  if (!ownerId || !partKey) return ''
  const digest = createHash('sha256').update(`${ownerId}:${partKey}`).digest()
  return Array.from(digest.subarray(0, 6), (byte) => ELEMENT_ID_CHARS[byte % ELEMENT_ID_CHARS.length]).join('')
}

const ELEMENT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

function propValue(def: Revision, overrides: InstanceOverrides, name: string): string | undefined {
  return overrides.props?.[name] ?? def.props.find((prop) => prop.name === name)?.default
}

function applyBindings(el: Element, def: Revision, overrides: InstanceOverrides) {
  const raw = attrOf(el, BIND_ATTR)
  if (raw === undefined) return
  setAttr(el, BIND_ATTR, null)
  for (const { target, prop } of parseBindings(raw, el.tagName)) {
    const value = overrides.props?.[prop]
    if (value === undefined) continue
    if (target === null) setText(el, value)
    else if (target.startsWith('style.') || target.startsWith('--')) {
      const styles = parseStyle(attrOf(el, 'style'))
      styles.set(target.startsWith('--') ? target : target.slice('style.'.length), value)
      setAttr(el, 'style', serializeStyle(styles))
    } else setAttr(el, target, value)
  }
  void def
}

const TAG_NAME = /^[a-z][a-z0-9-]*$/

function applyPartOverride(el: Element, part: PartOverride) {
  if (part.tag && TAG_NAME.test(part.tag)) {
    el.tagName = part.tag
    el.nodeName = part.tag
  }
  for (const [name, value] of Object.entries(part.attrs ?? {})) setAttr(el, name, value)
  if (part.style && Object.keys(part.style).length) {
    const styles = parseStyle(attrOf(el, 'style'))
    for (const [name, value] of Object.entries(part.style)) {
      if (value === null) styles.delete(name)
      else styles.set(name, value)
    }
    setAttr(el, 'style', styles.size ? serializeStyle(styles) : null)
  }
  if (part.text !== undefined) setText(el, part.text)
}

function renderNode(el: Element, def: Revision, overrides: InstanceOverrides, options: RenderOptions) {
  const kept: ChildNode[] = []
  for (const child of el.childNodes) {
    if (!isElement(child)) {
      kept.push(child)
      continue
    }
    const key = attrOf(child, PART_ATTR)
    const part = key ? overrides.parts?.[key] : undefined
    const condition = attrOf(child, IF_ATTR)
    if (condition !== undefined) {
      const parsed = parseCondition(condition)
      if (parsed && !conditionHolds(parsed, propValue(def, overrides, parsed.prop))) continue
      setAttr(child, IF_ATTR, null)
    }
    if (part?.hidden) continue
    if (child.tagName === USE_TAG) {
      if (options.shallow) {
        kept.push(child)
        continue
      }
      const rendered = renderUseElement(child, part, options, key)
      if (rendered) {
        rendered.parentNode = el
        kept.push(rendered)
      }
      continue
    }
    renderPart(child, def, overrides, part, options)
    kept.push(child)
  }
  el.childNodes = kept
}

function renderPart(
  el: Element,
  def: Revision,
  overrides: InstanceOverrides,
  part: PartOverride | undefined,
  options: RenderOptions,
) {
  applyBindings(el, def, overrides)
  setAttr(el, SLOT_SUGGEST_ATTR, null)
  if (part) applyPartOverride(el, part)
  const isSlot = attrOf(el, SLOT_ATTR) !== undefined
  const content = (html: string) => expandOverride(html, options.ctx, options.depth)
  if (part?.html !== undefined) {
    setChildrenFromHtml(el, options.shallow ? part.html : content(part.html))
    return
  }
  if (isSlot) {
    if (options.shallow) el.childNodes = []
    else if (part?.slot !== undefined) setChildrenFromHtml(el, content(part.slot))
    else renderNode(el, def, overrides, options)
    return
  }
  if (part?.text !== undefined) return
  renderNode(el, def, overrides, options)
}

function renderUseElement(
  use: Element,
  part: PartOverride | undefined,
  options: RenderOptions,
  outerKey: string | undefined,
): Element | undefined {
  const ref = attrOf(use, 'component') ?? ''
  const nested = options.ctx.find(ref)
  if (!nested) {
    options.ctx.issues.push({ code: 'unknown_component', message: `no component “${ref}” on this canvas` })
    if (options.ctx.lost) throw new UnrenderableUse(ref, 'a component its template is built from is missing')
    return undefined
  }
  const state = part?.use ?? stateFromUseAttrs(use, nested, options.ctx).overrides
  const id = attrOf(use, ELEMENT_ID_ATTR) ?? nestedInstanceId(options.ownerId, outerKey)
  const rendered = renderInstance(nested, nested, state, id, options)
  if (!rendered && options.ctx.lost)
    throw new UnrenderableUse(nested.name, 'a component its template is built from renders nothing')
  if (rendered && outerKey) setAttr(rendered, PART_ATTR, outerKey)
  return rendered
}

function markRoot(root: Element, def: Revision, instanceId: string, overrides: InstanceOverrides) {
  setAttr(root, INSTANCE_ATTR, def.id)
  /* where its markup last changed: a revision of the component's rules alone leaves it */
  setAttr(root, REV_ATTR, String(renderRevOf(def)))
  setAttr(root, ELEMENT_ID_ATTR, instanceId)
  for (const prop of def.props) {
    if (prop.type !== 'enum') continue
    const value = propValue(def, overrides, prop.name)
    if (value !== undefined) setAttr(root, `data-${prop.name}`, value)
  }
  const props = overrides.props ?? {}
  setAttr(root, PROPS_ATTR, Object.keys(props).length ? stableJson(props) : null)
  const persisted = persistedParts(overrides.parts)
  setAttr(root, OVERRIDES_ATTR, Object.keys(persisted).length ? stableJson(persisted) : null)
}

/** Slot content and nested state live in the DOM below the instance; repeating them in the marker would double it. */
function persistedParts(parts: InstanceOverrides['parts']): Record<string, PartOverride> {
  const kept: Record<string, PartOverride> = {}
  for (const [key, part] of Object.entries(parts ?? {})) {
    const { slot: _slot, use: _use, ...rest } = part
    if (Object.keys(rest).length) kept[key] = rest
  }
  return kept
}

/** `def` is the component whose props and id mark the root; `revision` supplies the markup. */
export function renderInstance(
  def: Pick<ComponentDef, 'id'> & Partial<ComponentDef>,
  revision: Revision,
  overrides: InstanceOverrides,
  instanceId: string,
  options: RenderOptions,
): Element | undefined {
  if (options.stack.includes(revision.id) || options.stack.length >= MAX_NESTING_DEPTH) {
    options.ctx.issues.push({
      code: 'nesting_cycle',
      message: `component “${revision.name}” cannot contain itself; that nested copy was skipped`,
    })
    return undefined
  }
  const depth = options.depth ?? 0
  if (depth >= MAX_INSTANCE_DEPTH) {
    options.ctx.issues.push({
      code: 'too_deep',
      message: `instances are nested more than ${MAX_INSTANCE_DEPTH} deep; the copy of “${revision.name}” below that was skipped`,
    })
    return undefined
  }
  const root = parseTemplateRoot(revision.template)
  if (!root) {
    options.ctx.issues.push({
      code: 'empty_template',
      message: `component “${revision.name}” has no markup in its main, so its instance rendered nothing. Give it markup with update_component html.`,
    })
    return undefined
  }
  const id = instanceId || newElementId()
  const inner: RenderOptions = { ...options, stack: [...options.stack, revision.id], depth: depth + 1, ownerId: id }
  const key = attrOf(root, PART_ATTR)
  renderPart(root, revision, overrides, key ? overrides.parts?.[key] : undefined, inner)
  markRoot(root, revision, id, overrides)
  return root
}

export function renderInstanceHtml(
  def: ComponentDef,
  state: Omit<InstanceState, 'rev' | 'componentId'>,
  ctx: EngineContext,
) {
  const root = renderInstance(def, def, state.overrides, state.instanceId, { ctx, stack: [] })
  return root ? serializeOuter(root) : ''
}

/* ------------------------------------------------------------------ */
/* Reading state back from markup                                      */
/* ------------------------------------------------------------------ */

function readMarker(el: Element): InstanceState | undefined {
  const componentId = attrOf(el, INSTANCE_ATTR)
  if (!componentId) return undefined
  const props = asStringRecord(JSON_OBJECT(attrOf(el, PROPS_ATTR)))
  const parts = asPartRecord(JSON_OBJECT(attrOf(el, OVERRIDES_ATTR)))
  const id = attrOf(el, ELEMENT_ID_ATTR)
  return {
    instanceId: isElementId(id) ? id : newElementId(),
    componentId,
    rev: Number(attrOf(el, REV_ATTR)) || 0,
    overrides: clean({ props, parts }),
  }
}

function clean(overrides: InstanceOverrides): InstanceOverrides {
  const out: InstanceOverrides = {}
  if (overrides.props && Object.keys(overrides.props).length) out.props = overrides.props
  if (overrides.parts && Object.keys(overrides.parts).length) out.parts = overrides.parts
  return out
}

/** The compact markup of a node list: instances collapse to `<doop-use>`, the rest serializes as it stands. */
function compactChildren(el: ParentNode, ctx: EngineContext): string {
  const clone = fragmentIn(serialize(el), isElement(el) ? el.tagName : undefined)
  compactInTree(clone, ctx)
  return serialize(clone)
}

function compactInTree(node: ParentNode, ctx: EngineContext, inTemplate = false) {
  node.childNodes = node.childNodes.map((child) => {
    if (!isElement(child)) return child
    if (attrOf(child, INSTANCE_ATTR)) return useElementFor(child, ctx, node, inTemplate)
    compactInTree(child, ctx, inTemplate)
    return child
  })
}

/* stored markup (a template, a slot, an html override) names components by id, so a rename cannot break it */
function useElementFor(
  el: Element,
  ctx: EngineContext,
  parent: ParentNode,
  inTemplate: boolean,
  reconcile = false,
): ChildNode {
  const html = useTagFor(el, ctx, inTemplate, true, reconcile)
  const use = elementKids(parseFragment(html))[0]
  if (!use) return el
  use.parentNode = parent
  return use
}

/** A template's element keys, with the bindings each one carries. */
export interface PartInfo {
  el: Element
  textProp?: string
  attrProps: Map<string, string>
  styleProps: Map<string, string>
  isSlot: boolean
  isUse: boolean
}

export function partsOf(template: string): Map<string, PartInfo> {
  return partsBelow(parseTemplateRoot(template))
}

/** The same, over the kept tree: for reading only (its elements are shared). */
function partsOfShared(template: string): Map<string, PartInfo> {
  const kept = keptTemplate(template)
  return (kept.parts ??= partsBelow(kept.root))
}

function partsBelow(root: Element | undefined): Map<string, PartInfo> {
  const parts = new Map<string, PartInfo>()
  if (!root) return parts
  const stack: Element[] = [root]
  for (let el = stack.pop(); el; el = stack.pop()) {
    const key = attrOf(el, PART_ATTR)
    if (key) {
      const info: PartInfo = {
        el,
        attrProps: new Map(),
        styleProps: new Map(),
        isSlot: attrOf(el, SLOT_ATTR) !== undefined,
        isUse: el.tagName === USE_TAG,
      }
      for (const { target, prop } of parseBindings(attrOf(el, BIND_ATTR) ?? '', el.tagName)) {
        if (target === null) info.textProp = prop
        else if (target.startsWith('style.')) info.styleProps.set(target.slice('style.'.length), prop)
        else if (target.startsWith('--')) info.styleProps.set(target, prop)
        else info.attrProps.set(target, prop)
      }
      parts.set(key, info)
    }
    stack.push(...elementKids(el))
  }
  return parts
}

/** Read an instance's whole state from its markup: the marker's props and overrides,
 *  plus slot content and nested instances found in place. Nothing is diffed here, except that a
 *  nested instance matching the template's own `<doop-use>` is no override. */
export function readInstance(el: Element, def: Revision | undefined, ctx: EngineContext): InstanceState | undefined {
  const state = readMarker(el)
  if (!state) return undefined
  if (!def) return state
  const parts = partsOfShared(def.template)
  const merged: Record<string, PartOverride> = { ...state.overrides.parts }
  /* by the template's key: a nested root wears the outer component's on it */
  const rootKey = attrOf(templateRootShared(def.template) ?? el, PART_ATTR)
  if (rootKey && parts.get(rootKey)?.isSlot) {
    merged[rootKey] = { ...merged[rootKey], slot: compactChildren(el, ctx) }
    return { ...state, overrides: clean({ ...state.overrides, parts: merged }) }
  }
  const stack = elementKids(el)
  for (let child = stack.pop(); child; child = stack.pop()) {
    const key = attrOf(child, PART_ATTR)
    const info = key ? parts.get(key) : undefined
    if (key && info?.isUse && attrOf(child, INSTANCE_ATTR)) {
      const nestedDef = ctx.atRev(attrOf(child, INSTANCE_ATTR)!, Number(attrOf(child, REV_ATTR)) || 0)
      const nested = readInstance(child, nestedDef, ctx)
      if (nested) {
        /* the template's own <doop-use> is the main's value, not this instance's override:
           recorded, it would pin every instance and the main's next change would stop here */
        const { use: _template, ...rest } = merged[key] ?? {}
        const same = isTemplateUse(info.el, nested, { ...ctx, issues: [] })
        if (!same) merged[key] = { ...rest, use: nested.overrides }
        else if (Object.keys(rest).length) merged[key] = rest
        else delete merged[key]
      }
      continue
    }
    if (attrOf(child, INSTANCE_ATTR)) continue
    if (key && info?.isSlot) {
      merged[key] = { ...merged[key], slot: compactChildren(child, ctx) }
      continue
    }
    stack.push(...elementKids(child))
  }
  return { ...state, overrides: clean({ ...state.overrides, parts: merged }) }
}

/* ------------------------------------------------------------------ */
/* Reconcile: what did this edit change?                               */
/* ------------------------------------------------------------------ */

const INTERNAL_ATTRS = new Set([INSTANCE_ATTR, REV_ATTR, PROPS_ATTR, OVERRIDES_ATTR, PART_ATTR])

const isTracked = (name: string) => !INTERNAL_ATTRS.has(name) && !name.startsWith('data-v-')

function diffStyle(
  base: Element,
  incoming: Element,
  info: PartInfo | undefined,
  state: InstanceOverrides,
  into: PartOverride,
) {
  const before = parseStyle(attrOf(base, 'style'))
  const after = parseStyle(attrOf(incoming, 'style'))
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const value = after.get(name)
    if (before.get(name) === value) continue
    const prop = info?.styleProps.get(name)
    if (prop && value !== undefined) (state.props ??= {})[prop] = value
    else (into.style ??= {})[name] = value ?? null
  }
}

function diffAttrs(
  base: Element,
  incoming: Element,
  info: PartInfo | undefined,
  def: Revision,
  isRoot: boolean,
  state: InstanceOverrides,
  into: PartOverride,
) {
  const names = new Set([...base.attrs, ...incoming.attrs].map((attr) => attr.name))
  for (const name of names) {
    if (!isTracked(name) || name === 'style') continue
    if (isRoot && name === ELEMENT_ID_ATTR) continue
    const before = attrOf(base, name)
    const after = attrOf(incoming, name)
    if (before === after) continue
    const enumProp =
      isRoot && name.startsWith('data-')
        ? def.props.find((prop) => prop.type === 'enum' && `data-${prop.name}` === name)
        : undefined
    if (enumProp && after !== undefined) (state.props ??= {})[enumProp.name] = after
    else if (info?.attrProps.has(name) && after !== undefined) (state.props ??= {})[info.attrProps.get(name)!] = after
    else (into.attrs ??= {})[name] = after ?? null
  }
}

function canonicalInner(el: Element): string {
  const clone = fragmentIn(serialize(el), el.tagName)
  const strip = (node: ParentNode) => {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue
      setAttr(child, PART_ATTR, null)
      strip(child)
    }
  }
  strip(clone)
  return serialize(clone).replace(/\s+/g, ' ').trim()
}

function diffPart(
  base: Element,
  incoming: Element,
  key: string,
  parts: Map<string, PartInfo>,
  def: Revision,
  isRoot: boolean,
  state: InstanceOverrides,
  ctx: EngineContext,
) {
  const info = parts.get(key)
  const into: PartOverride = {}
  /* the same part as another element: a <button> made an <a> stays an <a> */
  if (base.tagName !== incoming.tagName && TAG_NAME.test(incoming.tagName)) into.tag = incoming.tagName
  diffAttrs(base, incoming, info, def, isRoot, state, into)
  diffStyle(base, incoming, info, state, into)

  const existing = state.parts?.[key]
  if (info?.isSlot && existing?.html === undefined) {
    /* the slot's own attributes were diffed above; its content is the instance's */
    const inner = compactChildren(incoming, ctx)
    const defaultInner = compactChildren(info.el, ctx)
    const same = inner.replace(/\s+/g, ' ') === defaultInner.replace(/\s+/g, ' ')
    mergeInto(state, key, into, { slot: same ? undefined : inner })
    return
  }
  if (existing?.html !== undefined) {
    if (canonicalInner(base) !== canonicalInner(incoming)) into.html = compactChildren(incoming, ctx)
    mergeInto(state, key, into)
    return
  }

  const baseKids = elementKids(base)
  const incomingKids = elementKids(incoming)
  if (baseKids.length === 0 && incomingKids.length === 0) {
    const before = directText(base)
    const after = directText(incoming)
    if (before !== after) {
      if (info?.textProp) (state.props ??= {})[info.textProp] = after
      else into.text = after
    }
    mergeInto(state, key, into)
    return
  }

  const baseKeys = baseKids.map((kid) => attrOf(kid, PART_ATTR))
  const incomingKeys = incomingKids.map((kid) => attrOf(kid, PART_ATTR))
  const baseSet = new Set(baseKeys)
  const keysKnown = incomingKeys.every((kidKey) => kidKey && baseSet.has(kidKey))
  let order = 0
  const inOrder = incomingKeys.every((kidKey) => {
    const at = baseKeys.indexOf(kidKey, order)
    if (at === -1) return false
    order = at + 1
    return true
  })
  if (!keysKnown || !inOrder || directText(base) !== directText(incoming)) {
    /* moved, added or rewritten children: keep exactly what they made,
       for this element alone. The instance stays linked everywhere else. */
    into.html = compactChildren(incoming, ctx)
    mergeInto(state, key, into)
    return
  }
  mergeInto(state, key, into)
  for (const baseKid of baseKids) {
    const kidKey = attrOf(baseKid, PART_ATTR)
    if (!kidKey) continue
    const match = incomingKids.find((kid) => attrOf(kid, PART_ATTR) === kidKey)
    if (!match) {
      mergeInto(state, kidKey, { hidden: true })
      continue
    }
    if (baseKid.tagName === USE_TAG) {
      diffNested(match, kidKey, parts, state, ctx)
      continue
    }
    diffPart(baseKid, match, kidKey, parts, def, false, state, ctx)
  }
}

function diffNested(
  incoming: Element,
  key: string,
  parts: Map<string, PartInfo>,
  state: InstanceOverrides,
  ctx: EngineContext,
) {
  const reconciled = reconcileInstance(incoming, ctx)
  const use = parts.get(key)?.el
  if (!reconciled || !use) return
  mergeInto(state, key, {}, { use: isTemplateUse(use, reconciled, ctx) ? undefined : reconciled.overrides })
}

/** Whether a nested instance is exactly what the template's own `<doop-use>` renders. */
function isTemplateUse(use: Element, nested: InstanceState, ctx: EngineContext): boolean {
  const def = ctx.find(nested.componentId)
  const defaults = def ? stateFromUseAttrs(use, def, ctx).overrides : {}
  return stableJson(defaults) === stableJson(nested.overrides)
}

function mergeInto(
  state: InstanceOverrides,
  key: string,
  part: PartOverride,
  extra: { slot?: string | undefined; use?: InstanceOverrides | undefined } = {},
) {
  const parts = (state.parts ??= {})
  const merged: PartOverride = { ...parts[key] }
  if (part.attrs) merged.attrs = { ...merged.attrs, ...part.attrs }
  if (part.style) merged.style = { ...merged.style, ...part.style }
  if (part.tag !== undefined) merged.tag = part.tag
  if (part.text !== undefined) merged.text = part.text
  if (part.html !== undefined) {
    merged.html = part.html
    delete merged.text
  }
  if (part.hidden !== undefined) merged.hidden = part.hidden
  if ('slot' in extra) {
    if (extra.slot === undefined) delete merged.slot
    else merged.slot = extra.slot
  }
  if ('use' in extra) {
    if (extra.use === undefined) delete merged.use
    else merged.use = extra.use
  }
  if (Object.keys(merged).length) parts[key] = merged
  else delete parts[key]
}

/** An override set back to the template's own value is no override at all. */
function pruneOverrides(overrides: InstanceOverrides, parts: Map<string, PartInfo>, def: Revision): InstanceOverrides {
  const out: InstanceOverrides = {}
  const props: Record<string, string> = {}
  for (const [name, value] of Object.entries(overrides.props ?? {})) {
    const prop = def.props.find((candidate) => candidate.name === name)
    if (prop?.default !== undefined && prop.default === value) continue
    if (prop && (prop.type === 'text' || prop.type === 'image' || prop.type === 'link')) {
      if (templateValueOf(name, parts) === value) continue
    }
    props[name] = value
  }
  if (Object.keys(props).length) out.props = props
  const kept: Record<string, PartOverride> = {}
  for (const [key, part] of Object.entries(overrides.parts ?? {})) {
    const info = parts.get(key)
    const next: PartOverride = { ...part }
    if (info) {
      if (next.attrs) {
        const attrs = Object.entries(next.attrs).filter(([name, value]) => (attrOf(info.el, name) ?? null) !== value)
        if (attrs.length) next.attrs = Object.fromEntries(attrs)
        else delete next.attrs
      }
      if (next.style) {
        const template = parseStyle(attrOf(info.el, 'style'))
        const styles = Object.entries(next.style).filter(([name, value]) => (template.get(name) ?? null) !== value)
        if (styles.length) next.style = Object.fromEntries(styles)
        else delete next.style
      }
      if (next.text !== undefined && next.text === directText(info.el)) delete next.text
      if (next.tag !== undefined && next.tag === info.el.tagName) delete next.tag
      if (next.hidden === false) delete next.hidden
    }
    if (Object.keys(next).length) kept[key] = next
  }
  if (Object.keys(kept).length) out.parts = kept
  return out
}

function templateValueOf(prop: string, parts: Map<string, PartInfo>): string | undefined {
  for (const info of parts.values()) {
    if (info.textProp === prop) return directText(info.el)
    for (const [target, name] of info.attrProps) if (name === prop) return attrOf(info.el, target)
    for (const [target, name] of info.styleProps)
      if (name === prop) return parseStyle(attrOf(info.el, 'style')).get(target)
  }
  return undefined
}

/** The state that explains this instance's markup: its marker, plus whatever
 *  was edited relative to what its own revision would have rendered. When that
 *  revision is gone there is nothing to diff against and the marker stands. */
export function reconcileInstance(el: Element, ctx: EngineContext): InstanceState | undefined {
  const marker = readMarker(el)
  if (!marker) return undefined
  const revision = ctx.atRev(marker.componentId, marker.rev)
  const current = ctx.find(marker.componentId)
  const known = revision ?? current
  if (!known) return marker
  const read = readInstance(el, known, ctx) ?? marker
  if (!revision) return read
  const parts = partsOfShared(revision.template)
  /* the base holds the marker's overrides; slots and nested instances are read from the DOM */
  const base = renderInstance(revision, revision, marker.overrides, marker.instanceId, {
    ctx,
    stack: [],
    shallow: true,
  })
  if (!base) return read
  const state: InstanceOverrides = {
    ...(read.overrides.props ? { props: { ...read.overrides.props } } : {}),
    ...(read.overrides.parts ? { parts: { ...read.overrides.parts } } : {}),
  }
  const rootKey = attrOf(base, PART_ATTR)
  /* a nested root carries the outer component's key on it */
  const templateKey = attrOf(templateRootShared(revision.template)!, PART_ATTR)
  if (rootKey || templateKey) {
    const key = templateKey ?? rootKey!
    setAttr(base, PART_ATTR, key)
    diffPart(base, el, key, parts, revision, true, state, ctx)
  }
  return { ...read, overrides: pruneOverrides(state, parts, revision) }
}

/* ------------------------------------------------------------------ */
/* Compact form                                                        */
/* ------------------------------------------------------------------ */

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function attrText(name: string, value: string): string {
  return ` ${name}="${escapeAttr(value)}"`
}

/** The `<doop-use>` tag for an instance element, children and all. `reconcile` reads the state
 *  an edit to the markup implies, not only what the marker says: what a main's template needs,
 *  so a change inside a nested instance of the main lands in the same write. */
export function useTagFor(
  el: Element,
  ctx: EngineContext,
  inTemplate = false,
  byId = false,
  reconcile = false,
  withId = false,
): string {
  const marker = readMarker(el)
  if (!marker) return serializeOuter(el)
  const def = ctx.find(marker.componentId)
  const revision = ctx.atRev(marker.componentId, marker.rev) ?? def
  const state = (reconcile ? reconcileInstance(el, ctx) : undefined) ?? readInstance(el, revision, ctx) ?? marker
  const ref = byId ? marker.componentId : (def?.name ?? marker.componentId)
  return useMarkup(ref, state, revision, inTemplate ? attrOf(el, PART_ATTR) : undefined, withId)
}

export function useMarkup(
  name: string,
  state: InstanceState,
  def: Revision | undefined,
  part: string | undefined,
  /** with a part: the element id too. A frame's copy of a main keeps both; a stored template never an id */
  withId = false,
): string {
  const rest: Record<string, PartOverride> = {}
  const slotChildren: string[] = []
  const slotParts = def ? partsOfShared(def.template) : new Map<string, PartInfo>()
  for (const [key, override] of Object.entries(state.overrides.parts ?? {})) {
    const { slot, ...others } = override
    if (slot !== undefined) {
      const slotName = attrOf(slotParts.get(key)?.el ?? ({ attrs: [] } as unknown as Element), SLOT_ATTR) ?? key
      slotChildren.push(`<template slot="${escapeAttr(slotName)}">${slot}</template>`)
    }
    if (Object.keys(others).length) rest[key] = others
  }
  let tag = `<${USE_TAG}${attrText('component', name)}`
  if (part) tag += attrText(PART_ATTR, part)
  if ((!part || withId) && isElementId(state.instanceId)) tag += attrText('id', state.instanceId)
  for (const [prop, value] of Object.entries(state.overrides.props ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    tag += attrText(prop, value)
  if (Object.keys(rest).length) tag += attrText('overrides', stableJson(rest))
  return `${tag}>${slotChildren.join('')}</${USE_TAG}>`
}

/* Attributes that mean something on a template's own element and nothing on a `<doop-use>`: the
   nested instance is written out in the main, so one of these would only ride along as an
   attribute override on its root. Each says what to write instead. */
const TEMPLATE_ONLY_ATTRS: Record<string, string> = {
  [BIND_ATTR]:
    'a component cannot pass its props on to a component inside it. Give that one fixed values (label="…"), or put an element with data-doop-slot there and let each instance supply its own <doop-use>',
  [IF_ATTR]: 'put it on an element wrapped around the <doop-use>',
  [SLOT_ATTR]: 'put it on an element wrapped around the <doop-use>, which is then the slot’s default content',
  [SLOT_SUGGEST_ATTR]: 'it belongs on the element that carries data-doop-slot',
}

/** Build an instance's overrides from a `<doop-use>`'s attributes, reporting what does not fit. */
export function stateFromUseAttrs(use: Element, def: Revision, ctx: EngineContext): InstanceState {
  const props: Record<string, string> = {}
  let parts: Record<string, PartOverride> = {}
  const root = templateRootShared(def.template)
  const rootKey = root ? attrOf(root, PART_ATTR) : undefined
  const addRoot = (patch: PartOverride) => {
    if (!rootKey) return
    const existing = parts[rootKey] ?? {}
    parts[rootKey] = {
      ...existing,
      ...patch,
      ...(patch.attrs ? { attrs: { ...existing.attrs, ...patch.attrs } } : {}),
    }
  }
  for (const attr of use.attrs) {
    const name = attr.name
    if (name === 'component' || name === 'id' || name === PART_ATTR || name === ELEMENT_ID_ATTR) continue
    const instead = TEMPLATE_ONLY_ATTRS[name]
    if (instead) {
      ctx.issues.push({
        code: 'ignored_attribute',
        message: `${name} on <${USE_TAG} component="${def.name}"> does nothing and was dropped: ${instead}.`,
      })
      continue
    }
    if (name === 'overrides') {
      parts = { ...parts, ...asPartRecord(JSON_OBJECT(attr.value)) }
      continue
    }
    if (name === 'style') {
      addRoot({ style: Object.fromEntries(parseStyle(attr.value)) })
      continue
    }
    if (name === 'class') {
      addRoot({ attrs: { class: [root ? attrOf(root, 'class') : '', attr.value].filter(Boolean).join(' ') } })
      continue
    }
    const prop = def.props.find((candidate) => candidate.name === name)
    if (prop) {
      if (prop.type === 'enum' && prop.options?.length && !prop.options.includes(attr.value)) {
        ctx.issues.push({
          code: 'invalid_prop_value',
          message: `${def.name}: "${attr.value}" is not a value of ${name} — use ${prop.options.join(' | ')}`,
        })
        continue
      }
      props[name] = attr.value
      continue
    }
    if (name.startsWith('data-') || name.startsWith('aria-')) {
      addRoot({ attrs: { [name]: attr.value } })
      continue
    }
    ctx.issues.push({
      code: 'unknown_prop',
      message: `${def.name} has no prop “${name}” — it has ${def.props.map((p) => p.name).join(', ') || 'no props'}`,
    })
  }
  /* `<template slot="x">` and plain children go to their slots */
  assignSlots(use, def, parts)
  const rawId = attrOf(use, 'id') ?? attrOf(use, ELEMENT_ID_ATTR)
  return {
    instanceId: isElementId(rawId) ? rawId : newElementId(),
    componentId: def.id,
    rev: renderRevOf(def),
    overrides: clean({ props, parts }),
  }
}

function assignSlots(use: Element, def: Revision, parts: Record<string, PartOverride>) {
  const slotParts = [...partsOfShared(def.template)].filter(([, info]) => info.isSlot)
  if (!slotParts.length) return
  const byName = new Map(slotParts.map(([key, info]) => [attrOf(info.el, SLOT_ATTR) ?? '', key]))
  const fallback = slotParts[0]![0]
  const unnamed: string[] = []
  for (const child of use.childNodes) {
    if (isElement(child)) {
      const slotName = attrOf(child, 'slot')
      if (slotName !== undefined) {
        const key = byName.get(slotName) ?? fallback
        const content = child.tagName === 'template' ? templateInner(child) : serializeOuterWithoutSlot(child)
        const existing = parts[key]?.slot
        parts[key] = { ...parts[key], slot: existing ? `${existing}${content}` : content }
        continue
      }
      unnamed.push(serializeOuter(child))
    } else if (child.nodeName === '#text' && (child as Tree.TextNode).value.trim()) {
      unnamed.push((child as Tree.TextNode).value)
    }
  }
  if (unnamed.length) {
    const existing = parts[fallback]?.slot
    parts[fallback] = { ...parts[fallback], slot: `${existing ?? ''}${unnamed.join('')}` }
  }
}

function templateInner(el: Element): string {
  const content = (el as Tree.Template).content
  return content ? serialize(content) : serialize(el)
}

/* a copy without the attribute: the element may be a kept template's (a nested use's child) */
function serializeOuterWithoutSlot(el: Element): string {
  return serializeOuter({ ...el, attrs: el.attrs.filter((attr) => attr.name !== 'slot') } as Element)
}

/* ------------------------------------------------------------------ */
/* Expanding `<doop-use>` at string level: a parser would foster-parent */
/* one out of a <table>, and the rest of the document stays byte-exact. */
/* ------------------------------------------------------------------ */

/* the name ends where the tag's does: `<style-chip>` is a custom element, not a stylesheet */
const OPAQUE = /<(script|style|textarea|title)(?=[\s/>])[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi

function opaqueRanges(html: string): [number, number][] {
  return [...html.matchAll(OPAQUE)].map((match) => [match.index, match.index + match[0].length])
}

function tagEnd(html: string, from: number): number {
  let quote = ''
  for (let i = from; i < html.length; i++) {
    const char = html[i]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '>') return i
  }
  return -1
}

/** The end of a tag found in running HTML, as the tokenizer has it: a quote opens a quoted
 *  run only where an attribute's value starts (after `=`). An apostrophe in text a stray `<b`
 *  made into a "tag" (`a<b) it's`) opens none, so the tag ends at the next `>`. */
function documentTagEnd(html: string, from: number): number {
  let quote = ''
  let value = false
  for (let i = from; i < html.length; i++) {
    const char = html[i]!
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '>') return i
    if (value && (char === '"' || char === "'")) quote = char
    if (char === '=') value = true
    else if (!/\s/.test(char)) value = false
  }
  return -1
}

interface UseSpan {
  start: number
  end: number
  openEnd: number
  closeStart: number
  selfClosing: boolean
  /** read leniently: an open tag whose end never came, taken as empty */
  unclosed?: boolean
}

/** The next `tag` (`<doop-use` or `</doop-use`) from `from` that is one: followed by the end of
 *  its name (not `<doop-user-chip>`), and outside a script, style, textarea, title or comment. */
function nextTag(html: string, tag: string, from: number, opaque: [number, number][]): number {
  let at = indexOfAscii(html, tag, from)
  while (at !== -1) {
    const following = html[at + tag.length]
    const inOpaque = opaque.some(([a, b]) => at >= a && at < b)
    if (following && /[\s/>]/.test(following) && !inOpaque) return at
    at = indexOfAscii(html, tag, at + 1)
  }
  return -1
}

/**
 * Is a position inside a tag, that is, in an attribute's value? An instance's marker keeps
 * rewritten children as markup in a JSON attribute (`data-doop-overrides`, an `html`
 * override), and that markup may hold a `<doop-use>` of its own: text of the attribute, not
 * an element of the document. Expanded where it stands it would break the attribute apart.
 * Answers for positions asked in rising order, walking the document's tags once.
 */
function tagWalker(html: string, opaque: [number, number][]): (at: number) => boolean {
  /* everything before this is outside any tag */
  let from = 0
  /* the opaque ranges come in document order: the first one not yet passed */
  let ahead = 0
  return (at) => {
    while (from < at) {
      const open = html.indexOf('<', from)
      if (open === -1 || open >= at) return false
      while (ahead < opaque.length && opaque[ahead]![1] <= open) ahead++
      const skipped = opaque[ahead]
      if (skipped && open >= skipped[0]) {
        from = skipped[1]
        continue
      }
      const next = html[open + 1]
      /* as the HTML tokenizer has it: a `<` that starts no tag is text */
      if (!next || !/[a-zA-Z/!?]/.test(next)) {
        from = open + 1
        continue
      }
      const end = documentTagEnd(html, open)
      /* a tag still being written (mid-stream): whatever follows is inside it */
      if (end === -1 || at < end) return true
      from = end + 1
    }
    return false
  }
}

/** The next complete `<doop-use>` from `from`. `lenient` (a whole write, nothing more to come)
 *  takes an open tag whose end never came as empty, so the ones after it still expand. */
function nextUse(
  html: string,
  from: number,
  opaque: [number, number][],
  insideTag: (at: number) => boolean,
  lenient = false,
): UseSpan | undefined {
  const open = `<${USE_TAG}`
  const close = `</${USE_TAG}`
  let start = nextTag(html, open, from, opaque)
  while (start !== -1 && insideTag(start)) start = nextTag(html, open, start + 1, opaque)
  if (start === -1) return undefined
  const openEnd = tagEnd(html, start)
  if (openEnd === -1) return undefined
  if (html[openEnd - 1] === '/') {
    return { start, end: openEnd + 1, openEnd, closeStart: openEnd + 1, selfClosing: true }
  }
  let depth = 1
  let cursor = openEnd + 1
  while (depth > 0) {
    const nextOpen = nextTag(html, open, cursor, opaque)
    const nextClose = nextTag(html, close, cursor, opaque)
    if (nextClose === -1)
      return lenient
        ? { start, end: openEnd + 1, openEnd, closeStart: openEnd + 1, selfClosing: true, unclosed: true }
        : undefined
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const innerEnd = tagEnd(html, nextOpen)
      if (innerEnd === -1) return undefined
      if (html[innerEnd - 1] !== '/') depth++
      cursor = innerEnd + 1
    } else {
      depth--
      const closeEnd = html.indexOf('>', nextClose)
      if (closeEnd === -1) return undefined
      if (depth === 0) return { start, end: closeEnd + 1, openEnd, closeStart: nextClose, selfClosing: false }
      cursor = closeEnd + 1
    }
  }
  return undefined
}

/* the attribute itself, never the end of another's name (data-component) */
const COMPONENT_ATTR_VALUE = /\scomponent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/i

/** The component an open tag names, as written. */
function componentRefIn(openTag: string): string {
  const match = COMPONENT_ATTR_VALUE.exec(openTag)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
}

/** What a whole write does with a `<doop-use>` it leaves open: places it with no slot content. */
function unclosedIssue(ref: string): ComponentIssue {
  return {
    code: 'unclosed_use',
    component: ref,
    message: `<${USE_TAG} component="${ref}"> was never closed with </${USE_TAG}>, so it was placed with no slot content. Close every <${USE_TAG}>, or write it self-closing.`,
  }
}

/** The `<doop-use>` a whole write cannot read to its end (a quote never closed): the reader stops
 *  there, so it and everything after it stay as written. */
function stuckUse(html: string, from: number, opaque: [number, number][]): string | undefined {
  const at = nextTag(html, `<${USE_TAG}`, from, opaque)
  if (at === -1) return undefined
  const end = html.indexOf('>', at)
  return componentRefIn(html.slice(at, end === -1 ? undefined : end + 1))
}

/** The component of each `<doop-use>` a whole write of this markup would leave open, in document
 *  order: what `expandUses` reports as `unclosed_use`, for markup that is parsed rather than
 *  expanded (a component's template). A tag nested in an open one counts towards its parent. */
export function unclosedUses(html: string): string[] {
  if (indexOfAscii(html, `<${USE_TAG}`) === -1) return []
  const opaque = opaqueRanges(html)
  const refs: string[] = []
  let cursor = 0
  const insideTag = tagWalker(html, opaque)
  for (
    let span = nextUse(html, 0, opaque, insideTag, true);
    span;
    span = nextUse(html, cursor, opaque, insideTag, true)
  ) {
    if (span.unclosed) refs.push(componentRefIn(html.slice(span.start, span.openEnd)))
    cursor = span.end
  }
  const stuck = stuckUse(html, cursor, opaque)
  return stuck === undefined ? refs : [...refs, stuck]
}

/** Every complete `<doop-use>` in the HTML, written out in full. One still missing
 *  its end (mid-stream) stays as it is until a later pass; on a whole write (`final`)
 *  nothing more is coming, so it is taken as empty and reported. */
/** Every outermost `<doop-use>` as a placeholder that keeps its source text, nothing parsed
 *  and nothing rendered: what a frame is read as when rendering it failed. */
export function placeholdUses(html: string): string {
  if (indexOfAscii(html, `<${USE_TAG}`) === -1) return html
  const opaque = opaqueRanges(html)
  const insideTag = tagWalker(html, opaque)
  let out = ''
  let cursor = 0
  for (let span = nextUse(html, 0, opaque, insideTag); span; span = nextUse(html, cursor, opaque, insideTag)) {
    const use = html.slice(span.start, span.end)
    out += html.slice(cursor, span.start) + lostUsePlaceholder(use, useRef(use))
    cursor = span.end
  }
  return out + html.slice(cursor)
}

/** The tags whose opens and closes an edit must keep paired (`tagBalance`). */
export const BALANCED_TAGS = [USE_TAG, 'template'] as const
export type BalancedTag = (typeof BALANCED_TAGS)[number]

const BALANCED_TAG = /<(\/?)(doop-use|template)(?=[\s/>]|$)/gi

/** How a piece of HTML leaves one of the `BALANCED_TAGS`: `net`, how many more it opens than
 *  it closes; `low`, the most it has closed beyond what it opened at any point (0 or less). */
export interface TagCount {
  net: number
  low: number
}

/**
 * How a piece of HTML opens and closes each `BALANCED_TAGS` tag, read the way `expandUses`
 * reads a document: tags inside a script, style, textarea, title or comment, and text inside
 * another tag's attribute (an instance's override JSON), are not tags. A self-closing
 * `<doop-use/>` is complete; a `<template/>` opens one, as the HTML parser has it.
 */
export function tagBalance(html: string): Record<BalancedTag, TagCount> {
  const balance: Record<BalancedTag, TagCount> = { [USE_TAG]: { net: 0, low: 0 }, template: { net: 0, low: 0 } }
  const opaque = opaqueRanges(html)
  const insideTag = tagWalker(html, opaque)
  for (const match of html.matchAll(BALANCED_TAG)) {
    const at = match.index
    if (opaque.some(([a, b]) => at >= a && at < b) || insideTag(at)) continue
    const tag = match[2]!.toLowerCase() as BalancedTag
    const count = balance[tag]
    if (match[1]) {
      count.net--
      count.low = Math.min(count.low, count.net)
      continue
    }
    const end = tagEnd(html, at)
    if (tag === USE_TAG && end !== -1 && html[end - 1] === '/') continue
    count.net++
  }
  return balance
}

export function expandUses(
  html: string,
  ctx: EngineContext,
  stack: string[] = [],
  depth = 0,
  { final = false }: { final?: boolean } = {},
): string {
  /* a reference kept as a placeholder is tried again whenever stored HTML is read */
  if (ctx.lost) html = reviveLostUses(html)
  if (indexOfAscii(html, `<${USE_TAG}`) === -1) return html
  const opaque = opaqueRanges(html)
  const insideTag = tagWalker(html, opaque)
  const next = (from: number) => nextUse(html, from, opaque, insideTag, final)
  let out = ''
  let cursor = 0
  for (let span = next(0); span; span = next(cursor)) {
    out += html.slice(cursor, span.start)
    if (span.unclosed) ctx.issues.push(unclosedIssue(componentRefIn(html.slice(span.start, span.openEnd))))
    out += expandOne(html, span, ctx, stack, depth)
    cursor = span.end
  }
  /* a tag that cannot be read to its end leaves it and the rest as written: no less left open */
  const stuck = final ? stuckUse(html, cursor, opaque) : undefined
  if (stuck !== undefined) ctx.issues.push(unclosedIssue(stuck))
  return out + html.slice(cursor)
}

/** Slot or override content, which is whole by the time it renders (a closed use's slot, an
 *  overrides string), mid-stream too: a <doop-use> it leaves open is placed empty, never left for
 *  the parser to close, and its issue says no later chunk can close it (`inOverride`). */
function expandOverride(html: string, ctx: EngineContext, depth: number | undefined): string {
  const from = ctx.issues.length
  const out = expandUses(html, ctx, [], depth, { final: true })
  for (const issue of ctx.issues.slice(from)) if (issue.code === 'unclosed_use') issue.inOverride = true
  return out
}

function expandOne(html: string, span: UseSpan, ctx: EngineContext, stack: string[], depth: number): string {
  const openTag = html.slice(span.start, span.openEnd + 1).replace(/\/>$/, '>')
  const inner = span.selfClosing ? '' : html.slice(span.openEnd + 1, span.closeStart)
  const use = elementKids(parseFragment(`${openTag}${inner}</${USE_TAG}>`))[0]
  /* stored HTML being read back: the reference stays, as a placeholder that keeps its text */
  const lost = (ref: string, why: string) => ctx.lost?.(html.slice(span.start, span.end), ref, why) ?? ''
  if (!use) {
    ctx.issues.push({ code: 'unknown_component', message: `a <${USE_TAG}> could not be read, so it was left out` })
    return lost('', 'the reference could not be read')
  }
  const ref = attrOf(use, 'component') ?? ''
  const def = ctx.find(ref)
  if (!def) {
    ctx.issues.push({ code: 'unknown_component', message: `no component “${ref}” on this canvas` })
    return lost(ref, 'no such component on this canvas')
  }
  /* a deleted component takes no new use. One a template already holds (it wears its part
     key) is not new: a component built from a deleted one keeps rendering as it did. Nor is
     one read back from storage: its frame was stored before the delete */
  if (isDeleted(def) && attrOf(use, PART_ATTR) === undefined && !ctx.lost) {
    ctx.issues.push({
      code: 'deleted_component',
      message: `“${def.name}” was deleted from this canvas, so it was not placed. Restore it (restore_component) to use it again, or use another component.`,
    })
    return ''
  }
  const state = stateFromUseAttrs(use, def, ctx)
  let root: Element | undefined
  try {
    root = renderInstance(def, def, state.overrides, state.instanceId, { ctx, stack, depth })
  } catch (error) {
    if (!(error instanceof UnrenderableUse) || !ctx.lost) throw error
    return lost(ref, error.why)
  }
  if (!root) return lost(ref, 'the component renders nothing')
  /* a template read back by update_component keeps the nested instance's key, and its overrides
     with it. One that names none gets no key from the component it renders: that is the
     component's own root key, the same for every use of it, so a second keyless use in a main
     took the key of the first (agent reports, 2026-11-11). The main gives it one of its own */
  setAttr(root, PART_ATTR, attrOf(use, PART_ATTR) ?? null)
  return serializeOuter(root)
}

/* ------------------------------------------------------------------ */
/* Whole-document passes                                               */
/* ------------------------------------------------------------------ */

export interface Located {
  el: Element
  start: number
  end: number
}

/** Outermost elements with a marker, by source range. Nothing below a found one is visited. */
export function findMarked(html: string, attribute: string): Located[] {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const found: Located[] = []
  const stack: ChildNode[] = [...doc.childNodes].reverse()
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!isElement(node)) continue
    const location = node.sourceCodeLocation
    if (attrOf(node, attribute) !== undefined && location) {
      found.push({ el: node, start: location.startOffset, end: location.endOffset })
      continue
    }
    for (const child of [...node.childNodes].reverse()) stack.push(child)
  }
  return found.sort((a, b) => a.start - b.start)
}

/** Every element with a marker, nested ones too, by source range. */
export function findAllMarked(html: string, attribute: string): Located[] {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const found: Located[] = []
  const stack: ChildNode[] = [...doc.childNodes]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!isElement(node)) continue
    const location = node.sourceCodeLocation
    if (attrOf(node, attribute) !== undefined && location)
      found.push({ el: node, start: location.startOffset, end: location.endOffset })
    stack.push(...node.childNodes)
  }
  return found
}

/** The ones with no other of them inside: a batch of these can be replaced without overlapping. */
export function innermost(found: Located[]): Located[] {
  return found.filter((el) => !found.some((other) => other !== el && other.start >= el.start && other.end <= el.end))
}

/** An instance as plain markup. It keeps a marker of its own, for the stylesheet below to hold on to. */
export function detachedMarkup(el: Element, def: Pick<ComponentDef, 'id' | 'rev'> | undefined): string {
  for (const name of [INSTANCE_ATTR, REV_ATTR, PROPS_ATTR, OVERRIDES_ATTR]) setAttr(el, name, null)
  if (def) setAttr(el, DETACHED_ATTR, detachedKey(def))
  const stack: Element[] = [el]
  for (let node = stack.pop(); node; node = stack.pop()) {
    setAttr(node, PART_ATTR, null)
    stack.push(...elementKids(node).filter((kid) => !attrOf(kid, INSTANCE_ATTR)))
  }
  return serializeOuter(el)
}

const detachedKey = (def: Pick<ComponentDef, 'id' | 'rev'>) => `${def.id}.${def.rev}`

/** The component's rules at the revision that was detached, for elements that no longer follow it.
 *  One copy per revision per frame, however many instances were cut loose. The fonts and
 *  frameworks it brought stay too, as the frame's own tags: `syncComponentHead` drops the
 *  component's marked copies once nothing linked uses them. */
export function withDetachedCss(html: string, def: Pick<ComponentDef, 'id' | 'rev' | 'css' | 'head'>): string {
  const own = def.head.filter((tag) => !html.includes(tag))
  if (own.length) html = insertIntoHead(html, own.join('\n'))
  const key = detachedKey(def)
  if (!def.css.trim() || html.includes(`${DETACHED_CSS_ATTR}="${key}"`)) return html
  const css = def.css
    .replaceAll(`[${INSTANCE_ATTR}="${def.id}"]`, `[${DETACHED_ATTR}="${key}"]`)
    .replaceAll(`__${def.id}`, `__${def.id}-${def.rev}`)
  return insertIntoHead(html, `<style ${DETACHED_CSS_ATTR}="${key}">\n${css}\n</style>`)
}

export function splice(html: string, edits: { start: number; end: number; text: string }[]): string {
  let out = html
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

/**
 * Every outermost instance reconciled (what was edited becomes its overrides) and rendered at
 * its component's current revision; markup that needs nothing stays byte for byte. An instance
 * of a component the canvas does not have becomes plain markup, unless `keepUnknown` (stored
 * HTML being read back, where nothing is to be decided about it).
 */
export function prepareInstances(html: string, ctx: EngineContext, { keepUnknown = false } = {}): string {
  const edits: { start: number; end: number; text: string }[] = []
  for (const found of findMarked(html, INSTANCE_ATTR)) {
    const id = attrOf(found.el, INSTANCE_ATTR) ?? ''
    const def = ctx.find(id)
    if (!def) {
      if (keepUnknown) continue
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
    let rendered: Element | undefined
    try {
      /* only a whole write gets here: nothing more is coming for the content it holds */
      rendered = renderInstance(def, def, state.overrides, state.instanceId, { ctx, stack: [] })
    } catch (error) {
      /* a component it is built from cannot render (contexts with `lost` only): as written */
      if (!(error instanceof UnrenderableUse)) throw error
      continue
    }
    if (!rendered) continue
    /* the key it has is its place in what holds it (a main), not the component's own root key */
    setAttr(rendered, PART_ATTR, attrOf(found.el, PART_ATTR) ?? null)
    const after = serializeOuter(rendered)
    if (after !== before) edits.push({ start: found.start, end: found.end, text: after })
  }
  return edits.length ? splice(html, edits) : html
}

/** Short form of a whole document: instances as `<doop-use>`, their CSS copies gone.
 *  What agents read: a screen of 40 buttons costs 40 lines rather than 40 subtrees. */
export function compactDocument(html: string, ctx: EngineContext): string {
  if (!html.includes(INSTANCE_ATTR) && !html.includes(CSS_ATTR)) return html
  /* an instance of a deleted component stays written out: as <doop-use> it would be a new
     use of it when the frame is written back, and those are refused. One of a hollow
     component too, with its stylesheet: written back as <doop-use> it would render nothing */
  const hollow = hollowIds(html, ctx)
  const instances = findInstancesEverywhere(html).filter(
    (found) => !isDeleted(ctx.find(attrOf(found.el, INSTANCE_ATTR) ?? '')) && !holdsHollow(found.el, ctx),
  )
  /* one inside a main keeps the key the main gave it (its place there, which the main's
     instances' overrides name) and its element id (what comments and links name): saved back
     without them, it would get new ones */
  const edits = instances.map((found) => ({
    start: found.start,
    end: found.end,
    text: insideMain(found.el) ? useTagFor(found.el, ctx, true, false, false, true) : useTagFor(found.el, ctx),
  }))
  return stripComponentHead(splice(html, edits), hollow)
}

/** Outermost instances, also those below a main: the main itself is not an instance. */
export function findInstancesEverywhere(html: string): Located[] {
  return findMarked(html, INSTANCE_ATTR)
}

function insideMain(el: Element): boolean {
  for (let node = el.parentNode; node && isElement(node); node = node.parentNode)
    if (attrOf(node, COMPONENT_ATTR) !== undefined) return true
  return false
}

/** Is this instance, or one nested anywhere inside it, of a hollow component? Rendered again
 *  (or read back as <doop-use>) it would lose that instance, so it is left as written. */
export function holdsHollow(el: Element, ctx: EngineContext): boolean {
  const stack: Element[] = [el]
  for (let node = stack.pop(); node; node = stack.pop()) {
    const id = attrOf(node, INSTANCE_ATTR)
    if (id !== undefined && isHollow(ctx.find(id))) return true
    stack.push(...elementKids(node))
  }
  return false
}

/** The hollow components this document has instances of. */
function hollowIds(html: string, ctx: EngineContext): Set<string> {
  return new Set([...usedComponentIds(html)].filter((id) => isHollow(ctx.find(id))))
}

export { stripComponentHead, syncComponentHead, usedComponentIds }

/* ------------------------------------------------------------------ */
/* Turning a main element into a template                              */
/* ------------------------------------------------------------------ */

const PART_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

export function newPartKey(taken: Set<string>): string {
  for (;;) {
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    let key = ''
    for (const byte of bytes) key += PART_ALPHABET[byte % PART_ALPHABET.length]
    if (!taken.has(key)) {
      taken.add(key)
      return key
    }
  }
}

/** Key every element below (and including) a main that has none, and any second
 *  use of a key (a copy pasted inside the main). Returns whether anything changed.
 *  A `<style>` or `<script>` is keyed like any other element: reconciling needs a
 *  key on every child to match them up, and an unkeyed one would turn a byte-identical
 *  save into an `html` override on its parent. */
export function stampParts(root: Element): boolean {
  const taken = new Set<string>()
  let changed = false
  const visit = (el: Element) => {
    const key = attrOf(el, PART_ATTR)
    if (!key || taken.has(key)) {
      setAttr(el, PART_ATTR, newPartKey(taken))
      changed = true
    } else taken.add(key)
    /* a nested instance is one part of this template; its insides are its own */
    if (attrOf(el, INSTANCE_ATTR)) return
    for (const child of elementKids(el)) visit(child)
  }
  visit(root)
  return changed
}

/** The main's markup as a template: no main marker, no element ids (each instance
 *  gets its own), nested instances compact. */
export function templateFromMain(main: Element, ctx: EngineContext): string {
  const clone = elementKids(rootFragment(serializeOuter(main)))[0]
  if (!clone) return ''
  setAttr(clone, COMPONENT_ATTR, null)
  const walk = (node: Element) => {
    setAttr(node, ELEMENT_ID_ATTR, null)
    compactKeepingParts(node, ctx)
    for (const child of elementKids(node)) if (child.tagName !== USE_TAG) walk(child)
  }
  walk(clone)
  return serializeOuter(clone)
}

/* reconciled: an edit inside a nested instance of the main is part of this write's template */
function compactKeepingParts(node: Element, ctx: EngineContext) {
  node.childNodes = node.childNodes.map((child) =>
    isElement(child) && attrOf(child, INSTANCE_ATTR) ? useElementFor(child, ctx, node, true, true) : child,
  )
}

/** Carry the old keys onto a rewritten template, element by element where tag and
 *  place line up, so an agent resending a main does not orphan every override. */
export function alignParts(next: Element, previous: Element | undefined) {
  const written = new Set<string>()
  const stack: Element[] = [next]
  for (let el = stack.pop(); el; el = stack.pop()) {
    const key = attrOf(el, PART_ATTR)
    if (key) written.add(key)
    stack.push(...elementKids(el))
  }
  alignWith(next, previous, written)
}

/**
 * A child that names a key is matched to the old child with that key, never by place. One
 * that names none takes the place of an old child that nothing claimed: inserting a keyless
 * element before a keyed one used to hand it that one's key (overrides and all) and re-key
 * the owner as a duplicate (agent reports, 2026-11-11). `written` holds every key the new
 * markup names, and the keys handed out so far: none of them is handed out again.
 */
function alignWith(next: Element, previous: Element | undefined, written: Set<string>) {
  if (!previous || next.tagName !== previous.tagName) return
  if (!attrOf(next, PART_ATTR)) {
    const key = attrOf(previous, PART_ATTR)
    if (key && !written.has(key)) {
      setAttr(next, PART_ATTR, key)
      written.add(key)
    }
  }
  const oldKids = elementKids(previous)
  const oldByKey = new Map<string, Element>()
  for (const kid of oldKids) {
    const key = attrOf(kid, PART_ATTR)
    if (key) oldByKey.set(key, kid)
  }
  const free = oldKids.filter((kid) => {
    const key = attrOf(kid, PART_ATTR)
    return !key || !written.has(key)
  })
  const seenOfTag = new Map<string, number>()
  for (const kid of elementKids(next)) {
    const key = attrOf(kid, PART_ATTR)
    if (key) {
      alignWith(kid, oldByKey.get(key), written)
      continue
    }
    const index = seenOfTag.get(kid.tagName) ?? 0
    seenOfTag.set(kid.tagName, index + 1)
    alignWith(kid, free.filter((candidate) => candidate.tagName === kid.tagName)[index], written)
  }
}

/* ------------------------------------------------------------------ */
/* Props and slots from a template                                     */
/* ------------------------------------------------------------------ */

const declaredOf = (declared: ComponentProp[], name: string) => declared.find((prop) => prop.name === name)

/** The props a template actually uses, with what was declared about them.
 *  Enum props live only in the declaration: their effect is `data-<name>` on the root. */
export function derivePropsAndSlots(
  template: string,
  declared: ComponentProp[],
): { props: ComponentProp[]; slots: ComponentSlot[] } {
  const root = parseTemplateRoot(template)
  const props = new Map<string, ComponentProp>()
  for (const prop of declared) if (prop.type === 'enum' && isPropName(prop.name)) props.set(prop.name, prop)
  const slots: ComponentSlot[] = []
  if (!root) return { props: [...props.values()], slots }
  const stack: Element[] = [root]
  const order: Element[] = []
  for (let el = stack.pop(); el; el = stack.pop()) {
    order.push(el)
    stack.push(...elementKids(el).reverse())
  }
  for (const el of order) {
    for (const { target, prop } of parseBindings(attrOf(el, BIND_ATTR) ?? '', el.tagName)) {
      if (props.has(prop)) continue
      const known = declaredOf(declared, prop)
      const type = target === 'src' ? 'image' : target === 'href' ? 'link' : 'text'
      props.set(prop, {
        name: prop,
        type: known?.type ?? type,
        /* a boolean's default decides what its conditions show; text-like ones are the template's own content */
        ...(known?.type === 'boolean' && known.default !== undefined ? { default: known.default } : {}),
        ...descriptionOf(known),
      })
    }
    const condition = parseCondition(attrOf(el, IF_ATTR) ?? '')
    if (condition && isPropName(condition.prop) && !props.has(condition.prop)) {
      const known = declaredOf(declared, condition.prop)
      props.set(condition.prop, {
        name: condition.prop,
        type: known?.type ?? 'boolean',
        default: known?.default ?? 'true',
        ...(known?.options ? { options: known.options } : {}),
        ...descriptionOf(known),
      })
    }
    const slot = attrOf(el, SLOT_ATTR)
    if (slot !== undefined) {
      slots.push({
        name: slot || 'default',
        suggested: (attrOf(el, SLOT_SUGGEST_ATTR) ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      })
    }
  }
  return { props: [...props.values()], slots }
}

const descriptionOf = (prop: ComponentProp | undefined) => (prop?.description ? { description: prop.description } : {})

/* what an element's text is called when nothing on it says: by what the element is */
const ROLE_NAMES: Record<string, string> = {
  h1: 'title',
  h2: 'title',
  h3: 'title',
  h4: 'title',
  h5: 'title',
  h6: 'title',
  button: 'label',
  a: 'label',
  label: 'label',
  summary: 'label',
  li: 'item',
  figcaption: 'caption',
  caption: 'caption',
  small: 'caption',
  blockquote: 'quote',
  time: 'date',
  th: 'heading',
  td: 'cell',
}

/* a utility class says how an element looks, not what it is: `text-sm`, `mt-2`, `md:flex` */
const UTILITY_CLASS =
  /[:[\]/.]|^-|^(flex|grid|block|inline|hidden|relative|absolute|truncate|uppercase|italic|underline|antialiased)$|^(text|font|bg|border|rounded|shadow|leading|tracking|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min|max|gap|flex|grid|inline|items|justify|opacity|whitespace)-/

/** The name an element gives itself: its `data-name`, else its last class that is not a utility. */
function ownPropName(el: Element): string | undefined {
  const classes = (attrOf(el, 'class') ?? '').split(/\s+/).filter((name) => name && !UTILITY_CLASS.test(name))
  const raw = attrOf(el, 'data-name') ?? classes.at(-1) ?? ''
  const name = raw && raw.length < 30 ? toPropName(raw) : 'value'
  return name === 'value' ? undefined : name
}

/** The nearest element, from this one up to the main, whose tag says what its text is. */
function roleName(el: Element, root: Element): string {
  for (let node: Element | undefined = el; node;) {
    const role = ROLE_NAMES[node.tagName]
    if (role) return role
    if (node === root) break
    const parent: ParentNode | null = node.parentNode
    node = parent && isElement(parent) ? parent : undefined
  }
  return el === root ? 'label' : 'text'
}

/** Name what a component would most likely vary: leaf text, image sources, link targets.
 *  Written onto the main as ordinary bindings, so a person or agent can see and change them.
 *  Returns the prop names it made up, in template order. */
export function inferBindings(root: Element, limit = 12): string[] {
  const used = new Set<string>()
  let count = 0
  const take = (base: string) => {
    let candidate = base
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`
    used.add(candidate)
    return candidate
  }
  const stack: Element[] = [root]
  const order: Element[] = []
  for (let el = stack.pop(); el; el = stack.pop()) {
    if (el.tagName === 'style' || el.tagName === 'script' || el.tagName === 'svg') continue
    /* a nested component, written out or still `<doop-use>`: its content is its own */
    if (attrOf(el, INSTANCE_ATTR) || el.tagName === USE_TAG) continue
    order.push(el)
    stack.push(...elementKids(el).reverse())
  }
  for (const el of order) {
    if (count >= limit || attrOf(el, BIND_ATTR) !== undefined || attrOf(el, SLOT_ATTR) !== undefined) continue
    const bindings: string[] = []
    const own = ownPropName(el)
    if (el.tagName === 'img' && attrOf(el, 'src')) bindings.push(`src:${take(own ?? 'image')}`)
    /* a link's target is named beside its text: `cta-link` next to `cta` */
    if (el.tagName === 'a' && attrOf(el, 'href')) bindings.push(`href:${take(own ? `${own}-link` : 'link')}`)
    if (elementKids(el).length === 0 && directText(el)) bindings.push(take(own ?? roleName(el, root)))
    if (bindings.length) {
      setAttr(el, BIND_ATTR, bindings.join(','))
      count += bindings.length
    }
  }
  return [...used]
}

/* ------------------------------------------------------------------ */
/* Shape matching: repeated structures                                 */
/* ------------------------------------------------------------------ */

const MAX_SHAPE_ELEMENTS = 200

export interface Measured {
  /** elements in this subtree, itself included */
  size: number
  /** undefined past MAX_SHAPE_ELEMENTS: nothing that large is one design */
  shape?: string
}

const skipsShape = (el: Element) => el.tagName === 'style' || el.tagName === 'script'

/** Every element's size and shape below a node, bottom-up and without recursion or
 *  re-walking: frame HTML is untrusted, and may nest deeper than the call stack allows.
 *  A shape is tags and classes in order, ignoring content: two elements that share one
 *  are the same design with different words in it. */
export function measureTree(root: ParentNode): Map<Element, Measured> {
  const measured = new Map<Element, Measured>()
  const order: Element[] = []
  const stack: Element[] = elementKids(root)
  if (isElement(root as ChildNode)) stack.push(root as Element)
  for (let el = stack.pop(); el; el = stack.pop()) {
    order.push(el)
    stack.push(...elementKids(el))
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const el = order[i]!
    const kids = elementKids(el)
    const kidValues = kids.map((kid) => measured.get(kid))
    const size = 1 + kidValues.reduce((total, kid) => total + (kid?.size ?? 0), 0)
    const counted = kids.flatMap((kid, index) => (skipsShape(kid) ? [] : [kidValues[index]]))
    if (size > MAX_SHAPE_ELEMENTS || counted.some((kid) => kid?.shape === undefined)) {
      measured.set(el, { size })
      continue
    }
    const classes = (attrOf(el, 'class') ?? '').split(/\s+/).filter(Boolean).sort().join('.')
    const inner = counted.map((kid) => kid?.shape).join(',')
    measured.set(el, { size, shape: `${el.tagName}${classes ? `.${classes}` : ''}(${inner})` })
  }
  return measured
}

export function shapeOf(el: Element): string | undefined {
  return measureTree(el).get(el)?.shape
}

export function elementCount(el: Element): number {
  return measureTree(el).get(el)?.size ?? 1
}

export function kidsOf(el: ParentNode): Element[] {
  return elementKids(el)
}
