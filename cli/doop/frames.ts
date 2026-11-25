import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { FrameConflict, createFrame, readFrameHtml, writeFrameHtml, type FrameMeta, type Written } from './api.ts'
import { numberFlag, type Context, type Outcome } from './context.ts'
import { CliError, EXIT, usage } from './errors.ts'
import type { SyncPart } from './components.ts'
import {
  fileForFrame,
  hashOf,
  projectPath,
  requireProject,
  saveState,
  type Project,
  type TrackedFrame,
} from './project.ts'

/**
 * Frames as local files. `pull` writes a frame's HTML to disk, the agent edits it with its own
 * tools, `push` sends it back. The state file remembers the hash both sides last agreed on, so a
 * frame somebody changed on the canvas in the meantime is a conflict rather than an overwrite.
 * That includes a comment left on an element: it stamps a data-doop-id into the frame, which a
 * push from the older file would strip, taking the comment's anchor with it.
 * A push goes to the agent API with the version the file came from (`If-Match`), so the server
 * refuses a stale one in the same step as the write.
 */

interface FrameDoc extends FrameMeta {
  html: string
}

export async function readFrame(context: Context, id: string): Promise<FrameDoc> {
  const { html, frame } = await readFrameHtml(context.connection, id)
  return { ...frame, html }
}

/** What the server said beside a write, for the end of the command's output. */
function hear(context: Context, written: Written): void {
  for (const warning of written.warnings) if (!context.warnings.includes(warning)) context.warnings.push(warning)
  for (const note of written.notes) if (!context.notes.includes(note)) context.notes.push(note)
  for (const item of written.feedback)
    context.feedback.push(
      `HUMAN FEEDBACK from ${item.from}${item.about ? ` (about ${item.about})` : ''}: ${item.text}\n` +
        'This request is now assigned to you: address it before continuing your plan.',
    )
}

function sizeOf(frame: { width: number; height: number }): string {
  return `${Math.round(frame.width)}×${Math.round(frame.height)}`
}

/* ------------------------------------------------------------------ */
/* pull                                                                */

type PullOutcome = 'pulled' | 'up to date' | 'local changes kept' | 'conflict'

function pullOne(project: Project, doc: FrameDoc, force: boolean): { file: string; outcome: PullOutcome } {
  const file = fileForFrame(project, doc)
  const path = join(project.root, file)
  const remoteHash = hashOf(doc.html)
  const tracked = project.frames[file]
  const local = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const write = (): { file: string; outcome: PullOutcome } => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, doc.html)
    project.frames[file] = { id: doc.id, name: doc.name, hash: remoteHash, version: doc.version }
    return { file, outcome: 'pulled' }
  }
  if (local === undefined || force) return write()
  const localHash = hashOf(local)
  if (localHash === remoteHash) {
    project.frames[file] = { id: doc.id, name: doc.name, hash: remoteHash, version: doc.version }
    return { file, outcome: 'up to date' }
  }
  if (tracked && localHash === tracked.hash) return write()
  if (tracked && remoteHash === tracked.hash) return { file, outcome: 'local changes kept' }
  return { file, outcome: 'conflict' }
}

/** Pulls the named frames, or the tracked ones, or (the first time, with --all or --ready)
 *  the canvas's: all but hidden frames and `skip`, the components' mains, which are pulled as
 *  components. */
