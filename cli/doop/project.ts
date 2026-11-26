import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Connection } from './client.ts'
import { CliError, EXIT, usage } from './errors.ts'

/**
 * What the CLI keeps on disk.
 *
 * - `~/.config/doop/credentials.json` (0600): an agent key per server, written by `doop login`.
 * - `.doop/config.json`: the canvas a directory is linked to. Meant to be committed.
 * - `.doop/state.json`: which local file is which frame, and the hash of the HTML both sides
 *   last agreed on. A push or pull compares against it to tell a local edit from a canvas edit.
 *   Per checkout, so `.doop/.gitignore` keeps it out of the repository.
 */

export const DEFAULT_SERVER = 'https://doop.design'
export const PROJECT_DIR = '.doop'
/** what is per checkout or generated: the state, screenshots and expanded frames */
const GITIGNORE = 'state.json\ncomments-seen.json\nshots/\nexpanded/\n'

export interface ProjectConfig {
  canvas: string
  name?: string
  /** the server the canvas is on (doop.design when absent) */
  server?: string
  /** where pulled frames go, relative to the project root */
  dir: string
}

export interface TrackedFrame {
  id: string
  name: string
  /** sha256 of the HTML the canvas held when this file was last pulled or pushed */
  hash: string
  /** the frame's version then: a push is written only while the frame is still at it */
  version: string
}

export interface ComponentMeta {
  name: string
  description?: string
  props?: unknown[]
}

export interface TrackedComponent {
  id: string
  /** the revision the files were last pulled from or pushed to: sent back as `expected_rev` */
  rev: number
  /** sha256 of the template and of the CSS at that revision */
  html: string
  css: string
  meta: ComponentMeta
}

export interface Project {
  root: string
  config: ProjectConfig
  /** tracked frames by file path, relative to the root, with forward slashes */
  frames: Record<string, TrackedFrame>
  /** tracked components by their files' shared path without the extension */
  components: Record<string, TrackedComponent>
  /** the newest comment `doop wait` has reported or started from: the next wait reports what
   *  came after it, so a comment left between two waits is not lost. It is kept in its own
   *  file (`saveCommentsSeen`), never in state.json */
  commentsSeenAt?: number
}

interface Credentials {
  current?: string
  /** `minted`: the key was made for this machine by a browser sign-in, so `doop logout`
   *  deletes it on the server too. A key the person brought themselves is only forgotten. */
  servers: Record<string, { key: string; minted?: boolean }>
}

export function hashOf(html: string): string {
  return createHash('sha256').update(html).digest('hex')
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    throw new CliError(`${path} is not valid JSON`, EXIT.error, 'fix or delete the file, then run the command again')
  }
}

/** Writes through a file beside it, so another doop process never reads half of it. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const partial = `${path}.${process.pid}.tmp`
  writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(partial, path)
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */

function credentialsPath(env: NodeJS.ProcessEnv): string {
  const base = env.DOOP_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'doop')
  return join(base, 'credentials.json')
}

function readCredentials(env: NodeJS.ProcessEnv): Credentials {
  return readJson<Credentials>(credentialsPath(env)) ?? { servers: {} }
}

/** The credentials file is never readable by anyone else, from the moment it exists: its
 *  directory is made private and the file is created with its mode, not narrowed afterwards. */
function writeCredentials(env: NodeJS.ProcessEnv, credentials: Credentials): string {
  const path = credentialsPath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  /* a file that was already there keeps the mode it had: narrow that too */
  chmodSync(path, 0o600)
  return path
}

export function saveKey(env: NodeJS.ProcessEnv, server: string, key: string, minted = false): string {
  const credentials = readCredentials(env)
  credentials.servers[server] = { key, ...(minted ? { minted } : {}) }
  credentials.current = server
  return writeCredentials(env, credentials)
}

/** The key saved for `server`, if any. */
export function savedKey(env: NodeJS.ProcessEnv, server: string): { key: string; minted?: boolean } | undefined {
  return readCredentials(env).servers[server]
}

/** Forgets the key saved for `server` and answers what it was. */
export function forgetKey(env: NodeJS.ProcessEnv, server: string): { key: string; minted?: boolean } | undefined {
  const credentials = readCredentials(env)
  const saved = credentials.servers[server]
  if (!saved) return undefined
  delete credentials.servers[server]
  if (credentials.current === server) delete credentials.current
  writeCredentials(env, credentials)
  return saved
}

export function normalizeServer(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    throw usage(`"${raw}" is not a server URL`, 'pass an origin such as https://doop.design')
  }
}

