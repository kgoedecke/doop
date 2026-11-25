import express from 'express'
import { resolveAgentBrand } from '../shared/agentBrand.ts'
import { roleAllows, type CanvasRole } from '../shared/canvasRole.ts'
import { canvasPages } from '../shared/pages.ts'
import type { Actor, Frame } from '../shared/types.ts'
import { canvasRole } from './access.ts'
import * as actions from './actions.ts'
import { isAgentKeySecret, verifyAgentKey } from './agentKeys.ts'
import { captureThrottled } from './analytics.ts'
import { getUserName, isBanned } from './auth.ts'
import { FrameVersionConflict, runCanvasWrite } from './canvasWrites.ts'
import { compactFrameHtml } from './componentActions.ts'
import { componentWriteNotes } from './componentTools.ts'
import { composedHtml } from './frameCompose.ts'
import { describeFeedback, mcpAgentKey } from './mcp.ts'
import { store } from './store.ts'
import { withArgsCanvases } from './toolLoads.ts'

/**
 * The agent API (`/api/v1`): frames as files over plain HTTP, for a process that holds an agent
 * key (the `doop` CLI, a CI job). It is a second front end on the write path the MCP tools use
 * (`runCanvasWrite`, the same roles, the same inline-data rule, one operation per request), with
 * the things a tool result cannot carry: the HTML as the body both ways, a status code per kind
 * of failure, and the frame's version as an `ETag` so `If-Match` makes an overwrite of somebody
 * else's edit impossible instead of unlikely.
 *
 *   GET  /api/v1/frames/:id/html            the frame as agents edit it (`?form=rendered`: as it renders)
 *   PUT  /api/v1/frames/:id/html            replace it; `If-Match: "<version>"` refuses a stale file
 *   POST /api/v1/canvases/:id/frames        a new frame from the body (`?name=&width=&height=&page=`)
 *
 * An agent is its account and the name in `Doop-Agent`, the identity an MCP agent of that name
 * has, so its presence, tasks and the feedback people leave it are one across both.
 * Everything else an agent does stays on `/mcp`. Behaviour: .context/reference/agents.md.
 */

/** the largest frame `/mcp` accepts as a tool argument, kept for the raw body */
const MAX_HTML_BYTES = '10mb'
const AGENT_HEADER = 'doop-agent'
/** what the CLI is to presence and analytics: the client name an MCP client states in `initialize` */
const CLIENT_NAME = 'doop-cli'

type ErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'refused' | 'invalid' | 'too_large'

function fail(
  res: express.Response,
  status: number,
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
) {
  res.status(status).json({ error: { code, message, ...extra } })
}

interface Agent {
  userId: string
  actor: Actor
}

/** The frame's version: what `ETag` carries and `If-Match` is held against. */
function versionOf(frame: Frame): string {
  return String(frame.updatedAt)
}

function summaryOf(frame: Frame) {
  return {
    id: frame.id,
    name: frame.name,
    pageId: frame.pageId,
    width: frame.width,
    height: frame.height,
    approvalStatus: frame.approval?.status ?? 'draft',
    updatedAt: new Date(frame.updatedAt).toISOString(),
    updatedBy: frame.updatedBy,
    version: versionOf(frame),
  }
}

/** The headers a frame travels with. The body is the file, so what a client tracks beside it
 *  rides here. Read off the frame inside its operation: the frame may move on afterwards. */
function headersOf(frame: Frame): Record<string, string> {
  return {
    ETag: `"${versionOf(frame)}"`,
    'Doop-Frame': encodeURIComponent(JSON.stringify(summaryOf(frame))),
  }
}

/** An answer, sent once the operation that produced it has committed. */
type Reply = () => void

