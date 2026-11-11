import { createHash } from 'node:crypto'
import { parse, parseFragment, serialize, serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import {
  BIND_ATTR,
  COMPONENT_ATTR,
  CSS_ATTR,
  DETACHED_ATTR,
  DETACHED_CSS_ATTR,
  IF_ATTR,
  HEAD_ATTR,
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
  isPropName,
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

export type Revision = Pick<ComponentDef, 'id' | 'name' | 'template' | 'props' | 'rev'>

export interface EngineContext {
  /** a component by id or name */
  find(ref: string): ComponentDef | undefined
  /** a component as it was at a revision, when that revision is still kept */
  atRev(id: string, rev: number): Revision | undefined
  issues: ComponentIssue[]
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

function setChildrenFromHtml(el: Element, html: string) {
  const fragment = parseFragment(html)
  el.childNodes = fragment.childNodes
  for (const child of el.childNodes) child.parentNode = el
}

export function parseTemplateRoot(template: string): Element | undefined {
  return elementKids(parseFragment(template))[0]
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
  for (const { target, prop } of parseBindings(raw)) {
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
  const content = (html: string) => expandUses(html, options.ctx, [], options.depth)
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
    return undefined
  }
  const state = part?.use ?? stateFromUseAttrs(use, nested, options.ctx).overrides
  const id = attrOf(use, ELEMENT_ID_ATTR) ?? nestedInstanceId(options.ownerId, outerKey)
  const rendered = renderInstance(nested, nested, state, id, options)
  if (rendered && outerKey) setAttr(rendered, PART_ATTR, outerKey)
  return rendered
}

function markRoot(root: Element, def: Revision, instanceId: string, overrides: InstanceOverrides) {
  setAttr(root, INSTANCE_ATTR, def.id)
  setAttr(root, REV_ATTR, String(def.rev))
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
  if (!root) return undefined
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
  const clone = parseFragment(serialize(el))
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
  const parts = new Map<string, PartInfo>()
  const root = parseTemplateRoot(template)
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
      for (const { target, prop } of parseBindings(attrOf(el, BIND_ATTR) ?? '')) {
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
 *  plus slot content and nested instances found in place. Nothing is diffed here. */
export function readInstance(el: Element, def: Revision | undefined, ctx: EngineContext): InstanceState | undefined {
  const state = readMarker(el)
  if (!state) return undefined
  if (!def) return state
  const parts = partsOf(def.template)
  const merged: Record<string, PartOverride> = { ...state.overrides.parts }
  /* by the template's key: a nested root wears the outer component's on it */
  const rootKey = attrOf(parseTemplateRoot(def.template) ?? el, PART_ATTR)
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
      if (nested) merged[key] = { ...merged[key], use: nested.overrides }
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
  const clone = parseFragment(serialize(el))
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
  const nested = ctx.find(reconciled.componentId)
  const defaults = nested ? stateFromUseAttrs(use, nested, ctx).overrides : {}
  const same = stableJson(defaults) === stableJson(reconciled.overrides)
  mergeInto(state, key, {}, { use: same ? undefined : reconciled.overrides })
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
  const parts = partsOf(revision.template)
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
  if (rootKey || attrOf(parseTemplateRoot(revision.template)!, PART_ATTR)) {
    const key = attrOf(parseTemplateRoot(revision.template)!, PART_ATTR) ?? rootKey!
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
): string {
  const marker = readMarker(el)
  if (!marker) return serializeOuter(el)
  const def = ctx.find(marker.componentId)
  const revision = ctx.atRev(marker.componentId, marker.rev) ?? def
  const state = (reconcile ? reconcileInstance(el, ctx) : undefined) ?? readInstance(el, revision, ctx) ?? marker
  const ref = byId ? marker.componentId : (def?.name ?? marker.componentId)
  return useMarkup(ref, state, revision, inTemplate ? attrOf(el, PART_ATTR) : undefined)
}

export function useMarkup(
  name: string,
  state: InstanceState,
  def: Revision | undefined,
  part: string | undefined,
): string {
  const rest: Record<string, PartOverride> = {}
  const slotChildren: string[] = []
  const slotParts = def ? partsOf(def.template) : new Map<string, PartInfo>()
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
  else if (isElementId(state.instanceId)) tag += attrText('id', state.instanceId)
  for (const [prop, value] of Object.entries(state.overrides.props ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    tag += attrText(prop, value)
  if (Object.keys(rest).length) tag += attrText('overrides', stableJson(rest))
  return `${tag}>${slotChildren.join('')}</${USE_TAG}>`
}

/** Build an instance's overrides from a `<doop-use>`'s attributes, reporting what does not fit. */
export function stateFromUseAttrs(use: Element, def: Revision, ctx: EngineContext): InstanceState {
  const props: Record<string, string> = {}
  let parts: Record<string, PartOverride> = {}
  const root = parseTemplateRoot(def.template)
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
    rev: def.rev,
    overrides: clean({ props, parts }),
  }
}

function assignSlots(use: Element, def: Revision, parts: Record<string, PartOverride>) {
  const slotParts = [...partsOf(def.template)].filter(([, info]) => info.isSlot)
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

function serializeOuterWithoutSlot(el: Element): string {
  setAttr(el, 'slot', null)
  return serializeOuter(el)
}

/* ------------------------------------------------------------------ */
/* Expanding `<doop-use>` at string level: a parser would foster-parent */
/* one out of a <table>, and the rest of the document stays byte-exact. */
/* ------------------------------------------------------------------ */

const OPAQUE = /<(script|style|textarea|title)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi

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

interface UseSpan {
  start: number
  end: number
  openEnd: number
  closeStart: number
  selfClosing: boolean
}

function nextUse(html: string, from: number, opaque: [number, number][]): UseSpan | undefined {
  const lower = html.toLowerCase()
  const open = `<${USE_TAG}`
  const close = `</${USE_TAG}`
  let start = lower.indexOf(open, from)
  while (start !== -1) {
    const at = start
    const following = html[at + open.length]
    if (following && /[\s/>]/.test(following) && !opaque.some(([a, b]) => at >= a && at < b)) break
    start = lower.indexOf(open, at + 1)
  }
  if (start === -1) return undefined
  const openEnd = tagEnd(html, start)
  if (openEnd === -1) return undefined
  if (html[openEnd - 1] === '/') {
    return { start, end: openEnd + 1, openEnd, closeStart: openEnd + 1, selfClosing: true }
  }
  let depth = 1
  let cursor = openEnd + 1
  while (depth > 0) {
    const nextOpen = lower.indexOf(open, cursor)
    const nextClose = lower.indexOf(close, cursor)
    if (nextClose === -1) return undefined
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

/** Every complete `<doop-use>` in the HTML, written out in full. One still missing
 *  its end (mid-stream) stays as it is until a later pass. */
export function expandUses(html: string, ctx: EngineContext, stack: string[] = [], depth = 0): string {
  if (!html.toLowerCase().includes(`<${USE_TAG}`)) return html
  const opaque = opaqueRanges(html)
  let out = ''
  let cursor = 0
  for (let span = nextUse(html, 0, opaque); span; span = nextUse(html, cursor, opaque)) {
    out += html.slice(cursor, span.start)
    out += expandOne(html, span, ctx, stack, depth)
    cursor = span.end
  }
  return out + html.slice(cursor)
}

function expandOne(html: string, span: UseSpan, ctx: EngineContext, stack: string[], depth: number): string {
  const openTag = html.slice(span.start, span.openEnd + 1).replace(/\/>$/, '>')
  const inner = span.selfClosing ? '' : html.slice(span.openEnd + 1, span.closeStart)
  const use = elementKids(parseFragment(`${openTag}${inner}</${USE_TAG}>`))[0]
  if (!use) return ''
  const ref = attrOf(use, 'component') ?? ''
  const def = ctx.find(ref)
  if (!def) {
    ctx.issues.push({ code: 'unknown_component', message: `no component “${ref}” on this canvas` })
    return ''
  }
  const state = stateFromUseAttrs(use, def, ctx)
  const root = renderInstance(def, def, state.overrides, state.instanceId, { ctx, stack, depth })
  if (!root) return ''
  /* a template read back by update_component keeps the nested instance's key, and its overrides with it */
  const part = attrOf(use, PART_ATTR)
  if (part) setAttr(root, PART_ATTR, part)
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

/** Short form of a whole document: instances as `<doop-use>`, their CSS copies gone.
 *  What agents read: a screen of 40 buttons costs 40 lines rather than 40 subtrees. */
export function compactDocument(html: string, ctx: EngineContext): string {
  if (!html.includes(INSTANCE_ATTR) && !html.includes(CSS_ATTR)) return html
  const instances = findInstancesEverywhere(html)
  const edits = instances.map((found) => ({ start: found.start, end: found.end, text: useTagFor(found.el, ctx) }))
  return stripComponentHead(splice(html, edits))
}

/** Outermost instances, also those below a main: the main itself is not an instance. */
export function findInstancesEverywhere(html: string): Located[] {
  return findMarked(html, INSTANCE_ATTR)
}

/** Everything a component put in the head: its stylesheet, and the links and scripts it brought. */
export function stripComponentHead(html: string): string {
  return html
    .replace(new RegExp(`<style[^>]*\\b${CSS_ATTR}="[^"]*"[^>]*>[\\s\\S]*?</style>\\n?`, 'gi'), '')
    .replace(new RegExp(`<script[^>]*\\s${HEAD_ATTR}(?:="[^"]*")?[\\s>][^>]*>[\\s\\S]*?</script>\\n?`, 'gi'), '')
    .replace(new RegExp(`<link[^>]*\\s${HEAD_ATTR}(?:="[^"]*")?[\\s>/][^>]*>\\n?`, 'gi'), '')
}

/** A head tag with the mark that says a component brought it, so `frameHeadTags` and the next
 *  `syncComponentHead` can tell it from the frame's own. */
function markedHeadTag(tag: string): string {
  return tag.replace(/^<(link|script)\b/i, `<$1 ${HEAD_ATTR}`)
}

/** Every component an instance in this document uses, nested ones included. */
export function usedComponentIds(html: string): Set<string> {
  const ids = new Set<string>()
  /* the leading space: an element's attribute, not a selector in a stylesheet */
  for (const match of html.matchAll(new RegExp(`\\s${INSTANCE_ATTR}="([^"]+)"`, 'g'))) ids.add(match[1]!)
  return ids
}

/** Put exactly the component stylesheets this document needs into its head. */
export function syncComponentHead(html: string, defs: ComponentDef[]): string {
  const stripped = stripComponentHead(html)
  const blocks: string[] = []
  for (const def of defs) {
    /* a tag the frame has of its own, or one another component already brought, is not repeated */
    for (const tag of def.head) {
      const marked = markedHeadTag(tag)
      if (!stripped.includes(tag) && !blocks.includes(marked)) blocks.push(marked)
    }
    if (def.css.trim()) blocks.push(`<style ${CSS_ATTR}="${def.id}">\n${def.css}\n</style>`)
  }
  if (!blocks.length) return stripped === html ? html : stripped
  const next = insertIntoHead(stripped, blocks.join('\n'))
  return next
}

function insertIntoHead(html: string, block: string): string {
  const close = /<\/head\s*>/i.exec(html)
  if (close) return `${html.slice(0, close.index)}${block}\n${html.slice(close.index)}`
  const open = /<head\b[^>]*>/i.exec(html)
  if (open) return `${html.slice(0, open.index + open[0].length)}\n${block}${html.slice(open.index + open[0].length)}`
  const body = /<body\b[^>]*>/i.exec(html)
  if (body) return `${html.slice(0, body.index)}<head>\n${block}\n</head>${html.slice(body.index)}`
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  const at = doctype ? doctype[0].length : 0
  return `${html.slice(0, at)}${block}\n${html.slice(at)}`
}

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
  const clone = elementKids(parseFragment(serializeOuter(main)))[0]
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
  if (!previous || next.tagName !== previous.tagName) return
  if (!attrOf(next, PART_ATTR)) {
    const key = attrOf(previous, PART_ATTR)
    if (key) setAttr(next, PART_ATTR, key)
  }
  const oldKids = elementKids(previous)
  const seenOfTag = new Map<string, number>()
  for (const kid of elementKids(next)) {
    const index = seenOfTag.get(kid.tagName) ?? 0
    seenOfTag.set(kid.tagName, index + 1)
    alignParts(kid, oldKids.filter((candidate) => candidate.tagName === kid.tagName)[index])
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
    for (const { target, prop } of parseBindings(attrOf(el, BIND_ATTR) ?? '')) {
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

/** Name what a component would most likely vary: leaf text, image sources, link targets.
 *  Written onto the main as ordinary bindings, so a person or agent can see and change them. */
export function inferBindings(root: Element, limit = 12): number {
  const used = new Set<string>()
  let count = 0
  const nameFor = (el: Element, fallback: string) => {
    const name = attrOf(el, 'data-name') ?? attrOf(el, 'class')?.split(/\s+/).at(-1) ?? ''
    const base = toPropName(name && name.length < 30 ? name : fallback)
    let candidate = base === 'value' ? fallback : base
    for (let n = 2; used.has(candidate); n++) candidate = `${base === 'value' ? fallback : base}-${n}`
    used.add(candidate)
    return candidate
  }
  const stack: Element[] = [root]
  const order: Element[] = []
  for (let el = stack.pop(); el; el = stack.pop()) {
    if (el.tagName === 'style' || el.tagName === 'script' || el.tagName === 'svg') continue
    if (attrOf(el, INSTANCE_ATTR)) continue
    order.push(el)
    stack.push(...elementKids(el).reverse())
  }
  for (const el of order) {
    if (count >= limit || attrOf(el, BIND_ATTR) !== undefined || attrOf(el, SLOT_ATTR) !== undefined) continue
    const bindings: string[] = []
    if (el.tagName === 'img' && attrOf(el, 'src')) bindings.push(`src:${nameFor(el, 'image')}`)
    if (el.tagName === 'a' && attrOf(el, 'href')) bindings.push(`href:${nameFor(el, 'link')}`)
    if (elementKids(el).length === 0 && directText(el)) bindings.push(nameFor(el, el === root ? 'label' : 'text'))
    if (bindings.length) {
      setAttr(el, BIND_ATTR, bindings.join(','))
      count += bindings.length
    }
  }
  return count
}

/* ------------------------------------------------------------------ */
/* Shape matching: lookalikes and repeated structures                  */
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
