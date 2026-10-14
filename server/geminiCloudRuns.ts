import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { Agent, fetch } from 'undici'
import { GEMINI_CLOUD_TIMEOUT_MS, geminiCloudResultSchema, httpOrigin } from '../shared/geminiCloud.ts'
import type { LocalHarnessRequest } from './localAgentRuns.ts'

const workerSchema = z.object({ url: z.string().transform(httpOrigin), token: z.string().min(32) })
export type GeminiCloudWorker = z.infer<typeof workerSchema>

/** Operator-only pilot routing. Never accept worker destinations from browser requests. */
export function geminiCloudWorkerFor(userId: string): GeminiCloudWorker | undefined {
  const raw = process.env.DOOP_GEMINI_CLOUD_WORKERS
  if (!raw) return undefined
  try {
    const workers = z.record(workerSchema).parse(JSON.parse(raw))
    const entries = Object.values(workers)
    if (
      new Set(entries.map((worker) => worker.url)).size !== entries.length ||
      new Set(entries.map((worker) => worker.token)).size !== entries.length
    ) {
      throw new Error('Each pilot user needs a distinct worker and secret')
    }
    return Object.hasOwn(workers, userId) ? workers[userId] : undefined
  } catch {
    // Parsing errors can contain the supplied value, including worker secrets.
    throw new Error('Invalid DOOP_GEMINI_CLOUD_WORKERS configuration')
  }
}

export function matchesSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

interface Run {
  userId: string
  token: string
  request: LocalHarnessRequest
  expiresAt: number
  active: boolean
  tail: Promise<unknown>
}

export class GeminiCloudRuns {
  private runs = new Map<string, Run>()

  authorized(id: string, token: string): Run | undefined {
    const run = this.runs.get(id)
    return run?.active && run.expiresAt > Date.now() && matchesSecret(token, run.token) ? run : undefined
  }

  async start(userId: string, worker: GeminiCloudWorker, request: LocalHarnessRequest) {
    const id = randomUUID()
    const run: Run = {
      userId,
      request,
      token: randomBytes(32).toString('hex'),
      expiresAt: Date.now() + GEMINI_CLOUD_TIMEOUT_MS,
      active: true,
      tail: Promise.resolve(),
    }
    this.runs.set(id, run)
    // Node's default fetch header timeout is shorter than a design run. The
    // worker returns its JSON only when the CLI exits.
    const dispatcher = new Agent({ headersTimeout: GEMINI_CLOUD_TIMEOUT_MS, bodyTimeout: GEMINI_CLOUD_TIMEOUT_MS })
    try {
      const response = await fetch(`${worker.url}/runs`, {
        dispatcher,
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          token: run.token,
          prompt: request.prompt,
          system: request.system,
          maxTurns: request.maxTurns,
        }),
        signal: AbortSignal.timeout(GEMINI_CLOUD_TIMEOUT_MS),
      })
      if (!response.ok) {
        await response.body?.cancel()
        return {
          success: false,
          text:
            response.status === 409
              ? 'Gemini cloud worker is busy. Retry the task.'
              : 'Gemini cloud worker is unavailable. Ask the operator to check its connection.',
        }
      }
      return geminiCloudResultSchema.parse(await response.json())
    } catch {
      return {
        success: false,
        text: 'Gemini cloud run failed or timed out. Check the worker before retrying; earlier canvas edits may already have completed.',
      }
    } finally {
      run.active = false
      await run.tail
      this.runs.delete(id)
      await dispatcher.close()
    }
  }

  async execute(
    id: string,
    token: string,
    name: string,
    input: Record<string, unknown>,
    canExecute: () => Promise<boolean>,
  ) {
    const run = this.authorized(id, token)
    if (!run || !run.request.tools.some((tool) => tool.name === name)) throw new Error('Run or tool unavailable')
    const result = run.tail.then(async () => {
      if (!this.authorized(id, token) || !(await canExecute())) throw new Error('Run access revoked')
      return run.request.execute({ type: 'tool_use', id: randomUUID(), name, input })
    })
    run.tail = result.catch(() => {})
    return result
  }
}

export const geminiCloudRuns = new GeminiCloudRuns()
