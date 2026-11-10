import { parse, parseFragment, serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { canvasPages } from '../shared/pages.ts'
import {
  BIND_ATTR,
  COMPONENT_ATTR,
  INSTANCE_ATTR,
  MAX_COMPONENTS,
  MAX_COMPONENT_DESCRIPTION,
  MAX_COMPONENT_NAME,
  PART_ATTR,
  PROP_TYPES,
  REV_ATTR,
  SLOT_ATTR,
  SOURCE_CSS_ATTR,
  USE_TAG,
  componentSignature,
  isPropName,
  type ComponentCode,
  type ComponentDef,
  type ComponentProp,
  type InstanceOverrides,
  type PartOverride,
} from '../shared/components.ts'
import { ELEMENT_ID_ATTR, elementIdSelector } from '../shared/elementId.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import { decodeQuotes, familyKey, fontFaceRule, usesFamily, type CustomFont } from '../shared/fonts.ts'
import { fontsForCanvas } from './fonts.ts'
import * as actions from './actions.ts'
import { blankComponent, bumpRevision, contextFor, referencesComponent } from './components.ts'
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
import { resolveElement } from './elementIds.ts'
import { store } from './store.ts'

/**
 * What a person or an agent can do with components. Each operation ends in an
 * ordinary frame write through actions.ts, so history, sign-off, the room and
 * propagation all behave as they do for any other edit. The MCP tools, the
 * resident agent and the REST routes share these, so they cannot drift apart.
 * Spec: .context/specs/components.md.
 */

export class ComponentError extends Error {}

type Element = Tree.Element

const COMPONENTS_PAGE = 'Components'

function fail(message: string): never {
  throw new ComponentError(message)
}

export function findComponent(canvasId: string, ref: string): ComponentDef | undefined {
  return contextFor(canvasId).find(ref)
}

function requireComponent(canvasId: string, ref: string): ComponentDef {
  const def = findComponent(canvasId, ref)
  if (def) return def
  const names = store.getComponents(canvasId).map((candidate) => candidate.name)
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
  const taken = store
    .getComponents(canvasId)
    .some((def) => def.id !== except && def.name.toLowerCase() === clean.toLowerCase())
  if (taken) fail(`this canvas already has a component named “${clean}” — update it, or pick another name`)
  return clean
}

/** The name itself when no component here has it, else "<name> (library)",
 *  "<name> (library 2)", … so two imports of a shared name stay apart. */
export function freeName(canvasId: string, name: string): string {
  const names = new Set(store.getComponents(canvasId).map((def) => def.name.toLowerCase()))
  if (!names.has(name.toLowerCase())) return name
  for (let n = 1; ; n++) {
    /* the suffix always fits: a name at the limit is shortened to make room, then checked */
    const suffix = n === 1 ? ' (library)' : ` (library ${n})`
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

export interface ComponentUsage {
  instances: number
  frames: { id: string; name: string; instances: number; approved: boolean }[]
}

export function usageOf(canvas: Canvas, id: string): ComponentUsage {
  const marker = ` ${INSTANCE_ATTR}="${id}"`
  const frames = canvas.frames.flatMap((frame) => {
    const instances = frame.html.split(marker).length - 1
    return instances
      ? [{ id: frame.id, name: frame.name, instances, approved: frame.approval?.status === 'ready_for_dev' }]
      : []
  })
  return { instances: frames.reduce((total, frame) => total + frame.instances, 0), frames }
}

export function usageExample(def: ComponentDef): string {
  const props = def.props
    .filter((prop) => prop.type !== 'boolean')
    .slice(0, 4)
    .map((prop) => ` ${prop.name}="${prop.options?.[0] ?? `…`}"`)
    .join('')
  const slots = def.slots.map((slot) => `<template slot="${slot.name}">…</template>`).join('')
  return `<${USE_TAG} component="${def.name}"${props}>${slots}</${USE_TAG}>`
}

/** The one-line catalog entry: little to read, enough to use the component without another call. */
export function catalogEntry(canvas: Canvas, def: ComponentDef) {
  return {
    id: def.id,
    name: def.name,
    signature: componentSignature(def),
    ...(def.description ? { description: def.description } : {}),
    usage: usageExample(def),
    instances: usageOf(canvas, def.id).instances,
    ...(def.mainFrameId ? {} : { main_missing: true }),
    ...(def.code ? { code: def.code } : {}),
    ...updateAvailable(def),
  }
}

function updateAvailable(def: ComponentDef) {
  if (!def.source) return {}
  const origin = store.getComponents(def.source.canvasId).find((candidate) => candidate.id === def.source?.componentId)
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
  return {
    ...catalogEntry(canvas, def),
    rev: def.rev,
    props: def.props,
    slots: def.slots,
    /* what update_component's html and find/replace work on */
    template: def.template,
    css: def.rawCss,
    parts,
    main_frame_id: def.mainFrameId,
    main_image_url: def.mainFrameId ? `/i/${def.mainFrameId}.png?scale=2` : null,
    usage_by_frame: usageOf(canvas, def.id).frames,
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
  /** a data-doop-id, or a selector from find_component_candidates */
  element: string
  autoProps?: boolean
  /** also turn every other element of the same shape on the canvas into an instance */
  replaceMatching?: boolean
}

export interface CreateResult {
  component: ComponentDef
  converted: { frameId: string; instances: number }[]
}

function checkCapacity(canvasId: string) {
  if (store.getComponents(canvasId).length >= MAX_COMPONENTS)
    fail(`a canvas holds at most ${MAX_COMPONENTS} components`)
}

function selectorFor(element: string): string {
  return /^[a-z0-9]{6}$/.test(element) ? elementIdSelector(element) : element
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

export function createComponentFromElement(canvasId: string, input: CreateFromElement, actor: Actor): CreateResult {
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
  store.saveComponent(canvasId, def)
  try {
    setAttr(el, COMPONENT_ATTR, def.id)
    stampParts(el)
    if (input.autoProps !== false && !hasBindings(el)) inferBindings(el)
    const html = splice(frame.html, [{ start: located.start, end: located.end, text: serializeOuter(el) }])
    actions.updateFrame(frame.id, { html }, actor)
  } catch (error) {
    /* a write that failed leaves no main-less component holding the name */
    store.deleteComponent(canvasId, def.id)
    throw error
  }
  const saved = requireComponent(canvasId, def.id)
  const converted = input.replaceMatching ? convertMatching(canvasId, shape, saved, actor) : []
  actions.logComponent(canvasId, actor, `made “${saved.name}” a component`)
  return { component: requireComponent(canvasId, def.id), converted }
}

const clip = (text: string | undefined) => text?.slice(0, MAX_COMPONENT_DESCRIPTION)

function hasBindings(el: Element): boolean {
  if (attrOf(el, BIND_ATTR) !== undefined) return true
  return kidsOf(el).some(hasBindings)
}

function locate(html: string, element: string) {
  const doc = parse(html, { sourceCodeLocationInfo: true })
  const el = resolveElement(doc, selectorFor(element))
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
${root}
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
  const roots = kidsOf(parseFragment(html.trim())).filter((el) => el.tagName !== 'style' && el.tagName !== 'script')
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
export function createComponentFromHtml(canvasId: string, input: CreateFromHtml, actor: Actor): ComponentDef {
  checkCapacity(canvasId)
  const name = validName(input.name, canvasId)
  const def = blankComponent({
    name,
    description: clip(input.description),
    props: validProps(input.props),
    code: input.code,
    by: actor.name,
  })
  store.saveComponent(canvasId, def)
  try {
    const root = singleRoot(input.html)
    if (input.autoProps !== false && !hasBindings(root)) inferBindings(root)
    setAttr(root, COMPONENT_ATTR, def.id)
    writeNewMain(canvasId, def, serializeOuter(root), input.css ?? '', actor, input.width, input.height)
  } catch (error) {
    store.deleteComponent(canvasId, def.id)
    throw error
  }
  actions.logComponent(canvasId, actor, `created component “${name}”`)
  return requireComponent(canvasId, def.id)
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
  const pageId = componentsPageId(canvasId, actor)
  const frame = actions.createFrame(canvasId, { name: def.name, pageId, width, height, html: '' }, actor)
  if (!frame) fail('canvas not found')
  actions.updateFrame(frame.id, { html: mainFrameDoc(def, root, rawCss) }, actor)
  return store.getFrame(frame.id) ?? frame
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
  }
}

function orphanedOverrides(canvas: Canvas, def: ComponentDef, template: string) {
  const keys = new Set(partsOf(template).keys())
  const ctx = contextFor(canvas.id)
  const orphaned: UpdateResult['impact']['overrides_orphaned'] = []
  for (const frame of canvas.frames) {
    if (!referencesComponent(frame.html, def.id)) continue
    for (const found of findMarked(frame.html, INSTANCE_ATTR)) {
      if (attrOf(found.el, INSTANCE_ATTR) !== def.id) continue
      const state = readInstance(found.el, def, ctx)
      const parts = Object.keys(state?.overrides.parts ?? {}).filter((key) => !keys.has(key))
      if (state && parts.length) orphaned.push({ frame_id: frame.id, instance_id: state.instanceId, parts })
    }
  }
  return orphaned
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
    if (count === 0) fail('find text is not in the template — read it with get_component')
    if (count > 1) fail(`find text occurs ${count} times — include more context so it matches once`)
    return def.template.replace(input.find, input.replace ?? '')
  }
  return input.html
}

export function updateComponent(canvasId: string, ref: string, input: UpdateInput, actor: Actor): UpdateResult {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  const def = requireComponent(canvasId, ref)
  if (input.expectedRev !== undefined && input.expectedRev !== def.rev)
    fail(
      `component “${def.name}” is at revision ${def.rev}, not ${input.expectedRev} — someone changed it; read it again`,
    )
  const html = nextHtml(def, input)
  const nextRoot = html !== undefined ? alignedRoot(html, def) : undefined
  const usage = usageOf(canvas, def.id)
  const impact: UpdateResult['impact'] = {
    instances: usage.instances,
    frames: usage.frames,
    approvals_affected: usage.frames.filter((frame) => frame.approved).length,
    overrides_orphaned: nextRoot ? orphanedOverrides(canvas, def, stampedTemplate(nextRoot)) : [],
  }
  if (input.dryRun) return { component: def, dry_run: true, impact }

  const nextProps = input.props !== undefined ? validProps(input.props) : undefined
  const propsChanged = nextProps !== undefined && JSON.stringify(nextProps) !== JSON.stringify(def.props)
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

  if (nextRoot || input.css !== undefined || input.props !== undefined) {
    const root = nextRoot ?? alignedRoot(def.template, def)
    writeMain(canvasId, meta, root, input.css, actor, input.head ? def.head : undefined)
  } else actions.broadcastComponent(canvasId, requireComponent(canvasId, def.id), actor)
  /* new defaults change what instances render even when the main's markup did not move */
  if (propsChanged) actions.propagateComponents(canvasId, [requireComponent(canvasId, def.id)], actor)
  if (input.name !== undefined && def.mainFrameId && store.getFrame(def.mainFrameId)?.name === def.name) {
    actions.updateFrame(def.mainFrameId, { name: meta.name }, actor)
  }
  actions.logComponent(canvasId, actor, `updated component “${meta.name}”`)
  return { component: requireComponent(canvasId, def.id), dry_run: false, impact }
}

function stampedTemplate(root: Element): string {
  const clone = kidsOf(parseFragment(serializeOuter(root)))[0]!
  stampParts(clone)
  return serializeOuter(clone)
}

/** Put new markup in the main's place, or give the component a new main if it lost it. */
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
  let html = splice(frame.html, [{ start: located.start, end: located.end, text: rendered }])
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

export function insertInstance(
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
  const instanceId = instanceIds(next.html).find((id) => !before.has(id)) ?? ''
  return { frame: next, instanceId }
}

function instanceIds(html: string): string[] {
  return findMarked(html, INSTANCE_ATTR).flatMap((found) => attrOf(found.el, ELEMENT_ID_ATTR) ?? [])
}

function insertAt(html: string, markup: string, target: string | undefined, position: InstancePosition): string {
  if (target) {
    const doc = parse(html, { sourceCodeLocationInfo: true })
    const el = resolveElement(doc, selectorFor(target))
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
export function changeInstances(
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
}

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

/** Remove a component; every instance keeps its look as plain markup, and its main stays too. */
export function deleteComponent(canvasId: string, ref: string, actor: Actor) {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) fail('canvas not found')
  const def = requireComponent(canvasId, ref)
  const dependents = store
    .getComponents(canvasId)
    .filter((other) => other.id !== def.id && /component="([^"]+)"/.test(other.template))
    .filter((other) =>
      [...other.template.matchAll(/component="([^"]+)"/g)].some((m) => m[1] === def.id || m[1] === def.name),
    )
  if (dependents.length)
    fail(
      `“${def.name}” is used inside ${dependents.map((other) => `“${other.name}”`).join(', ')} — remove it there first`,
    )
  /* gone from the store first, so these writes treat its main as plain markup */
  store.deleteComponent(canvasId, def.id)
  let detached = 0
  for (const frame of [...canvas.frames]) {
    if (!referencesComponent(frame.html, def.id)) continue
    const cut = detachAll(frame.html, def)
    detached += cut.count
    actions.updateFrame(frame.id, { html: cut.html }, actor)
  }
  actions.broadcastComponentDeleted(canvasId, def.id, actor)
  actions.logComponent(
    canvasId,
    actor,
    `deleted component “${def.name}”; ${detached} instance${detached === 1 ? '' : 's'} kept as plain markup`,
  )
  return { deleted: def.name, instances_detached: detached }
}

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
 *  should turn into components, typically in a canvas that grew without any. */
export function findComponentCandidates(canvas: Canvas, limit = 12) {
  const { shapes, sizes } = collectShapes(canvas)
  const groups = [...shapes]
    .filter(([, occurrences]) => occurrences.length >= 2)
    .map(([shape, occurrences]) => ({ shape, occurrences, size: sizes.get(occurrences[0]!.el) ?? 1 }))
    .sort((a, b) => b.size * b.occurrences.length - a.size * a.occurrences.length)
  const covered = new Set<Element>()
  const candidates: ReturnType<typeof describeCandidate>[] = []
  for (const group of groups) {
    const fresh = group.occurrences.filter((occurrence) => !covered.has(occurrence.el))
    if (fresh.length < 2) continue
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
  const template = parseTemplateRoot(def.template)
  if (!canvas || !template || !shape) return []
  const converted: CreateResult['converted'] = []
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
  }
  return converted
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
  const defs = store.getComponents(frame.canvasId).filter((def) => def.template)
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
  const origin = findComponent(sourceCanvasId, ref)
  if (!origin) fail(`no component “${ref}” on canvas ${sourceCanvasId}`)
  const ctxIds = new Set<string>()
  importDependencies(targetCanvasId, sourceCanvasId, origin, actor, ctxIds)
  return requireComponent(targetCanvasId, origin.id)
}

function importDependencies(
  targetCanvasId: string,
  sourceCanvasId: string,
  origin: ComponentDef,
  actor: Actor,
  seen: Set<string>,
): boolean {
  if (seen.has(origin.id)) return false
  seen.add(origin.id)
  let changed = false
  for (const match of origin.template.matchAll(/component="([^"]+)"/g)) {
    const dependency = findComponent(sourceCanvasId, match[1]!)
    if (dependency && importDependencies(targetCanvasId, sourceCanvasId, dependency, actor, seen)) changed = true
  }
  const existing = store.getComponents(targetCanvasId).find((def) => def.id === origin.id)
  if (existing) {
    if (existing.source?.canvasId === sourceCanvasId && existing.source.rev === origin.rev) return changed
    pullFrom(targetCanvasId, existing, origin, sourceCanvasId, actor)
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
  store.saveComponent(targetCanvasId, { ...def, head: origin.head })
  const root = parseTemplateRoot(origin.template)
  if (!root) fail(`component “${origin.name}” has no markup`)
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
  if (!canRead(def.source.canvasId)) fail('this account cannot read that library canvas')
  const origin = findComponent(def.source.canvasId, def.source.componentId)
  if (!origin) fail('its library no longer has this component')
  /* the whole tree: a nested component can move without this one moving, and this one can start using new ones */
  const updated = importDependencies(canvasId, def.source.canvasId, origin, actor, new Set())
  return { component: requireComponent(canvasId, def.id), updated }
}
