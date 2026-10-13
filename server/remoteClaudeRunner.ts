import { claudeMcpOrigin } from './remoteClaudeOrigins.ts'
import { getLocalAgentPreference, requireRemoteAuth } from './localAgentPreferences.ts'
import type { ClaudeModel, LocalAgentJob, LocalAgentResult } from '../shared/localAgent.ts'
import { ClaudeSessionOutput, type ClaudeSessionConfig } from '@cantelop/sdk/harnesses/claude/protocol'
import type { ClaudeSessionEvent as ClaudeEvent } from '@cantelop/sdk/harnesses/claude/protocol'
import { localAgentRuns, type LocalHarnessRequest } from './localAgentRuns.ts'
import { remoteWorkspace, remoteCall, remoteEvents, type ClaudeSession } from './remoteClaudeClient.ts'

/** Translate the SDK's decoded native result into Doop's task result. */
export class RemoteResult {
  result?: LocalAgentResult
  private readonly output: ClaudeSessionOutput
  constructor(messageId: string) {
    this.output = new ClaudeSessionOutput(messageId)
  }
  accept(event: ClaudeEvent) {
    const native = this.output.accept(event)
    if (native?.type === 'result')
      this.result = {
        success: native.is_error === false && native.subtype === 'success',
        text:
          typeof native.result === 'string'
            ? native.result.slice(0, 100_000)
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
  let activeSession: ClaudeSession | undefined
  let finished = false
  try {
    signal.throwIfAborted()
    const origin = claudeMcpOrigin(
      process.env.CLAUDE_REMOTE_MCP_ORIGIN ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:4300',
    )
    if (Buffer.byteLength(job.system) > 32 * 1024)
      throw new Error('The agent system prompt exceeds the hosted 32 KiB limit.')
    const settings: ClaudeSessionConfig = {
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
    }
    if (Buffer.byteLength(JSON.stringify(settings)) > 48 * 1024)
      throw new Error('Hosted Claude configuration exceeds 48 KiB.')
    const session = remoteWorkspace(userId).session({ keepAliveSeconds: 300 })
    activeSession = session
    const reply = await remoteCall(
      (signal) => session.request({ type: 'configure', config: settings }, { signal }),
      signal,
    )
    if (reply.type === 'error') throw new Error('Hosted Claude configuration failed.')
    const output = new RemoteResult(job.id)
    let outcome: LocalAgentResult | undefined
    await remoteEvents(
      session,
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
        await remoteCall(
          (signal) =>
            session.dispatch(
              {
                type: 'queue',
                id: job.id,
                text: 'Call get_run_context to read the complete task, then carry it out using the Doop tools.',
              },
              { id: `msg_${job.id.replaceAll('-', '')}`, signal },
            ),
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
    if (activeSession && !finished) {
      const session = activeSession
      await remoteCall((signal) => session.dispatch({ type: 'cancel', id: job.id }, { signal })).catch(() => {})
    }
  }
}

function authRequiredResult(): LocalAgentResult {
  return {
    success: false,
    authRequired: true,
    text: 'Claude sign-in required. Reconnect Claude in Settings → Claude Plan, then retry this task. Previous edits may already have completed.',
  }
}
