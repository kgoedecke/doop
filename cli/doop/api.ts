import type { Connection } from './client.ts'
import { CliError, EXIT } from './errors.ts'

/**
 * Doop's agent API (`/api/v1`, server/agentApi.ts): frames as files. The HTML is the request or
 * response body, a failure is a status code, and a frame's version travels as its `ETag`, so a
 * push with `If-Match` cannot overwrite an edit it has not seen. Everything that is not a
 * document moving (searches, comments, status) stays on the MCP tools (client.ts).
 */

export interface FrameMeta {
  id: string
  name: string
  pageId?: string
  width: number
  height: number
  approvalStatus: string
  updatedAt: string
  updatedBy: string
  /** what `If-Match` is held against */
  version: string
}

export interface Feedback {
  from: string
  text: string
  at: string
  about?: string
}

export interface Written {
  frame: FrameMeta
  /** the canvas stored the markup differently than it was sent */
  html_changed: boolean
  /** what could not be done as written, such as an instance of a component that does not exist */
  warnings: string[]
  /** advice on what to reuse */
  notes: string[]
  feedback: Feedback[]
}

/** The frame moved past the version this client last saw: nothing was written. */
export class FrameConflict extends CliError {
  readonly frame: FrameMeta

  constructor(message: string, frame: FrameMeta) {
    super(message, EXIT.conflict)
    this.frame = frame
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; frame?: FrameMeta } | string
}

async function request(
  connection: Connection,
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${connection.server}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.key}`,
        /* a header value is Latin-1: a name outside it is sent encoded */
        'Doop-Agent': encodeURIComponent(connection.agentName),
        ...(init.body === undefined ? {} : { 'Content-Type': 'text/html; charset=utf-8' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    })
  } catch (error) {
    throw new CliError(
      `could not reach ${connection.server}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.error,
      'check the network, or point at another server with --server or DOOP_SERVER',
    )
  }
  if (response.ok) return response
  const body = (await response.json().catch(() => ({}))) as ErrorBody
  if (typeof body.error !== 'object') {
    /* a server older than this API answers /api/v1 from its browser-session gate */
    if (response.status === 401 && body.error === 'unauthorized')
      throw new CliError(
        `${connection.server} has no agent API`,
        EXIT.error,
        'update the server, or use the CLI it serves at /cli/doop.mjs',
      )
    /* the server's own refusals (a write over its work budget, a canvas being handed to its
       actor) and a proxy's error page: said as they are, with the status */
    const retry = response.headers.get('retry-after')
    throw new CliError(
      `${connection.server} answered ${response.status}${typeof body.error === 'string' ? `: ${body.error}` : ''}`,
      EXIT.error,
      retry ? `try again in ${retry}s` : undefined,
    )
  }
  const { code, message = `the server answered ${response.status}`, frame } = body.error
  if (code === 'conflict' && frame) throw new FrameConflict(message, frame)
  if (code === 'unauthorized')
    throw new CliError(
      `${connection.server} refused the agent key`,
      EXIT.auth,
      'run `doop login` again, or set DOOP_API_KEY to an agent key from Settings → Agent keys',
    )
  if (code === 'not_found')
    throw new CliError(message, EXIT.notFound, '`doop canvases` and `doop frames` list what this key can open')
  /* the refusal is worded for an MCP agent: name the command this client has for it */
  if (code === 'refused' && message.includes('data:'))
    throw new CliError(message, EXIT.error, 'here that is `doop asset upload <file>`: reference the URL it prints')
  throw new CliError(message)
}

function metaOf(response: Response): FrameMeta {
  return JSON.parse(decodeURIComponent(response.headers.get('doop-frame') ?? '{}')) as FrameMeta
}

/** A frame's HTML as agents edit it (component instances as `<doop-use>`), or `rendered`: the
 *  document as it renders, with components and token values written out. */
export async function readFrameHtml(
  connection: Connection,
  id: string,
  form: 'source' | 'rendered' = 'source',
): Promise<{ html: string; frame: FrameMeta }> {
  const response = await request(
    connection,
    'GET',
    `/frames/${encodeURIComponent(id)}/html${form === 'rendered' ? '?form=rendered' : ''}`,
  )
  return { html: await response.text(), frame: metaOf(response) }
}

/** Replaces a frame's HTML. With `version`, only while the frame is still at it. */
export async function writeFrameHtml(
  connection: Connection,
  id: string,
  html: string,
  version?: string,
): Promise<Written> {
  const response = await request(connection, 'PUT', `/frames/${encodeURIComponent(id)}/html`, {
    body: html,
    ...(version ? { headers: { 'If-Match': `"${version}"` } } : {}),
  })
  return (await response.json()) as Written
}

export async function createFrame(
  connection: Connection,
  canvasId: string,
  html: string,
  options: { name: string; width?: number; height?: number; page?: string },
): Promise<Written> {
  const query = new URLSearchParams({ name: options.name })
  if (options.width) query.set('width', String(options.width))
  if (options.height) query.set('height', String(options.height))
  if (options.page) query.set('page', options.page)
  const response = await request(connection, 'POST', `/canvases/${encodeURIComponent(canvasId)}/frames?${query}`, {
    body: html,
  })
  return (await response.json()) as Written
}
