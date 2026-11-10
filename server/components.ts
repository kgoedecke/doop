import { customAlphabet } from 'nanoid'
import { serializeOuter } from 'parse5'
import {
  COMPONENT_ATTR,
  CSS_ATTR,
  HEAD_ATTR,
  INSTANCE_ATTR,
  MAX_COMPONENT_HISTORY,
  OVERRIDES_ATTR,
  PROPS_ATTR,
  REV_ATTR,
  USE_TAG,
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
import { store } from './store.ts'
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

export function contextFor(canvasId: string): EngineContext {
  const defs = () => store.getComponents(canvasId)
  const find = (ref: string) => {
    const wanted = ref.trim().toLowerCase()
    return defs().find((def) => def.id === ref) ?? defs().find((def) => def.name.toLowerCase() === wanted)
  }
  return {
    find,
    atRev(id, rev) {
      const def = defs().find((candidate) => candidate.id === id)
      if (!def) return undefined
      if (def.rev === rev) return def
      const snapshot = def.history.find((entry) => entry.rev === rev)
      return snapshot ? { id, name: def.name, rev, template: snapshot.template, props: snapshot.props } : undefined
    },
    issues: [],
  }
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

function prepareMains(canvas: Canvas, frameId: string, html: string, by: string, ctx: EngineContext) {
  const changed: ComponentDef[] = []
  const claimed = new Set<string>()
  const edits: { start: number; end: number; text: string }[] = []
  const sheet = () => frameStylesheets(html)
  const headTags = () => frameHeadTags(html)
  for (const found of findMarked(html, COMPONENT_ATTR)) {
    const id = attrOf(found.el, COMPONENT_ATTR) ?? ''
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
    const mainElsewhere =
      def.mainFrameId !== null &&
      def.mainFrameId !== frameId &&
      !!store.getFrame(def.mainFrameId)?.html.includes(`${COMPONENT_ATTR}="${id}"`)
    if (claimed.has(id) || mainElsewhere || !frameId) {
      /* a copy of a main is an instance, the way copying a Figma main is */
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
      same || def.rev === 0
        ? { ...def, rev: def.rev || 1, updatedAt: Date.now(), updatedBy: by }
        : bumpRevision(def, by)
    const saved = { ...next, template, css, rawCss, head, props, slots, mainFrameId: frameId }
    store.saveComponent(canvas.id, saved)
    if (!same) changed.push(saved)
  }
  /* a main this frame held and no longer does: the component lives on without one */
  for (const def of store.getComponents(canvas.id)) {
    if (def.mainFrameId !== frameId || !frameId || claimed.has(def.id)) continue
    if (html.includes(`${COMPONENT_ATTR}="${def.id}"`)) continue
    const saved = { ...def, mainFrameId: null, updatedAt: Date.now(), updatedBy: by }
    store.saveComponent(canvas.id, saved)
  }
  return { html: edits.length ? splice(html, edits) : html, changed }
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
    const before = serializeOuter(found.el)
    const state = reconcileInstance(found.el, ctx)
    if (!state) continue
    const rendered = renderInstance(def, def, state.overrides, state.instanceId, { ctx, stack: [] })
    if (!rendered) continue
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
    if (lost) prepareMains(canvas, frameId, incoming, by, contextFor(canvas.id))
    return { html: incoming, issues: removedInstanceIssues(priorHtml, incoming), changed: [] }
  }
  const ctx = contextFor(canvas.id)
  try {
    const expanded = expandUses(incoming, ctx)
    const mains = prepareMains(canvas, frameId, expanded, by, ctx)
    const instances = prepareInstances(mains.html, ctx)
    const html = syncComponentHead(instances, closureOf(usedComponentIds(instances), canvas.id))
    return {
      html,
      issues: dedupeIssues([...ctx.issues, ...removedInstanceIssues(priorHtml, html)]),
      changed: mains.changed,
    }
  } catch (error) {
    /* markup nested past the call stack: the write itself still has to land */
    if (!(error instanceof RangeError)) throw error
    return {
      html: incoming,
      issues: [{ code: 'too_deep', message: 'this markup is nested too deeply for its components to be updated' }],
      changed: [],
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

function dedupeIssues(issues: ComponentIssue[]): ComponentIssue[] {
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
export function prepareChunk(canvas: Canvas, chunk: string, soFar: string): string {
  if (!chunk.toLowerCase().includes(`<${USE_TAG}`)) return chunk
  const ctx = contextFor(canvas.id)
  const expanded = expandUses(chunk, ctx)
  const styles = closureOf(usedComponentIds(expanded), canvas.id)
    .filter((def) => def.css.trim() && !soFar.includes(`${CSS_ATTR}="${def.id}"`))
    .map((def) => `<style ${CSS_ATTR}="${def.id}">\n${def.css}\n</style>`)
  return `${styles.join('\n')}${expanded}`
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