/** The harness this runs under, as the name people on the canvas see beside the work. */
function detectAgentName(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDECODE) return 'Claude'
  if (env.CURSOR_AGENT) return 'Cursor'
  if (env.GEMINI_CLI) return 'Gemini'
  if (env.CODEX_SANDBOX || env.CODEX_HOME) return 'Codex'
  return 'Doop CLI'
}

/** The name people see beside the work: `--agent`, `DOOP_AGENT_NAME`, else the harness's. */
export function resolveAgentName(env: NodeJS.ProcessEnv, options: { agent?: string }): string {
  return options.agent ?? env.DOOP_AGENT_NAME ?? detectAgentName(env)
}

export interface ConnectionOptions {
  server?: string
  agent?: string
  /** a key given on the command line (`doop login --key`) */
  key?: string
}

/** A key that came with the command and belongs to no server: `--key`, else the environment. */
function looseKey(env: NodeJS.ProcessEnv, options: ConnectionOptions): string | undefined {
  return options.key ?? (env.DOOP_API_KEY || env.DOOP_KEY || undefined)
}

/** The server its holder pointed a loose key at: `--server`, `DOOP_SERVER`, else doop.design. */
export function pointedServer(env: NodeJS.ProcessEnv, options: ConnectionOptions): string {
  return normalizeServer(options.server ?? (env.DOOP_SERVER || undefined) ?? DEFAULT_SERVER)
}

/** The server a command talks to. A linked directory names its own (doop.design when its
 *  config says nothing), so signing in to another server later does not move it. Outside one,
 *  a key in the environment goes where it was pointed, and only without one is it the server
 *  last signed in to. */
export function resolveServer(env: NodeJS.ProcessEnv, options: ConnectionOptions, project: Project | null): string {
  const named = options.server ?? (env.DOOP_SERVER || undefined)
  if (named) return normalizeServer(named)
  if (project) return normalizeServer(project.config.server ?? DEFAULT_SERVER)
  return looseKey(env, options) ? DEFAULT_SERVER : normalizeServer(readCredentials(env).current ?? DEFAULT_SERVER)
}

/**
 * The key for `server`. A key saved by `doop login` belongs to the server it was saved for. A
 * key from the environment or the command line belongs to no server, so it goes only where its
 * holder pointed it: `--server`, `DOOP_SERVER`, or doop.design when neither is set. It is never
 * sent to a server that only a file names (a `.doop/config.json` that came with a cloned
 * repository, a canvas URL handed to `doop link`): that would hand an account's key to
 * whoever wrote the file. Where a saved key is used in its place, the connection says so.
 */
export function resolveConnection(env: NodeJS.ProcessEnv, options: ConnectionOptions, server: string): Connection {
  const loose = looseKey(env, options)
  const pointedAt = pointedServer(env, options)
  const saved = readCredentials(env).servers[server]?.key
  const key = (pointedAt === server ? loose : undefined) ?? saved
  if (!key && loose)
    throw new CliError(
      `the agent key was not sent to ${server}: nothing but a file or a URL names that server`,
      EXIT.auth,
      `if you trust it, name it yourself with --server ${server} or DOOP_SERVER=${server}`,
    )
  if (!key)
    throw new CliError(
      `no agent key for ${server}`,
      EXIT.auth,
      'run `doop login`, or set DOOP_API_KEY to an agent key from Settings → Agent keys',
    )
  return {
    server,
    key,
    agentName: resolveAgentName(env, options),
    ...(loose && key !== loose
      ? { notice: `the key in the environment is for ${pointedAt}; this used the key saved for ${server}` }
      : {}),
  }
}

/* ------------------------------------------------------------------ */
/* The linked directory                                                */

/** Is `path` (relative to the root) inside it? A path that climbs out, or is absolute, is not. */
function inside(root: string, path: string): boolean {
  const target = resolve(root, path)
  return !isAbsolute(path) && (target === root || target.startsWith(root + sep))
}

/** A project's files are named by its config and state, and both can arrive with a cloned
 *  repository: every path they name stays inside the project, or nothing is read or written. */
function checked(project: Project): Project {
  const paths = [project.config.dir, ...Object.keys(project.frames), ...Object.keys(project.components)]
  const outside = paths.find((path) => typeof path !== 'string' || !inside(project.root, path))
  if (outside !== undefined)
    throw new CliError(
      `.doop names a path outside this directory: ${String(outside)}`,
      EXIT.error,
      'fix `dir` in .doop/config.json (a folder inside the project), or delete .doop/state.json',
    )
  return project
}

