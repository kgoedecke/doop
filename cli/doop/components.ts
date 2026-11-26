import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { callJson } from './client.ts'
import { numberFlag, type Context } from './context.ts'
import { CliError, EXIT, usage } from './errors.ts'
import {
  componentsDir,
  hashOf,
  saveState,
  slugOf,
  type ComponentMeta,
  type Project,
  type TrackedComponent,
} from './project.ts'

/**
 * Components as local files, beside the frames: `<dir>/components/<slug>.html` is the template
 * (one root element), `.css` its rules and `.json` its name, description and props. A push
 * sends only the parts that changed, with the revision the files came from as `expected_rev`,
 * so a component somebody changed on the canvas since is refused by the server in the same
 * write (a conflict, as for a frame, but with no gap between the check and the write).
 * Components that follow a workspace library are changed in the library's canvas and are not
 * pulled.
 */

interface ComponentDoc {
  id: string
  name: string
  description?: string
  rev: number
  props: unknown[]
  template: string
  css: string | null
  main_frame_id: string | null
}

interface Listed {
  id: string
  name: string
  library?: { name: string }
}

/** One step of a pull or a push, for frames and components alike. */
export interface SyncPart {
  lines: string[]
  results: unknown[]
  conflicts: string[]
}

interface Local {
  html: string | undefined
  /** undefined when the file is not there, which is not the same as an empty stylesheet */
  css: string | undefined
  meta: ComponentMeta | undefined
}

function metaOf(doc: ComponentDoc): ComponentMeta {
  return {
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.props.length ? { props: doc.props } : {}),
  }
}

function sameMeta(a: ComponentMeta | undefined, b: ComponentMeta): boolean {
  const canonical = (meta: ComponentMeta) =>
    JSON.stringify({ name: meta.name, description: meta.description ?? '', props: meta.props ?? [] })
  return a !== undefined && canonical(a) === canonical(b)
}

function readLocal(project: Project, base: string): Local {
  const read = (ext: string) => {
    const path = join(project.root, `${base}.${ext}`)
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  }
  const json = read('json')
  let meta: ComponentMeta | undefined
  if (json !== undefined) {
    try {
      meta = JSON.parse(json) as ComponentMeta
    } catch {
      throw usage(`${base}.json is not JSON`, 'it holds { "name": "Button", "description": "…", "props": […] }')
    }
  }
  return { html: read('html'), css: read('css'), meta }
}

