import { getLocalAgentPreference, requireRemoteAuth } from './localAgentPreferences.ts'
import type { ClaudeModel, LocalAgentJob, LocalAgentResult } from '../shared/localAgent.ts'
import type { ClaudeEvent } from '../shared/remoteClaude.ts'
import { localAgentRuns, type LocalHarnessRequest } from './localAgentRuns.ts'
import { remotePost, remoteEvents } from './remoteClaudeClient.ts'

/** Reassembles only this message's native output, within the native runner's 4 MiB limit. */
export class RemoteResult {
  result?: LocalAgentResult
  private fragments = new Map<string, { parts: string[]; total: number; size: number }>()
  private size = 0
  constructor(private messageId: string) {}
  accept(event: ClaudeEvent) {
    if (!('id' in event) || event.id !== this.messageId) return
    if (event.type === 'claude') this.native(event.event)
    if (event.type === 'claude.fragment') {
      if (
        !Number.isSafeInteger(event.total) ||
        event.total < 1 ||
        event.total > 1024 ||
        !Number.isSafeInteger(event.index) ||
        event.index < 0 ||
        event.index >= event.total
      )
        throw new Error('Invalid Claude output fragments.')
      const fragment = this.fragments.get(event.eventId) ?? { parts: [], total: event.total, size: 0 }
      if (fragment.total !== event.total) throw new Error('Inconsistent Claude output fragments.')
      if (fragment.parts[event.index] !== undefined) {
        if (fragment.parts[event.index] !== event.json) throw new Error('Conflicting Claude output fragments.')
        return
      }
      fragment.parts[event.index] = event.json
      fragment.size += event.json.length
      this.size += event.json.length
      if (this.size > 4 * 1024 * 1024 || this.fragments.size > 32)
        throw new Error('Claude output exceeded the fragment limit.')
      this.fragments.set(event.eventId, fragment)
      if (fragment.parts.filter((part) => part !== undefined).length === fragment.total) {
        this.native(JSON.parse(fragment.parts.join('')) as Record<string, unknown>)
        this.fragments.delete(event.eventId)
        this.size -= fragment.size
      }
    }
  }
  private native(event: Record<string, unknown>) {
    if (event.type === 'result')
      this.result = {
        success: event.is_error === false && event.subtype === 'success',
        text:
          typeof event.result === 'string'
            ? event.result.slice(0, 100_000)
            : 'Claude did not complete this task. Check your account and usage limits.',
      }
  }
}

export async function runRemoteClaude(userId: string, model: ClaudeModel, request: LocalHarnessRequest) {
  const preference = await getLocalAgentPreference(userId)
  if (preference.remoteAuthRequired) return authRequiredResult()
  // The API bounds request text. Large canvas context stays behind the same
  // per-run MCP authorization as all other canvas data, with no truncation.
  const extended: LocalHarnessRequest = {
    ...request,
    tools: [
      ...request.tools,
      {
        name: 'get_run_context',
        description: 'Read the complete task instructions for this run before working.',
        input_schema: { type: 'object', properties: {} },
      },
    ],
    execute: (block) =>
      block.name === 'get_run_context'
        ? Promise.resolve({ type: 'tool_result', tool_use_id: block.id, content: request.prompt })
        : request.execute(block),
  }
  return localAgentRuns.start(userId, model, extended, (job, signal) =>
    executeRemote(userId, job, extended, signal, preference.remoteAuthGeneration ?? 0),
  )
}

async function executeRemote(
  userId: string,
  job: LocalAgentJob,
  request: LocalHarnessRequest,
  cancellation: AbortSignal,
  generation: number,
): Promise<LocalAgentResult> {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, cancellation, AbortSignal.timeout(30 * 60_000)])
  let sessionId: string | undefined
  let finished = false
  try {
    signal.throwIfAborted()
    const origin = new URL(
      process.env.CLAUDE_REMOTE_MCP_ORIGIN ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:4300',
    )
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/'
    )
      throw new Error(
        'Hosted execution needs a public HTTPS address for canvas tools. Set CLAUDE_REMOTE_MCP_ORIGIN to your tunnel origin when developing locally.',
      )
    if (Buffer.byteLength(job.system) > 32 * 1024)
      throw new Error('The agent system prompt exceeds the hosted 32 KiB limit.')
    const created = await remotePost(
      userId,
      '/v1/sessions',
      {
        model: job.model,
        systemPrompt: job.system,
        maxTurns: job.maxTurns,
        tools: [],
        allowedTools: request.tools.map((tool) => `mcp__doop__${tool.name}`),
        mcps: {
          doop: {
            type: 'http',
            url: `${origin.origin}/local-agent/mcp/${job.id}`,
            headers: { Authorization: `Bearer ${job.token}` },
          },
        },
      },
      signal,
    )
    sessionId = created.sessionId
    const output = new RemoteResult(job.id)
    let outcome: LocalAgentResult | undefined
    await remoteEvents(
      userId,
      sessionId,
      signal,
      async (event) => {
        if (event.type === 'auth.required' && event.id === job.id) {
          await requireRemoteAuth(userId, generation)
          outcome = authRequiredResult()
          controller.abort()
          return
        }
        if (outcome?.authRequired) return
        output.accept(event)
        if (event.type === 'error') throw new Error(`Hosted Claude could not run the task (${event.code}).`)
        if (
          event.type === 'message.status' &&
          event.id === job.id &&
          ['completed', 'failed', 'cancelled', 'steered', 'interrupted'].includes(event.status)
        ) {
          finished = true
          outcome =
            event.status === 'completed' && output.result
              ? output.result
              : {
                  success: false,
                  text:
                    output.result?.text ??
                    `Claude task ${event.status}. Check your connection and usage limits in Settings, then retry.`,
                }
          controller.abort()
        }
      },
      async () => {
        await remotePost(
          userId,
          '/v1/messages',
          {
            sessionId,
            messageId: job.id,
            mode: 'queue',
            text: 'Call get_run_context to read the complete task, then carry it out using the Doop tools.',
          },
          signal,
        )
      },
    )
    return (
      outcome ?? {
        success: false,
        text: 'Hosted Claude stopped or timed out. Previous edits may have completed; review the canvas before retrying.',
      }
    )
  } finally {
    localAgentRuns.revokeRemote(job.id)
    controller.abort()
    if (sessionId && !finished) {
      await remotePost(userId, '/v1/cancel', { sessionId, messageId: job.id }).catch(() => {})
    }
  }
}

function authRequiredResult(): LocalAgentResult {
  return {
    success: false,
    authRequired: true,
    text: 'Claude sign-in required. Reconnect Claude in Settings → Hosted execution, then retry this task. Previous edits may already have completed.',
  }
}
