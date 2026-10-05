import type express from 'express'
import type { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import type { PullStep } from '../shared/automations.ts'
import { linearExtension } from './linear/extension.ts'

/**
 * Server extensions: integrations that are removable as a unit. The core
 * never names an integration — it iterates `extensions` and offers each
 * one the hooks below. The dependency rule is one-way: an extension may
 * import anything from the core, the core imports extensions only here.
 *
 * Removing an integration from a build (a fork that must not ship it) is:
 * delete its folder, delete its line in `extensions`, and let the compiler
 * point at anything left — there should be nothing.
 */

/** What an automation pull step throws when the user can fix it with one
 *  click — the run surfaces `failure` as that click. */
export class AutomationPullError extends Error {
  failure?: 'reconnect'
  constructor(message: string, failure?: 'reconnect') {
    super(message)
    this.failure = failure
  }
}

/** What an extension's tool answers — the SDK accepts exactly this. */
export interface McpToolResult {
  [key: string]: unknown
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

/** Handed to an extension's connect routes. */
export interface ConnectRouteHelpers {
  /** answer with the whole Integrations status object — what the page shows */
  respondWithStatus(req: express.Request, res: express.Response): Promise<void>
}

/** The core's request helpers, handed to an extension's canvas routes.
 *  Both helpers answer the response themselves when they refuse. */
export interface CanvasRouteHelpers {
  requireCanvas(req: express.Request, res: express.Response, canvasId: string): Canvas | null
  /** the shared import rate slot (websites, repos, design files alike) */
  takeImportSlot(userId: string): boolean
}

/** The MCP server's per-session helpers, so an extension's tools answer,
 *  attribute and rate-limit exactly like the built-in ones. */
export interface McpToolHelpers {
  /** the connected user's id — undefined for a session without one */
  ownerId?: string
  agentName: z.ZodType<string>
  actorFrom(agentName?: string): Actor
  canvasFor(canvasId: string): Canvas | undefined
  noCanvas(id: string): McpToolResult
  err(message: string): McpToolResult
  text(data: unknown): McpToolResult
  textWithNudge(data: unknown, nudge: string): McpToolResult
  withFeedback<T extends McpToolResult>(result: T, canvasId: string, actor?: Actor): T
  withStatusNudge<T extends McpToolResult>(result: T, canvasId: string, actor?: Actor): T
  frameSummary(frame: Frame): Record<string, unknown>
  takeImportSlot(key: string): boolean
}

export interface ServerExtension {
  /** URL segment and status key: /api/integrations/<id>/…, status[<id>] */
  id: string
  /** Public, signed provider webhooks; mounted before the JSON/session middleware. */
  webhookRouter?(): express.Router
  /** Start durable background work after boot hydration. */
  startWorker?(): void
  /** merged into GET /api/integrations under `id` */
  connectionStatus?(userId: string): Promise<unknown>
  /** mounted at /api/integrations/<id> (behind the session gate) */
  connectRouter?(helpers: ConnectRouteHelpers): express.Router
  /** mounted at /api/canvases/:id/<id> (behind the session gate) */
  canvasRouter?(helpers: CanvasRouteHelpers): express.Router
  /** tools offered to every connected MCP agent */
  registerMcpTools?(server: McpServer, helpers: McpToolHelpers): void
  /** bullet lines for the agent guide (get_guide) describing the tools */
  mcpGuideLines?: string[]
  /** run this integration's automation pull step; resolves to the run
   *  summary line ("3 new frames (9 already here)") */
  runAutomationPull?(
    step: Extract<PullStep, { provider: string }>,
    ctx: { ownerId: string; actor: Actor },
  ): Promise<string>
}

export const extensions: ServerExtension[] = [linearExtension]
