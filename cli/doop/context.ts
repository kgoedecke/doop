import { callJson, type Connection, type ToolResult } from './client.ts'
import { CliError, EXIT, usage } from './errors.ts'
import { findProject, projectPath, resolveConnection, resolveServer, slugOf, type Project } from './project.ts'

/** Every option the CLI takes, in one table: `parseArgs` needs to know which take a value. */
export const OPTIONS = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  server: { type: 'string' },
  canvas: { type: 'string' },
  agent: { type: 'string' },
  key: { type: 'string' },
  out: { type: 'string', short: 'o' },
  dir: { type: 'string' },
  force: { type: 'boolean' },
  all: { type: 'boolean' },
  ready: { type: 'boolean' },
  expand: { type: 'boolean' },
  name: { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  page: { type: 'string' },
  create: { type: 'string' },
  format: { type: 'string' },
  scale: { type: 'string' },
  quality: { type: 'string' },
  selector: { type: 'string', multiple: true },
  'fail-on-problems': { type: 'boolean' },
  feedback: { type: 'boolean' },
  comments: { type: 'boolean' },
  frame: { type: 'string' },
  timeout: { type: 'string' },
  interval: { type: 'string' },
  prune: { type: 'boolean' },
  skill: { type: 'boolean' },
  'no-browser': { type: 'boolean' },
} as const

export interface Flags {
  json?: boolean
  help?: boolean
  version?: boolean
  server?: string
  canvas?: string
  agent?: string
  key?: string
  out?: string
  dir?: string
  force?: boolean
  all?: boolean
  ready?: boolean
  expand?: boolean
  name?: string
  width?: string
  height?: string
  page?: string
  create?: string
  format?: string
  scale?: string
  quality?: string
  selector?: string[]
  'fail-on-problems'?: boolean
  feedback?: boolean
  comments?: boolean
  frame?: string
  timeout?: string
  interval?: string
  prune?: boolean
  skill?: boolean
  'no-browser'?: boolean
}

/** What a command hands back: `text` for a reader, `data` for `--json`. */
export interface Outcome {
  text: string
  data?: unknown
  /** steering notes and human feedback the server sent with the results */
  notes?: string[]
  feedback?: string[]
  exitCode?: number
}

export interface FrameSummary {
  id: string
  name: string
  pageId?: string
  width: number
  height: number
  approvalStatus: string
  updatedAt: string
  updatedBy: string
  htmlBytes: number
  hidden?: boolean
}

export interface CanvasInfo {
  id: string
  name: string
  pages: { id: string; name: string }[]
  frames: FrameSummary[]
}

export interface FrameRef {
  id: string
  name: string
  /** its local file, relative to the project root, when it has one */
  file?: string
}

export interface Context {
  flags: Flags
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  project: Project | null
  readonly connection: Connection
  /** the canvas commands act on: `--canvas`, else the linked one */
  canvasId(): string
  canvas(): Promise<CanvasInfo>
  resolveFrame(ref: string): Promise<FrameRef>
  /** Collects what the server said beside a result, to print once at the end. */
  heard(result: ToolResult): void
  /** what the server could not do as written */
  warnings: string[]
  notes: string[]
  feedback: string[]
}

export function createContext(flags: Flags, args: string[], env: NodeJS.ProcessEnv, cwd: string): Context {
  const project = findProject(cwd)
  let connection: Connection | undefined
  let canvas: Promise<CanvasInfo> | undefined
  const context: Context = {
    flags,
    args,
    env,
    cwd,
    project,
    warnings: [],
    notes: [],
    feedback: [],
    get connection() {
      if (!connection) {
        connection = resolveConnection(env, flags, resolveServer(env, flags, project))
        if (connection.notice) context.notes.push(connection.notice)
      }
      return connection
    },
    canvasId() {
      const id = flags.canvas ?? project?.config.canvas
      if (!id)
        throw usage(
          'no canvas to act on',
          'pass --canvas <id>, or link this directory with `doop link <canvas id, name or URL>`',
        )
      return id
    },
    canvas() {
      canvas ??= callJson<CanvasInfo>(context.connection, 'get_canvas', { canvas_id: context.canvasId() }).then(
        ({ value, result }) => {
          /* get_canvas's own note is a briefing for a designing agent; `doop guide` carries it */
          context.feedback.push(...result.feedback)
          return value
        },
      )
      return canvas
    },
    async resolveFrame(ref) {
      if (project) {
        const file = projectPath(project, cwd, ref)
        const tracked = project.frames[file]
        if (tracked) return { id: tracked.id, name: tracked.name, file }
      }
      /* no canvas to look names up on: take the reference as a frame id */
      if (!flags.canvas && !project) return { id: ref, name: ref }
      const { frames } = await context.canvas()
      const wanted = ref.toLowerCase()
      const matches =
        [
          frames.filter((frame) => frame.id === ref),
          frames.filter((frame) => frame.name.toLowerCase() === wanted),
          frames.filter((frame) => slugOf(frame.name) === slugOf(ref.replace(/\.html$/, ''))),
        ].find((found) => found.length > 0) ?? []
      if (matches.length > 1)
        throw usage(
          `${matches.length} frames are named "${ref}"`,
          `pass an id instead: ${matches.map((frame) => frame.id).join(', ')}`,
        )
      const [frame] = matches
      if (!frame)
        throw new CliError(`no frame "${ref}" on this canvas`, EXIT.notFound, '`doop frames` lists them by name and id')
      const file = project ? Object.entries(project.frames).find(([, entry]) => entry.id === frame.id)?.[0] : undefined
      return { id: frame.id, name: frame.name, ...(file ? { file } : {}) }
    },
    heard(result) {
      for (const note of result.notes) if (!context.notes.includes(note)) context.notes.push(note)
      for (const item of result.feedback) if (!context.feedback.includes(item)) context.feedback.push(item)
    },
  }
  return context
}

export function need(value: string | undefined, what: string, hint: string): string {
  if (!value) throw usage(`missing ${what}`, hint)
  return value
}

export function numberFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw usage(`--${name} takes a number, got "${value}"`)
  return parsed
}