/** `If-Match: "<version>"` as the write's `ifUpdatedAt`; undefined writes whatever is there. */
function expectedVersion(req: express.Request): number | undefined | 'invalid' {
  const raw = req.get('if-match')?.trim()
  if (!raw || raw === '*') return undefined
  const version = Number(raw.replace(/^W\//, '').replace(/^"|"$/g, ''))
  return Number.isSafeInteger(version) && version >= 0 ? version : 'invalid'
}

const NOT_HTML = 'send the frame’s HTML as the request body, with Content-Type: text/html'

/** The HTML a request carries. A JSON body was parsed before this router saw it and is not a
 *  frame: writing it would blank the frame. An empty file is an empty frame. */
function bodyOf(req: express.Request): string | undefined {
  if (typeof req.body === 'string') return req.body
  return Number(req.get('content-length') ?? 0) === 0 ? '' : undefined
}

const COMPONENT_ISSUE = 'COMPONENT: '

/** What a frame write answers: the frame, whether the canvas stored the markup differently
 *  than it was sent (a client then reads it back), `warnings` for what could not be done as
 *  written (an instance of a component that does not exist), `notes` for what it should have
 *  reused, and what people on the canvas asked for meanwhile. */
function written(frame: Frame, sent: string, actor: Actor) {
  const heard = componentWriteNotes(frame, { review: true })
  return {
    frame: summaryOf(frame),
    html_changed: compactFrameHtml(frame) !== sent,
    warnings: heard
      .filter((note) => note.startsWith(COMPONENT_ISSUE))
      .map((note) => note.slice(COMPONENT_ISSUE.length)),
    notes: heard.filter((note) => !note.startsWith(COMPONENT_ISSUE)),
    /* claimed with the write, as the MCP tools claim it */
    feedback: describeFeedback(frame.canvasId, actions.takeFeedbackFor(frame.canvasId, actor), actor),
  }
}

/** The name in `Doop-Agent`, percent-encoded by a client whose name is not Latin-1. */
function agentNameOf(req: express.Request): string {
  const raw = req.get(AGENT_HEADER)?.trim() ?? ''
  try {
    return decodeURIComponent(raw).slice(0, 80) || 'Doop CLI'
  } catch {
    return raw.slice(0, 80) || 'Doop CLI'
  }
}

export function mountAgentApi(app: express.Express): void {
  const api = express.Router()

  /* an agent key and nothing else: a browser session reaches frames through /api proper */
  api.use(async (req, res, next) => {
    try {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
      const key = bearer && isAgentKeySecret(bearer) ? await verifyAgentKey(bearer) : null
      if (!key)
        return fail(
          res,
          401,
          'unauthorized',
          'send an agent key as `Authorization: Bearer dpk_…` (Settings → Agent keys)',
        )
      if (await isBanned(key.userId))
        return fail(res, 403, 'forbidden', 'this account has been disabled on this server')
      const name = agentNameOf(req)
      const actor = actions.resolveActor({
        name,
        kind: 'agent',
        owner: await getUserName(key.userId),
        brand: resolveAgentBrand(CLIENT_NAME, name),
      })
      res.locals.agent = { userId: key.userId, actor: { ...actor, agentKey: mcpAgentKey(key.userId, actor.name) } }
      captureThrottled(key.userId, 'custom_agent_used', {
        first_tool: `api ${req.method} ${req.route?.path ?? req.path}`,
      })
      next()
    } catch (error) {
      next(error)
    }
  })

  const agentOf = (res: express.Response) => res.locals.agent as Agent
  /* a canvas the account can read but not change says so, rather than claiming it is not there */
  const allowed = (res: express.Response, canvasId: string | undefined, need: CanvasRole, what: string): boolean => {
    const canvas = canvasId ? store.getCanvas(canvasId) : undefined
    const role = canvas ? canvasRole(agentOf(res).userId, canvas) : null
    if (roleAllows(role, need)) return true
    if (role) fail(res, 403, 'forbidden', `this account can only ${role} on that canvas`)
    else fail(res, 404, 'not_found', `no ${what} with that id accessible to this account`)
    return false
  }
  /** One request is one operation with its canvas loaded and held, as one tool call is. A
   *  handler answers a refusal at once (nothing was written) and hands back its answer to a
   *  write as a `Reply`, which is sent after the operation has committed: nothing that leaves
   *  the process says a write happened before it has. */
  const route =
    (
      name: string,
      target: (req: express.Request) => Record<string, string>,
      handler: (req: express.Request, res: express.Response) => unknown,
    ): express.RequestHandler =>
    (req, res, next) => {
      withArgsCanvases(target(req), () => handler(req, res), name)
        .then((reply) => {
          if (typeof reply === 'function') (reply as Reply)()
        })
        .catch(next)
    }
  const html = express.text({ type: () => true, limit: MAX_HTML_BYTES })

  api.get(
    '/frames/:id/html',
    route(
      'api frame.read',
      (req) => ({ frame_id: req.params.id ?? '' }),
      (req, res) => {
        const frame = store.getFrame(req.params.id ?? '')
        if (!allowed(res, frame?.canvasId, 'view', 'frame') || !frame) return
        actions.heartbeatAgent(frame.canvasId, agentOf(res).actor)
        const headers = headersOf(frame)
        const body = req.query.form === 'rendered' ? composedHtml(frame.canvasId, frame.html) : compactFrameHtml(frame)
        return (): void => void res.set(headers).type('html').send(body)
      },
    ),
  )

  api.put(
    '/frames/:id/html',
    html,
    route(
      'api frame.write',
      (req) => ({ frame_id: req.params.id ?? '' }),
      async (req, res) => {
        const current = store.getFrame(req.params.id ?? '')
        if (!allowed(res, current?.canvasId, 'edit', 'frame') || !current) return
        const ifUpdatedAt = expectedVersion(req)
        if (ifUpdatedAt === 'invalid')
          return fail(res, 400, 'invalid', 'If-Match takes the version from this frame’s ETag')
        const body = bodyOf(req)
        if (body === undefined) return fail(res, 400, 'invalid', NOT_HTML)
        const { actor } = agentOf(res)
        const frame = await runCanvasWrite(current.canvasId, {
          type: 'write-frame',
          frameId: current.id,
          patch: { html: body },
          actor,
          replace: true,
          inline: 'mcp',
          ...(ifUpdatedAt === undefined ? {} : { ifUpdatedAt }),
        })
        if (frame && 'inline' in frame) return fail(res, 422, 'refused', frame.inline)
        if (!frame) return fail(res, 404, 'not_found', 'no frame with that id accessible to this account')
        const headers = headersOf(frame)
        const answer = written(frame, body, actor)
        return (): void => void res.set(headers).json(answer)
      },
    ),
  )

  api.post(
    '/canvases/:id/frames',
    html,
    route(
      'api frame.create',
      (req) => ({ canvas_id: req.params.id ?? '' }),
      async (req, res) => {
        const canvasId = req.params.id ?? ''
        if (!allowed(res, canvasId, 'edit', 'canvas')) return
        const canvas = store.getCanvas(canvasId)
        const text = (key: string) => (typeof req.query[key] === 'string' ? req.query[key].trim() : '')
        const size = (key: string) => {
          const value = Number(text(key))
          return text(key) && Number.isFinite(value) && value > 0 ? value : undefined
        }
        const name = text('name')
        if (!name) return fail(res, 400, 'invalid', 'name the frame with ?name=')
        const page = text('page')
        const pageId = page
          ? canvasPages(canvas!).find((entry) => entry.id === page || entry.name.toLowerCase() === page.toLowerCase())
              ?.id
          : undefined
        if (page && !pageId) return fail(res, 404, 'not_found', `no page “${page}” on this canvas`)
        const body = bodyOf(req)
        if (body === undefined) return fail(res, 400, 'invalid', NOT_HTML)
        const { actor } = agentOf(res)
        const frame = await runCanvasWrite(canvasId, {
          type: 'create-frame',
          input: { name, pageId, html: body, width: size('width'), height: size('height') },
          actor,
          inline: 'mcp',
        })
        if (frame && 'inline' in frame) return fail(res, 422, 'refused', frame.inline)
        if (!frame) return fail(res, 404, 'not_found', 'no canvas with that id accessible to this account')
        const headers = headersOf(frame)
        const answer = written(frame, body, actor)
        return (): void => void res.status(201).set(headers).json(answer)
      },
    ),
  )

  api.use((_req, res) => fail(res, 404, 'not_found', 'no such endpoint under /api/v1'))

  /* the frame moved past the version the client edited: nothing was written */
  const refusals: express.ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error)
    if (error instanceof FrameVersionConflict) {
      const frame = store.getFrame(error.frame.id) ?? error.frame
      return fail(res, 409, 'conflict', 'the frame changed on the canvas since this version', {
        frame: summaryOf(frame),
      })
    }
    if ((error as { type?: string }).type === 'entity.too.large')
      return fail(res, 413, 'too_large', 'a frame’s HTML is at most 10 MB; images and fonts go up as assets')
    next(error)
  }
  api.use(refusals)

  app.use('/api/v1', api)
}
