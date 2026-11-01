import { and, count, desc, eq, ilike, inArray, lt, or, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import { agentFeedback } from './db/schema.ts'
import * as authSchema from './db/auth-schema.ts'
import { capture } from './analytics.ts'
import {
  MAX_AGENT_FEEDBACK_CHARS,
  type AgentFeedbackCategory,
  type AgentFeedbackKind,
  type AgentFeedbackReport,
  type AgentFeedbackSource,
} from '../shared/agentFeedback.ts'

/**
 * Agents talking to the Doop team. Issues (report_issue) are where Doop got
 * in their way: a tool that failed or misbehaved, a guide that left them
 * guessing, a capability they needed and did not have. Feedback
 * (share_feedback) is what they would add or change, or what worked. Stored for the instance admins (GET /api/admin/agent-feedback)
 * and, on the hosted service, sent to PostHog as `agent_feedback_reported`.
 */

/* an agent stuck in a loop could otherwise report the same failure on every
   turn; issues and feedback share the one budget */
const REPORTS_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000
const recent = new Map<string, number[]>()

function underLimit(key: string, now: number): boolean {
  const hits = (recent.get(key) ?? []).filter((t) => now - t < HOUR_MS)
  if (hits.length >= REPORTS_PER_HOUR) {
    recent.set(key, hits)
    return false
  }
  hits.push(now)
  recent.set(key, hits)
  return true
}

export interface AgentFeedbackInput {
  kind: AgentFeedbackKind
  source: AgentFeedbackSource
  category: AgentFeedbackCategory
  message: string
  tool?: string
  agentName?: string
  client?: string
  canvasId?: string
  userId?: string
}

export type RecordResult = { ok: true; id: string } | { ok: false; error: string }

export async function recordAgentFeedback(input: AgentFeedbackInput): Promise<RecordResult> {
  const message = input.message.trim()
  if (!message) return { ok: false, error: 'message must not be empty' }
  if (message.length > MAX_AGENT_FEEDBACK_CHARS)
    return { ok: false, error: `message is longer than ${MAX_AGENT_FEEDBACK_CHARS} characters` }
  const now = Date.now()
  const limitKey = input.userId ?? `${input.source}:${input.agentName ?? 'anonymous'}`
  if (!underLimit(limitKey, now))
    return { ok: false, error: `feedback limit reached (${REPORTS_PER_HOUR} reports an hour) — carry on with the task` }

  const row = {
    id: nanoid(12),
    at: now,
    kind: input.kind,
    source: input.source,
    category: input.category,
    message,
    tool: input.tool?.trim() || null,
    agentName: input.agentName?.trim() || null,
    client: input.client?.trim() || null,
    canvasId: input.canvasId ?? null,
    userId: input.userId ?? null,
  }
  await db.insert(agentFeedback).values(row)
  if (row.userId) {
    capture(row.userId, 'agent_feedback_reported', {
      feedback_id: row.id,
      kind: row.kind,
      source: row.source,
      category: row.category,
      tool: row.tool,
      agent_name: row.agentName,
      client: row.client,
      canvas_id: row.canvasId,
      message: row.message,
    })
  }
  return { ok: true, id: row.id }
}

export const AGENT_FEEDBACK_PAGE_SIZE = 50

export interface AgentFeedbackQuery {
  kind?: AgentFeedbackKind
  /** matched against the message, category, tool, agent, client and the account's name or email */
  q?: string
  /** the last report of the previous page: this page starts after it */
  before?: { at: number; id: string }
  limit?: number
}

export interface AgentFeedbackPage {
  reports: AgentFeedbackReport[]
  /** reports matching q, by kind, regardless of the kind filter and paging */
  counts: Record<AgentFeedbackKind, number>
  hasMore: boolean
}

function matching(q: string | undefined): SQL | undefined {
  const needle = q?.trim()
  if (!needle) return undefined
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const accounts = db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(or(ilike(authSchema.user.email, like), ilike(authSchema.user.name, like)))
  return or(
    ilike(agentFeedback.message, like),
    ilike(agentFeedback.category, like),
    ilike(agentFeedback.tool, like),
    ilike(agentFeedback.agentName, like),
    ilike(agentFeedback.client, like),
    inArray(agentFeedback.userId, accounts),
  )
}

/** One page of reports, newest first, for the admin page. */
export async function listAgentFeedback(query: AgentFeedbackQuery = {}): Promise<AgentFeedbackPage> {
  const limit = query.limit ?? AGENT_FEEDBACK_PAGE_SIZE
  const search = matching(query.q)
  const before = query.before
  const where = and(
    search,
    query.kind ? eq(agentFeedback.kind, query.kind) : undefined,
    before
      ? or(lt(agentFeedback.at, before.at), and(eq(agentFeedback.at, before.at), lt(agentFeedback.id, before.id)))
      : undefined,
  )
  const [rows, kinds] = await Promise.all([
    db
      .select()
      .from(agentFeedback)
      .where(where)
      .orderBy(desc(agentFeedback.at), desc(agentFeedback.id))
      .limit(limit + 1),
    db.select({ kind: agentFeedback.kind, n: count() }).from(agentFeedback).where(search).groupBy(agentFeedback.kind),
  ])
  const counts: Record<AgentFeedbackKind, number> = { issue: 0, feedback: 0 }
  for (const k of kinds) if (k.kind === 'issue' || k.kind === 'feedback') counts[k.kind] = k.n
  return {
    reports: rows.slice(0, limit).map((r) => ({
      ...r,
      kind: r.kind as AgentFeedbackKind,
      source: r.source as AgentFeedbackSource,
      category: r.category as AgentFeedbackCategory,
    })),
    counts,
    hasMore: rows.length > limit,
  }
}
