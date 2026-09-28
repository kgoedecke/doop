import { randomBytes, randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { ClaudeModel, LocalAgentJob, LocalAgentResult } from '../shared/localAgent.ts'

export interface LocalHarnessRequest {
  canvasId: string
  prompt: string
  system: string
  tools: Anthropic.Tool[]
  maxTurns: number
  execute: (block: Anthropic.ToolUseBlockParam) => Promise<Anthropic.ToolResultBlockParam>
}

interface Run {
  userId: string
  remote?: AbortController
  deviceId?: string
  job: LocalAgentJob
  request: LocalHarnessRequest
  lastSeen: number
  startedAt: number
  closing: boolean
  tail: Promise<unknown>
  resolve: (result: LocalAgentResult) => void
}

/** A single server process owns each live canvas sweep, as with resident.ts.
 * Tokens expire with the run. No Claude credentials pass through this relay. */
export class LocalAgentRuns {
  private runs = new Map<string, Run>()
  private devices = new Map<string, { id: string; at: number }>()

  online(userId: string, now = Date.now()) {
    return now - (this.devices.get(userId)?.at ?? 0) < 30_000
  }

  poll(userId: string, deviceId: string, now = Date.now()): LocalAgentJob | null {
    const device = this.devices.get(userId)
    if (device && device.id !== deviceId && this.online(userId, now)) return null
    this.devices.set(userId, { id: deviceId, at: now })
    const run = [...this.runs.values()].find((r) => r.userId === userId && !r.closing && !r.remote)
    if (!run || (run.deviceId && run.deviceId !== deviceId)) return null
    run.deviceId = deviceId
    run.lastSeen = now
    return run.job
  }

  runningRemote(userId: string) {
    return [...this.runs.values()].some((r) => r.userId === userId && r.remote && !r.closing)
  }

  start(
    userId: string,
    model: ClaudeModel,
    request: LocalHarnessRequest,
    remote?: (job: LocalAgentJob, signal: AbortSignal) => Promise<LocalAgentResult>,
  ): Promise<LocalAgentResult> {
    const id = randomUUID()
    return new Promise((resolve) => {
      this.runs.set(id, {
        userId,
        remote: remote ? new AbortController() : undefined,
        request,
        resolve,
        lastSeen: Date.now(),
        startedAt: Date.now(),
        closing: false,
        tail: Promise.resolve(),
        job: {
          id,
          token: randomBytes(32).toString('hex'),
          model,
          prompt: request.prompt,
          system: request.system,
          maxTurns: request.maxTurns,
        },
      })
      if (remote) {
        const run = this.runs.get(id)!
        void Promise.resolve()
          .then(() => remote(run.job, run.remote!.signal))
          .catch((error: unknown) => ({
            success: false,
            text: error instanceof Error ? error.message : 'Hosted Claude failed.',
          }))
          .then(async (result) => {
            if (!run.closing) await this.close(run, result)
          })
      }
    })
  }

  revokeRemote(id: string) {
    this.runs.get(id)?.remote?.abort()
  }

  authorized(id: string, token: string): Run | undefined {
    const run = this.runs.get(id)
    return run && !run.closing && !run.remote?.signal.aborted && (run.deviceId || run.remote) && token === run.job.token
      ? run
      : undefined
  }

  async execute(id: string, token: string, name: string, input: Record<string, unknown>) {
    const run = this.authorized(id, token)
    if (!run || !run.request.tools.some((tool) => tool.name === name)) throw new Error('Run or tool unavailable')
    const result = run.tail.then(() => {
      if (run.closing) throw new Error('Run ended')
      return run.request.execute({ type: 'tool_use', id: randomUUID(), name, input })
    })
    run.tail = result.catch(() => {})
    return result
  }

  async finish(id: string, userId: string, deviceId: string, result: LocalAgentResult) {
    const run = this.runs.get(id)
    if (!run || run.remote || run.userId !== userId || run.deviceId !== deviceId || run.closing) return false
    await this.close(run, result)
    return true
  }

  private async close(run: Run, result: LocalAgentResult) {
    run.closing = true
    run.remote?.abort()
    await run.tail
    this.runs.delete(run.job.id)
    run.resolve(result)
  }

  async cancel(userId: string, transport?: 'remote') {
    if (!transport) this.devices.delete(userId)
    await Promise.all(
      [...this.runs.values()]
        .filter((r) => r.userId === userId && !r.closing && (!transport || r.remote))
        .map((r) => this.close(r, { success: false, text: 'Claude run stopped.' })),
    )
  }

  async expire(now = Date.now()) {
    await Promise.all(
      [...this.runs.values()]
        .filter(
          (r) =>
            !r.closing &&
            ((!r.remote && (r.deviceId ? now - r.lastSeen > 45_000 : !this.online(r.userId, now))) ||
              now - r.startedAt > 30 * 60_000),
        )
        .map((r) =>
          this.close(r, {
            success: false,
            text: r.remote
              ? 'Hosted Claude timed out. Review any completed edits before retrying.'
              : 'Desktop disconnected or local run timed out. Retry the task.',
          }),
        ),
    )
    for (const [userId, device] of this.devices) if (now - device.at > 60_000) this.devices.delete(userId)
  }
}

export const localAgentRuns = new LocalAgentRuns()
const cleanup = setInterval(() => {
  void localAgentRuns.expire()
}, 5_000)
cleanup.unref()