export function findProject(cwd: string): Project | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const config = readJson<ProjectConfig>(join(dir, PROJECT_DIR, 'config.json'))
    if (config) {
      const state = readJson<SavedState>(statePath(dir))
      /* a mark an older doop kept in state.json still counts until a wait writes its own */
      const commentsSeenAt = readCommentsSeen(dir, config.canvas) ?? state?.commentsSeenAt
      return checked({
        root: dir,
        config,
        frames: state?.frames ?? {},
        components: state?.components ?? {},
        ...(typeof commentsSeenAt === 'number' ? { commentsSeenAt } : {}),
      })
    }
    if (dirname(dir) === dir) return null
  }
}

export function createProject(root: string, config: ProjectConfig): Project {
  /* relinking the same canvas keeps what was pulled; another canvas starts clean */
  const before = findProject(root)
  const kept = before?.root === root && before.config.canvas === config.canvas ? before : undefined
  const project = checked({
    root,
    config,
    frames: kept?.frames ?? {},
    components: kept?.components ?? {},
    ...(kept?.commentsSeenAt === undefined ? {} : { commentsSeenAt: kept.commentsSeenAt }),
  })
  writeJson(join(root, PROJECT_DIR, 'config.json'), config)
  writeFileSync(join(root, PROJECT_DIR, '.gitignore'), GITIGNORE)
  saveState(project)
  return project
}

/** state.json: what was pulled or pushed. `commentsSeenAt` is only read, from older doops. */
type SavedState = Partial<Pick<Project, 'frames' | 'components' | 'commentsSeenAt'>>

/** comments-seen.json: the comment mark, and the canvas it is a mark on. */
interface CommentsSeen {
  canvas: string
  at: number
}

function statePath(root: string): string {
  return join(root, PROJECT_DIR, 'state.json')
}

function commentsSeenPath(root: string): string {
  return join(root, PROJECT_DIR, 'comments-seen.json')
}

/** The mark, when it is one on this canvas: a directory linked to another canvas starts again. */
function readCommentsSeen(root: string, canvas: string): number | undefined {
  const seen = readJson<Partial<CommentsSeen>>(commentsSeenPath(root))
  return seen?.canvas === canvas && typeof seen.at === 'number' ? seen.at : undefined
}

export function saveState(project: Project): void {
  writeJson(statePath(project.root), { frames: project.frames, components: project.components })
}

/** Moves the comment mark forward. It has a file of its own because `doop wait` runs for
 *  minutes, often beside a `doop push` that tracks new files: nothing the wait writes can
 *  then put back the frames and components it read when it started. */
export function saveCommentsSeen(project: Project, at: number): void {
  const canvas = project.config.canvas
  const seen = Math.max(at, readCommentsSeen(project.root, canvas) ?? at)
  project.commentsSeenAt = seen
  writeJson(commentsSeenPath(project.root), { canvas, at: seen } satisfies CommentsSeen)
}

export function requireProject(project: Project | null): Project {
  if (!project)
    throw usage(
      'this directory is not linked to a canvas',
      'run `doop link <canvas id, name or URL>` first (`doop canvases` lists them)',
    )
  return project
}

/** A file's key in the state: relative to the root, forward slashes. */
export function projectPath(project: Project, cwd: string, file: string): string {
  return relative(project.root, resolve(cwd, file)).split('\\').join('/')
}

export function shotsDir(project: Project): string {
  return join(project.root, PROJECT_DIR, 'shots')
}

export function expandedDir(project: Project): string {
  return join(project.root, PROJECT_DIR, 'expanded')
}

/** Where a canvas's components are kept, beside its frames. */
export function componentsDir(project: Project): string {
  return join(project.config.dir, 'components').split('\\').join('/')
}

/** A component's key in the state when `file` is one of its three files (or their shared
 *  path), else undefined: everything under the components directory is a component. */
export function componentBase(project: Project, file: string): string | undefined {
  if (!file.startsWith(`${componentsDir(project)}/`)) return undefined
  return file.replace(/\.(html|css|json)$/, '')
}

export function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'frame'
  )
}

/** The file a frame is pulled to: the one it already has, else `<dir>/<slug>.html`, with a
 *  piece of the id when another frame took that name. */
export function fileForFrame(project: Project, frame: { id: string; name: string }): string {
  const tracked = Object.entries(project.frames).find(([, entry]) => entry.id === frame.id)
  if (tracked) return tracked[0]
  const base = join(project.config.dir, slugOf(frame.name)).split('\\').join('/')
  const plain = `${base}.html`
  return project.frames[plain] ? `${base}-${frame.id.slice(0, 4).toLowerCase()}.html` : plain
}