export async function pullFrames(
  context: Context,
  project: Project,
  refs: string[],
  skip: Set<string>,
): Promise<SyncPart> {
  const tracked = Object.values(project.frames)
  const everything = context.flags.all || context.flags.ready || (!refs.length && !tracked.length)
  let targets: { id: string; name: string }[]
  if (refs.length) targets = await Promise.all(refs.map((ref) => context.resolveFrame(ref)))
  else if (everything) {
    const { frames } = await context.canvas()
    targets = frames.filter(
      (frame) =>
        !frame.hidden && !skip.has(frame.id) && (!context.flags.ready || frame.approvalStatus === 'ready_for_dev'),
    )
  } else targets = tracked

  const results: { file: string; id: string; name: string; size: string; outcome: PullOutcome }[] = []
  const gone: string[] = []
  for (const target of targets) {
    const doc = await readFrame(context, target.id).catch((error: unknown) => {
      /* a tracked frame deleted on the canvas: its file stays, as a file of the user's */
      if (!refs.length && error instanceof CliError && error.exitCode === EXIT.notFound) return undefined
      throw error
    })
    if (!doc) {
      for (const [file, entry] of Object.entries(project.frames))
        if (entry.id === target.id) {
          delete project.frames[file]
          gone.push(`${'gone'.padEnd(18)} ${file}  (deleted on the canvas: the file is kept and no longer tracked)`)
        }
      saveState(project)
      continue
    }
    results.push({
      ...pullOne(project, doc, context.flags.force === true),
      id: doc.id,
      name: doc.name,
      size: sizeOf(doc),
    })
    saveState(project)
  }
  return {
    lines: [
      ...results.map((entry) => `${entry.outcome.padEnd(18)} ${entry.file}  (${entry.name}, ${entry.size})`),
      ...gone,
    ],
    results,
    conflicts: results.filter((entry) => entry.outcome === 'conflict').map((entry) => entry.file),
  }
}

/* ------------------------------------------------------------------ */
/* push                                                                */

type PushOutcome = 'pushed' | 'created' | 'unchanged' | 'conflict'

interface PushResult {
  file: string
  outcome: PushOutcome
  id?: string
  name?: string
  /** the canvas stored the markup differently than it was sent, and the file now matches it */
  fileUpdated?: boolean
  changedBy?: string
}

function nameFromFile(file: string): string {
  const words = basename(file)
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1) || 'Frame'
}

/** Sends a tracked file against the version it came from. A frame that moved on without its
 *  HTML changing (renamed, moved, approved) is written at its new version; one whose HTML
 *  changed is a conflict, and the server writes nothing either way until the versions agree. */
async function replaceFrame(
  context: Context,
  tracked: TrackedFrame,
  html: string,
): Promise<Written | { conflict: FrameMeta }> {
  if (context.flags.force) return writeFrameHtml(context.connection, tracked.id, html)
  try {
    return await writeFrameHtml(context.connection, tracked.id, html, tracked.version)
  } catch (error) {
    if (!(error instanceof FrameConflict)) throw error
    const current = await readFrame(context, tracked.id)
    if (hashOf(current.html) !== tracked.hash) return { conflict: current }
    return writeFrameHtml(context.connection, tracked.id, html, current.version).catch((again: unknown) => {
      if (again instanceof FrameConflict) return { conflict: again.frame }
      throw again
    })
  }
}

async function pushOne(context: Context, project: Project, file: string): Promise<PushResult> {
  const path = join(project.root, file)
  if (!existsSync(path)) throw new CliError(`${file} does not exist`, EXIT.notFound)
  const html = readFileSync(path, 'utf8')
  const tracked = project.frames[file]
  let written: Written
  if (tracked) {
    if (hashOf(html) === tracked.hash && !context.flags.force) return { file, outcome: 'unchanged', id: tracked.id }
    const answer = await replaceFrame(context, tracked, html).catch((error: unknown) => {
      if (error instanceof CliError && error.exitCode === EXIT.notFound)
        throw new CliError(
          `the frame behind ${file} is gone from the canvas`,
          EXIT.notFound,
          `to push it as a new frame, remove "${file}" from .doop/state.json and run \`doop push ${file}\``,
        )
      throw error
    })
    if ('conflict' in answer)
      return {
        file,
        outcome: 'conflict',
        id: tracked.id,
        changedBy: `${answer.conflict.updatedBy}, ${answer.conflict.updatedAt}`,
      }
    written = answer
  } else {
    written = await createFrame(context.connection, context.canvasId(), html, {
      name: context.flags.name ?? nameFromFile(file),
      width: numberFlag(context.flags.width, 'width'),
      height: numberFlag(context.flags.height, 'height'),
      ...(context.flags.page ? { page: context.flags.page } : {}),
    })
  }
  hear(context, written)
  /* what the canvas stored is the file's new base. Where it differs from what was sent (a
     component instance rests as a <doop-use> reference, escaped markup is decoded), the file
     takes that form so the next push starts from what is there */
  const stored = written.html_changed ? await readFrame(context, written.frame.id) : { ...written.frame, html }
  if (written.html_changed) writeFileSync(path, stored.html)
  project.frames[file] = { id: stored.id, name: stored.name, hash: hashOf(stored.html), version: stored.version }
  saveState(project)
  return {
    file,
    outcome: tracked ? 'pushed' : 'created',
    id: stored.id,
    name: stored.name,
    fileUpdated: written.html_changed,
  }
}

