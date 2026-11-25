import { createInterface } from 'node:readline/promises'
import { callJson, type Connection } from './client.ts'
import { need, type Context, type Outcome } from './context.ts'
import { CliError, EXIT, usage } from './errors.ts'
import {
  createProject,
  forgetKey,
  normalizeServer,
  pointedServer,
  resolveAgentName,
  resolveConnection,
  resolveServer,
  saveKey,
} from './project.ts'

/** Signing in, choosing a canvas, and saying what the agent is doing. */

interface Profile {
  id: string
  name: string
}

interface CanvasEntry {
  id: string
  name: string
  workspace_name?: string
}

async function askForKey(server: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new CliError(
      'no agent key given',
      EXIT.auth,
      `make one at ${server} under Settings → Agent keys, then run \`doop login --key <key>\` or set DOOP_API_KEY`,
    )
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await prompt.question(`Agent key (make one at ${server} under Settings → Agent keys): `)).trim()
  } finally {
    prompt.close()
  }
}

export async function login(context: Context): Promise<Outcome> {
  /* where the key is saved is where it will be sent from now on, so it is a server its holder
     named (or doop.design): never one that a linked directory's config alone names, and not
     the server that happens to have been signed in to last */
  const server = pointedServer(context.env, context.flags)
  const linked = context.project?.config.server ? normalizeServer(context.project.config.server) : undefined
  if (linked && linked !== server)
    throw usage(
      `this directory's canvas is on ${linked}, and \`doop login\` signs in to ${server} unless told otherwise`,
      `to sign in there: doop login --server ${linked} --key <key>`,
    )
  const key = context.flags.key ?? context.args[0] ?? (await askForKey(server))
  /* the key that was typed is the one that is checked, whatever is saved already */
  const connection = { server, key, agentName: resolveAgentName(context.env, context.flags) }
  const { value } = await callJson<Profile>(connection, 'get_profile')
  const path = saveKey(context.env, server, key)
  return {
    text: `signed in to ${server} as ${value.name}\nkey saved in ${path}\nnext: doop link <canvas id, name or URL>`,
    data: { server, account: value },
  }
}

export function logout(context: Context): Promise<Outcome> {
  const server = resolveServer(context.env, context.flags, context.project)
  const removed = forgetKey(context.env, server)
  return Promise.resolve({
    text: removed ? `removed the key for ${server}` : `no key was saved for ${server}`,
    data: { server, removed },
  })
}

export async function whoami(context: Context): Promise<Outcome> {
  const { value } = await callJson<Profile>(context.connection, 'get_profile')
  const { server, agentName } = context.connection
  const canvas = context.project?.config
  return {
    text: [
      `${value.name} on ${server}, acting as "${agentName}"`,
      canvas
        ? `linked canvas: ${canvas.name ?? canvas.canvas} (${server}/c/${canvas.canvas})`
        : 'no canvas linked here',
    ].join('\n'),
    data: { server, account: value, agentName, canvas: canvas?.canvas ?? null },
  }
}

export async function canvases(context: Context): Promise<Outcome> {
  const { value } = await callJson<CanvasEntry[]>(context.connection, 'list_canvases')
  return {
    text: value.length
      ? value.map((entry) => [entry.id, entry.name, entry.workspace_name ?? ''].join('\t').trimEnd()).join('\n')
      : 'no canvases yet: `doop link --create "Name"` makes one',
    data: { canvases: value },
  }
}

/** A canvas URL names its server too. */
function parseCanvasUrl(ref: string): { server: string; id: string } | undefined {
  if (!/^https?:\/\//.test(ref)) return undefined
  const url = new URL(ref)
  const id = /^\/c\/([^/]+)/.exec(url.pathname)?.[1]
  if (!id) throw usage(`${ref} is not a canvas URL`, 'a canvas URL looks like https://doop.design/c/<id>')
  return { server: url.origin, id }
}

async function findCanvas(connection: Connection, ref: string): Promise<CanvasEntry> {
  const { value } = await callJson<CanvasEntry[]>(connection, 'list_canvases')
  const byId = value.find((entry) => entry.id === ref)
  if (byId) return byId
  const named = value.filter((entry) => entry.name.toLowerCase() === ref.toLowerCase())
  if (named.length > 1)
    throw usage(
      `${named.length} canvases are named "${ref}"`,
      `link by id: ${named.map((entry) => entry.id).join(', ')}`,
    )
  if (named[0]) return named[0]
  /* a canvas shared by link is not on the list, but opens by id */
  return (await callJson<CanvasEntry>(connection, 'get_canvas', { canvas_id: ref })).value
}

export async function link(context: Context): Promise<Outcome> {
  const ref = context.args[0]
  const fromUrl = ref ? parseCanvasUrl(ref) : undefined
  /* the URL's server is where the canvas is, not a server the key was pointed at */
  const connection = fromUrl
    ? resolveConnection(context.env, context.flags, context.flags.server ? context.connection.server : fromUrl.server)
    : context.connection
  let canvas: CanvasEntry
  if (context.flags.create) {
    canvas = (await callJson<CanvasEntry>(connection, 'create_canvas', { name: context.flags.create })).value
  } else {
    canvas = await findCanvas(
      connection,
      fromUrl?.id ?? need(ref, 'a canvas', 'usage: doop link <canvas id, name or URL> [--dir designs]'),
    )
  }
  const server = normalizeServer(connection.server)
  const project = createProject(context.cwd, {
    canvas: canvas.id,
    name: canvas.name,
    dir: context.flags.dir ?? (context.project?.root === context.cwd ? context.project.config.dir : 'designs'),
    server,
  })
  return {
    text: [
      `linked this directory to "${canvas.name}" (${server}/c/${canvas.id})`,
      `frames are pulled into ${project.config.dir}/`,
      'next: doop pull, and `doop init` to tell coding agents in this repository about it',
    ].join('\n'),
    data: { canvas: { id: canvas.id, name: canvas.name, url: `${server}/c/${canvas.id}` }, dir: project.config.dir },
  }
}

export async function status(context: Context): Promise<Outcome> {
  const text = context.args[0]
  if (text === undefined)
    throw usage('usage: doop status "<what you are working on>"', 'an empty string clears it: doop status ""')
  const written = await callJson<{ status: string | null }>(context.connection, 'set_status', {
    canvas_id: context.canvasId(),
    status: text,
  })
  context.heard(written.result)
  return {
    text: written.value.status ? `status: ${written.value.status}` : 'status cleared',
    data: { status: written.value.status },
  }
}
