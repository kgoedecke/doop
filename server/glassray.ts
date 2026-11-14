import { init, signal, MAX_MESSAGE_CHARS } from '@glassray/signals'
import { env } from './env.ts'
import { lastContentWriter } from './actions.ts'
import type { Frame } from '../shared/types.ts'

/**
 * Glassray (https://glassray.ai) sees where the agents' work on a canvas goes
 * wrong and why. It reads two kinds of signal, told apart by `source`:
 *
 * - `user`: what a person did with what an agent made — replaced it, deleted
 *   it, put an older version back, signed it off, wrote back to the agent,
 *   asked for another go, stopped it. These decide what gets investigated.
 * - `agent`: what an agent said about its own run — a tool that failed, a
 *   report it filed through report_issue / share_feedback. These explain why.
 *
 * Both are tied together by the canvas they happened on and by the person
 * they happened to, so Doop's unit of work is the canvas and `refs.user` is
 * the better-auth user id.
 *
 * Nothing here may ever break Doop: `signal()` returns at once, queues in the
 * background and never throws, so call sites do not await it, guard it or
 * wrap it. With no GLASSRAY_API_KEY every call quietly does nothing.
 */

/** Start sending. Called once at boot; without a key it stays off. */
export function startGlassray(): void {
  init({ apiKey: env.GLASSRAY_API_KEY ?? '', endpoint: env.GLASSRAY_ENDPOINT })
}

/** Doop's unit of work: everything on a canvas belongs to that canvas. */
function workItem(canvasId: string) {
  return { type: 'canvas' as const, id: canvasId }
}

function trim(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text
}

/**
 * How recently an agent must have written a frame for a person's edit or
 * delete to read as a reaction to it. Longer than this and it is simply
 * someone working on an old design.
 */
export const AGENT_WORK_WINDOW_MS = 30 * 60_000

export interface AgentWork {
  /** The agent's own name, as it signs its edits. */
  agent: string
  /** When it last wrote the frame. */
  at: number
}

/**
 * The agent that last wrote this frame's content, when one did — and, with
 * `within`, only while that write is recent enough for what the person is
 * doing now to be a reaction to it. Undefined for a frame a person wrote
 * last, which is nothing for Glassray to hear about.
 *
 * This is the in-memory record of the open edit burst (server/actions.ts), so
 * a restart forgets who wrote what and those frames stop signalling until an
 * agent touches them again. Nothing else in Doop keeps the author's kind on a
 * live frame — `Frame.updatedBy` is a display name a person could share.
 */
export function agentWorkOnFrame(frameId: string, within?: number): AgentWork | undefined {
  const last = lastContentWriter(frameId)
  if (!last || last.kind !== 'agent') return undefined
  if (within !== undefined && Date.now() - last.at > within) return undefined
  return { agent: last.name, at: last.at }
}

export interface UserSignal {
  /** A well-known kind from Glassray's list, or a short snake_case one with a `sentiment`. */
  kind: string
  canvasId: string
  /** The person who acted: a better-auth user id. */
  userId: string
  /** Their own words, when they wrote any. Never document or frame HTML. */
  message?: string
  sentiment?: 'negative' | 'neutral' | 'positive'
  context?: Record<string, unknown>
}

/** Something a person did or said about an agent's work on a canvas. */
export function userSignal(s: UserSignal): void {
  signal({
    source: 'user',
    kind: s.kind,
    work_item: workItem(s.canvasId),
    refs: { user: s.userId },
    ...(s.message ? { message: trim(s.message) } : {}),
    ...(s.sentiment ? { sentiment: s.sentiment } : {}),
    ...(s.context ? { context: s.context } : {}),
  })
}

/** The same, for a reaction aimed at one frame an agent made. */
export function frameSignal(
  s: Omit<UserSignal, 'canvasId'> & { frame: Pick<Frame, 'id' | 'canvasId' | 'name'>; work: AgentWork },
): void {
  const { frame, work, context, ...rest } = s
  userSignal({
    ...rest,
    canvasId: frame.canvasId,
    context: { frame: frame.id, frame_name: frame.name, agent: work.agent, ...context },
  })
}

export interface AgentSignal {
  /** One of Glassray's AGENT_KINDS: tool_failure, missing_capability, confusing, idea, … */
  kind: string
  /** What was tried and what happened. Specific, and never a secret or a whole document. */
  message: string
  canvasId?: string
  /** The person the agent works for, when the run knows them. */
  userId?: string
  /** The agent's own name, and the client it connected from. */
  agent?: { name?: string; client?: string }
  /** The Doop tool involved. */
  tool?: string
  sentiment?: 'negative' | 'neutral' | 'positive'
  severity?: 'low' | 'medium' | 'high'
  context?: Record<string, unknown>
}

/** Something an agent said about its own work. */
export function agentSignal(s: AgentSignal): void {
  const agent = {
    ...(s.agent?.name ? { name: s.agent.name } : {}),
    ...(s.agent?.client ? { client: s.agent.client } : {}),
  }
  signal({
    source: 'agent',
    kind: s.kind,
    message: trim(s.message),
    ...(s.canvasId ? { work_item: workItem(s.canvasId) } : {}),
    ...(s.userId ? { refs: { user: s.userId } } : {}),
    ...(Object.keys(agent).length ? { agent } : {}),
    ...(s.tool ? { tool: s.tool } : {}),
    ...(s.sentiment ? { sentiment: s.sentiment } : {}),
    ...(s.severity ? { severity: s.severity } : {}),
    ...(s.context ? { context: s.context } : {}),
  })
}