function writeFiles(project: Project, base: string, doc: ComponentDoc): void {
  const path = join(project.root, base)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.html`, doc.template)
  writeFileSync(`${path}.css`, doc.css ?? '')
  writeFileSync(`${path}.json`, `${JSON.stringify(metaOf(doc), null, 2)}\n`)
}

function track(project: Project, base: string, doc: ComponentDoc): void {
  project.components[base] = {
    id: doc.id,
    rev: doc.rev,
    html: hashOf(doc.template),
    css: hashOf(doc.css ?? ''),
    meta: metaOf(doc),
  }
  saveState(project)
}

/** Whether the canvas's component is still what was last pulled or pushed. */
function sameAsTracked(doc: ComponentDoc, tracked: TrackedComponent): boolean {
  return (
    hashOf(doc.template) === tracked.html &&
    hashOf(doc.css ?? '') === tracked.css &&
    sameMeta(metaOf(doc), tracked.meta)
  )
}

/** Which parts of the local files differ from what was last pulled or pushed. */
function changedParts(local: Local, tracked: TrackedComponent): { html: boolean; css: boolean; meta: boolean } {
  return {
    html: local.html !== undefined && hashOf(local.html) !== tracked.html,
    css: local.css !== undefined && hashOf(local.css) !== tracked.css,
    meta: local.meta !== undefined && !sameMeta(local.meta, tracked.meta),
  }
}

function baseFor(project: Project, doc: { id: string; name: string }): string {
  const tracked = Object.entries(project.components).find(([, entry]) => entry.id === doc.id)
  if (tracked) return tracked[0]
  const base = `${componentsDir(project)}/${slugOf(doc.name)}`
  return project.components[base] ? `${base}-${doc.id.slice(0, 4).toLowerCase()}` : base
}

async function readComponent(context: Context, ref: string): Promise<ComponentDoc> {
  return (
    await callJson<ComponentDoc>(context.connection, 'get_component', {
      canvas_id: context.canvasId(),
      component: ref,
    })
  ).value
}

/* ------------------------------------------------------------------ */
/* pull                                                                */

type PullOutcome = 'pulled' | 'up to date' | 'local changes kept' | 'conflict'

function pullOne(project: Project, doc: ComponentDoc, force: boolean): { base: string; outcome: PullOutcome } {
  const base = baseFor(project, doc)
  const local = readLocal(project, base)
  const tracked = project.components[base]
  const write = (): { base: string; outcome: PullOutcome } => {
    writeFiles(project, base, doc)
    track(project, base, doc)
    return { base, outcome: 'pulled' }
  }
  if (force) return write()
  if (local.html === undefined) {
    /* the template file is gone, but an edit to the component's CSS or JSON is still the
       user's: writing the canvas's three files over it would lose it without a word */
    const edited = tracked
      ? changedParts(local, tracked)
      : {
          css: local.css !== undefined && local.css !== (doc.css ?? ''),
          meta: local.meta !== undefined && !sameMeta(local.meta, metaOf(doc)),
        }
    if (!edited.css && !edited.meta) return write()
    /* the canvas holds what was pulled: its template is the one that went missing, so it comes
       back beside the edit, which a push then sends. The revision is taken too, as it may have
       moved past the pulled one through a change made and undone */
    if (tracked && sameAsTracked(doc, tracked)) {
      writeFileSync(join(project.root, `${base}.html`), doc.template)
      track(project, base, doc)
      return { base, outcome: 'local changes kept' }
    }
    return { base, outcome: 'conflict' }
  }
  if (local.html === doc.template && (local.css ?? '') === (doc.css ?? '') && sameMeta(local.meta, metaOf(doc))) {
    track(project, base, doc)
    return { base, outcome: 'up to date' }
  }
  const changed = tracked ? changedParts(local, tracked) : undefined
  if (changed && !changed.html && !changed.css && !changed.meta) return write()
  if (tracked && doc.rev === tracked.rev) return { base, outcome: 'local changes kept' }
  return { base, outcome: 'conflict' }
}

/** Pulls the canvas's own components (all of them, or the ones whose files are named), and
 *  answers which frames are their mains: those are the components themselves, on the canvas's
 *  Components page, and are left out when every frame is pulled. */
export async function pullComponents(
  context: Context,
  project: Project,
  bases: string[],
): Promise<SyncPart & { mainFrameIds: Set<string> }> {
  const { value } = await callJson<{ components: Listed[] }>(context.connection, 'list_components', {
    canvas_id: context.canvasId(),
  })
  const wanted = new Set(bases.map((base) => project.components[base]?.id ?? base.split('/').at(-1)))
  const part: SyncPart & { mainFrameIds: Set<string> } = {
    lines: [],
    results: [],
    conflicts: [],
    mainFrameIds: new Set(),
  }
  for (const listed of value.components) {
    if (bases.length && !wanted.has(listed.id) && !wanted.has(slugOf(listed.name))) continue
    if (listed.library) {
      part.lines.push(`${'library'.padEnd(18)} ${listed.name}  (changed in “${listed.library.name}”, not here)`)
      continue
    }
    const doc = await readComponent(context, listed.id)
    if (doc.main_frame_id) part.mainFrameIds.add(doc.main_frame_id)
    const { base, outcome } = pullOne(project, doc, context.flags.force === true)
    part.results.push({ file: `${base}.html`, id: doc.id, name: doc.name, rev: doc.rev, outcome })
    part.lines.push(`${outcome.padEnd(18)} ${base}.{html,css,json}  (component ${doc.name}, revision ${doc.rev})`)
    if (outcome === 'conflict') part.conflicts.push(`${base}.html`)
  }
  /* a tracked component deleted on the canvas: its files stay, as files of the user's */
  if (!bases.length) {
    const there = new Set(value.components.map((listed) => listed.id))
    for (const [base, tracked] of Object.entries(project.components)) {
      if (there.has(tracked.id)) continue
      delete project.components[base]
      part.lines.push(
        `${'gone'.padEnd(18)} ${base}.{html,css,json}  (deleted on the canvas: the files are kept and no longer tracked)`,
      )
    }
    saveState(project)
  }
  return part
}

/* ------------------------------------------------------------------ */
/* push                                                                */

type PushOutcome = 'pushed' | 'created' | 'unchanged' | 'conflict'

function nameFromBase(base: string): string {
  const words = (base.split('/').at(-1) ?? '').replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1) || 'Component'
}

async function pushOne(
  context: Context,
  project: Project,
  base: string,
): Promise<{ base: string; outcome: PushOutcome; id?: string; name?: string; rev?: number; filesUpdated?: boolean }> {
  const local = readLocal(project, base)
  if (local.html === undefined) throw new CliError(`${base}.html does not exist`, EXIT.notFound)
  const tracked = project.components[base]
  const force = context.flags.force === true
  let id: string
  if (tracked) {
    const changed = changedParts(local, tracked)
    if (!changed.html && !changed.css && !changed.meta && !force) return { base, outcome: 'unchanged', id: tracked.id }
    const meta = local.meta
    try {
      const written = await callJson<unknown>(context.connection, 'update_component', {
        canvas_id: context.canvasId(),
        component: tracked.id,
        ...(force ? {} : { expected_rev: tracked.rev }),
        /* a name or description change does not move the revision, so `expected_rev` cannot
           catch someone else's: the server checks the pulled ones in the same write */
        ...(changed.meta && !force
          ? { expected_name: tracked.meta.name, expected_description: tracked.meta.description ?? '' }
          : {}),
        ...(changed.html || force ? { html: local.html } : {}),
        ...(local.css !== undefined && (changed.css || force) ? { css: local.css } : {}),
        ...(changed.meta && meta
          ? {
              ...(meta.name !== tracked.meta.name ? { name: meta.name } : {}),
              ...((meta.description ?? '') !== (tracked.meta.description ?? '')
                ? { description: meta.description ?? '' }
                : {}),
              ...(JSON.stringify(meta.props ?? []) !== JSON.stringify(tracked.meta.props ?? [])
                ? { props: meta.props ?? [] }
                : {}),
            }
          : {}),
      })
      context.heard(written.result)
    } catch (error) {
      /* the server's own refusal of a stale `expected_rev`, name or description */
      if (error instanceof CliError && /someone changed it; read it again/.test(error.message))
        return { base, outcome: 'conflict', id: tracked.id }
      if (error instanceof CliError && error.exitCode === EXIT.notFound)
        throw new CliError(
          `the component behind ${base}.html is gone from the canvas`,
          EXIT.notFound,
          '`doop pull` stops tracking it and keeps the files; to make it again, push its .html by path afterwards',
        )
      throw error
    }
    id = tracked.id
  } else {
    const created = await callJson<{ component: { id: string } }>(context.connection, 'create_component', {
      canvas_id: context.canvasId(),
      name: local.meta?.name ?? context.flags.name ?? nameFromBase(base),
      html: local.html,
      ...(local.css?.trim() ? { css: local.css } : {}),
      ...(local.meta?.description ? { description: local.meta.description } : {}),
      ...(local.meta?.props?.length ? { props: local.meta.props } : {}),
      width: numberFlag(context.flags.width, 'width'),
      height: numberFlag(context.flags.height, 'height'),
    })
    context.heard(created.result)
    id = created.value.component.id
  }
  /* the canvas keys each element of a template (data-doop-part) and may infer props: the
     files take what it stored, as the base of the next edit */
  const stored = await readComponent(context, id)
  const filesUpdated =
    stored.template !== local.html || (stored.css ?? '') !== (local.css ?? '') || !sameMeta(local.meta, metaOf(stored))
  if (filesUpdated) writeFiles(project, base, stored)
  track(project, base, stored)
  return { base, outcome: tracked ? 'pushed' : 'created', id, name: stored.name, rev: stored.rev, filesUpdated }
}

/** Tracked components whose files changed since the last pull or push. */
export function changedComponents(project: Project): string[] {
  return Object.entries(project.components)
    .filter(([base, tracked]) => {
      const local = readLocal(project, base)
      /* a template that is not there has nothing to push, as a missing frame file has not */
      if (local.html === undefined) return false
      const changed = changedParts(local, tracked)
      return changed.html || changed.css || changed.meta
    })
    .map(([base]) => base)
}

export async function pushComponents(context: Context, project: Project, bases: string[]): Promise<SyncPart> {
  const part: SyncPart = { lines: [], results: [], conflicts: [] }
  for (const base of bases) {
    const pushed = await pushOne(context, project, base)
    part.results.push({ ...pushed, file: `${base}.html` })
    const target = pushed.name ? ` → component ${pushed.name}, revision ${pushed.rev}` : ''
    const extra =
      pushed.outcome === 'conflict'
        ? '  changed on the canvas since the last pull'
        : pushed.filesUpdated
          ? '  · files rewritten as the canvas stored them: read them again before editing'
          : ''
    part.lines.push(`${pushed.outcome.padEnd(9)} ${base}.{html,css,json}${target}${extra}`)
    if (pushed.outcome === 'conflict') part.conflicts.push(`${base}.html`)
  }
  return part
}

/** The component a path belongs to, when it is a pulled one. */
export function trackedComponent(project: Project | null, base: string | undefined): TrackedComponent | undefined {
  return project && base ? project.components[base] : undefined
}