export function changedFrames(project: Project): string[] {
  return Object.entries(project.frames)
    .filter(([file, entry]) => {
      const path = join(project.root, file)
      return existsSync(path) && hashOf(readFileSync(path, 'utf8')) !== entry.hash
    })
    .map(([file]) => file)
}

export async function pushFrames(context: Context, project: Project, files: string[]): Promise<SyncPart> {
  const creating = files.filter((file) => !project.frames[file])
  if (creating.length > 1 && (context.flags.name || context.flags.width || context.flags.height))
    throw usage('--name, --width and --height describe one new frame', 'push new files one at a time to set them')

  const results: PushResult[] = []
  for (const file of files) results.push(await pushOne(context, project, file))
  return {
    lines: results.map((entry) => {
      const target = entry.name ? ` → ${entry.name} (${entry.id})` : ''
      const extra =
        entry.outcome === 'conflict'
          ? `  changed on the canvas by ${entry.changedBy}`
          : entry.fileUpdated
            ? '  · file rewritten as the canvas stored it: read it again before editing'
            : ''
      return `${entry.outcome.padEnd(9)} ${entry.file}${target}${extra}`
    }),
    results,
    conflicts: results.filter((entry) => entry.outcome === 'conflict').map((entry) => entry.file),
  }
}

/* ------------------------------------------------------------------ */
/* diff, frames                                                        */

function unifiedDiff(canvasHtml: string, path: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'doop-diff-'))
  try {
    const remote = join(dir, 'canvas.html')
    writeFileSync(remote, canvasHtml)
    const git = spawnSync('git', ['diff', '--no-index', '--no-color', remote, path], { encoding: 'utf8' })
    const ran = git.error ? spawnSync('diff', ['-u', remote, path], { encoding: 'utf8' }) : git
    if (ran.error) throw new CliError('doop diff needs git or diff on the PATH')
    return ran.stdout.split(remote).join(`canvas/${label}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function diff(context: Context): Promise<Outcome> {
  const project = requireProject(context.project)
  const files = context.args.length
    ? context.args.map((file) => projectPath(project, context.cwd, file))
    : Object.keys(project.frames)
  const parts: { file: string; diff: string }[] = []
  for (const file of files) {
    const tracked = project.frames[file]
    if (!tracked) throw usage(`${file} is not a pulled frame`, '`doop frames` shows which files are tracked')
    const path = join(project.root, file)
    if (!existsSync(path)) continue
    const remote = await readFrame(context, tracked.id)
    if (remote.html === readFileSync(path, 'utf8')) continue
    parts.push({ file, diff: unifiedDiff(remote.html, path, file) })
  }
  return {
    text: parts.length ? parts.map((part) => part.diff.trimEnd()).join('\n') : 'no differences from the canvas',
    data: { files: parts },
  }
}

export async function frames(context: Context): Promise<Outcome> {
  const canvas = await context.canvas()
  const fileOf = new Map(Object.entries(context.project?.frames ?? {}).map(([file, entry]) => [entry.id, file]))
  const shown = canvas.frames.filter((frame) => !context.flags.ready || frame.approvalStatus === 'ready_for_dev')
  const rows = shown.map((frame) => ({
    id: frame.id,
    name: frame.name,
    size: sizeOf(frame),
    status: frame.approvalStatus,
    updatedBy: frame.updatedBy,
    updatedAt: frame.updatedAt,
    ...(frame.pageId ? { pageId: frame.pageId } : {}),
    ...(fileOf.has(frame.id) ? { file: fileOf.get(frame.id) } : {}),
  }))
  const text = rows.length
    ? rows
        .map((row) =>
          [row.id, row.name, row.size, row.status, row.updatedBy, ...(row.file ? [row.file] : [])].join('\t'),
        )
        .join('\n')
    : `${canvas.name} has no frames${context.flags.ready ? ' marked ready for dev' : ' yet'}`
  return { text, data: { canvas: { id: canvas.id, name: canvas.name, pages: canvas.pages }, frames: rows } }
}
