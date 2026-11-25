import { callJson, type Connection } from './client.ts'
import { need, type Context, type Outcome } from './context.ts'
import { browserLogin, revokeKey } from './login.ts'
import { usage } from './errors.ts'
import {
  createProject,
  forgetKey,
  normalizeServer,
  pointedServer,
  resolveAgentName,
  resolveConnection,
  resolveServer,
  saveKey,
  savedKey,
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

export async function login(context: Context): Promise<Outcome> {
  /* where the key is saved is where it will be sent from now on, so it is a server its holder
     named (or doop.design): never one that a linked directory's config alone names, and not
     the server that happens to have been signed in to last */
  const server = pointedServer(context.env, context.flags)
  const linked = context.project?.config.server ? normalizeServer(context.project.config.server) : undefined
  if (linked && linked !== server)
    throw usage(
      `this directory's canvas is on ${linked}, and \`doop login\` signs in to ${server} unless told otherwise`,
      `to sign in there: doop login --server ${linked}`,
    )
  const given = context.flags.key ?? context.args[0]
  let account: { name: string; id?: string; email?: string }
  let key: string
  if (given) {
    /* the key that was typed is the one that is checked, whatever is saved already */
    const connection = { server, key: given, agentName: resolveAgentName(context.env, context.flags) }
    account = (await callJson<Profile>(connection, 'get_profile')).value
    key = given
  } else {
    /* no key: the person approves this CLI in their browser, and it is handed one */
    const signedIn = await browserLogin(server, context.env, context.flags['no-browser'] === true)
    account = signedIn.user
    key = signedIn.key
  }
  /* the key this replaces, when a browser sign-in made it for this machine, is deleted: each
     sign-in mints a new one, and the old ones would otherwise gather in Settings */
  const before = savedKey(context.env, server)
  const path = saveKey(context.env, server, key, !given)
  if (before?.minted && before.key !== key) await revokeKey(server, before.key)
  return {
    text: `signed in to ${server} as ${account.name}\nkey saved in ${path}\nnext: doop link <canvas id, name or URL>`,
    data: { server, account },
  }
}

export async function logout(context: Context): Promise<Outcome> {
  const server = resolveServer(context.env, context.flags, context.project)
  const saved = savedKey(context.env, server)
  if (!saved) return { text: `no key was saved for ${server}`, data: { server, removed: false, revoked: false } }
  /* a key the browser sign-in made for this machine is deleted, not left behind in Settings.
     One the person brought (`--key`) may be in use elsewhere and is only forgotten here.
     Deleted before it is forgotten: once forgotten, nothing here could delete it */
  const revoked = saved.minted ? await revokeKey(server, saved.key) : false
  forgetKey(context.env, server)
  return {
    text: revoked
      ? `signed out of ${server}: this machine's key is deleted`
      : saved.minted
        ? `removed the key for ${server} from this machine, but ${server} could not be reached to delete it: ` +
          'it still works until you remove “doop CLI on …” under Settings → Agent keys'
        : `removed the key for ${server} from this machine`,
    data: { server, removed: true, revoked },
  }
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
