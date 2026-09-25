import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { z } from 'zod'
import {
  GEMINI_CLOUD_TIMEOUT_MS,
  geminiCloudJobSchema,
  httpOrigin,
  type GeminiCloudJob,
} from '../shared/geminiCloud.ts'
import { matchesSecret } from './geminiCloudRuns.ts'

const cliResultSchema = z.object({ response: z.string().max(100_000), error: z.unknown().optional() })
type Result = { success: boolean; text: string }
type Runner = (job: GeminiCloudJob, origin: string, signal: AbortSignal) => Promise<Result>

/** Highest-precedence CLI settings. Only the run's Doop tools are available. */
export function geminiWorkerSettings(job: GeminiCloudJob, origin: string) {
  return {
    security: {
      auth: { selectedType: 'oauth-personal', enforcedType: 'oauth-personal' },
      folderTrust: { enabled: false },
      disableYoloMode: true,
    },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
    model: { maxSessionTurns: job.maxTurns },
    tools: { core: [] },
    admin: { extensions: { enabled: false } },
    skills: { enabled: false },
    hooksConfig: { enabled: false },
    experimental: { enableAgents: false },
    telemetry: { enabled: false },
    mcp: { allowed: ['doop'] },
    mcpServers: {
      doop: {
        httpUrl: `${httpOrigin(origin)}/gemini-cloud/mcp/${job.id}`,
        headers: { Authorization: `Bearer ${job.token}` },
        trust: true,
        timeout: 120_000,
      },
    },
  }
}

/** Uses the official CLI's cached Google login. No Google token parsing or backend calls. */
export async function runGeminiCli(
  job: GeminiCloudJob,
  origin: string,
  signal: AbortSignal,
  command = { executable: 'gemini', args: [] as string[] },
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), 'doop-gemini-'))
  try {
    const settings = join(directory, 'settings.json')
    const system = join(directory, 'system.md')
    await writeFile(settings, JSON.stringify(geminiWorkerSettings(job, origin)), { mode: 0o600 })
    await writeFile(system, job.system, { mode: 0o600 })
    if (signal.aborted) return { success: false, text: 'Gemini cloud run cancelled.' }
    return await new Promise<Result>((resolve) => {
      const child = spawn(
        command.executable,
        [...command.args, '--prompt', 'Complete the task supplied on stdin.', '--output-format', 'json'],
        {
          cwd: directory,
          // Deliberate allowlist: do not pass worker auth, API keys, cloud service
          // credentials or application secrets into the agent process.
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: 'C.UTF-8',
            NO_BROWSER: 'true',
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings,
            GEMINI_SYSTEM_MD: system,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      let output = ''
      let bytes = 0
      let stopped = false
      const stop = () => {
        stopped = true
        child.kill('SIGKILL')
      }
      const timeout = setTimeout(stop, GEMINI_CLOUD_TIMEOUT_MS - 60_000)
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 1_000_000) stop()
        else output += chunk
      })
      // Drain diagnostics without leaking Google auth links, prompts or tokens
      // into the shared application logs or a canvas summary.
      child.stderr.resume()
      child.stdin.on('error', () => {})
      child.stdin.end(job.prompt)
      const cleanup = () => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', stop)
      }
      child.on('error', () => {
        cleanup()
        resolve({ success: false, text: 'Gemini CLI could not start. Check the cloud worker installation.' })
      })
      child.on('close', (code) => {
        cleanup()
        if (stopped || code !== 0) {
          resolve({
            success: false,
            text: stopped
              ? 'Gemini cloud run cancelled or exceeded its time/output limit.'
              : `Gemini CLI exited with code ${code}. Check the worker's Google sign-in and quota before retrying.`,
          })
          return
        }
        try {
          const result = cliResultSchema.parse(JSON.parse(output))
          resolve(
            result.error
              ? { success: false, text: 'Gemini CLI reported an error. Check the worker sign-in and quota.' }
              : { success: true, text: result.response },
          )
        } catch {
          resolve({ success: false, text: 'Gemini CLI returned an invalid result.' })
        }
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** One worker and one persistent credential volume per human; never a shared account pool. */
export function createGeminiCloudWorker(options: { token: string; origin: string; runner?: Runner }) {
  if (options.token.length < 32) throw new Error('GEMINI_WORKER_TOKEN must contain at least 32 characters')
  const origin = httpOrigin(options.origin)
  const runner = options.runner ?? runGeminiCli
  const app = express()
  let active: AbortController | undefined
  app.get('/healthz', (_req, res) => res.json({ ok: true }))
  app.use((req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    if (!matchesSecret(token, options.token)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })
  app.use(express.json({ limit: '2mb' }))
  app.post('/runs', (req, res) => {
    const parsed = geminiCloudJobSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid run' })
      return
    }
    if (active) {
      res.status(409).json({ error: 'Worker busy' })
      return
    }
    const controller = new AbortController()
    active = controller
    const cancel = () => controller.abort()
    res.on('close', cancel)
    void runner(parsed.data, origin, controller.signal)
      .then((result) => {
        if (!res.destroyed) res.json(result)
      })
      .catch(() => {
        if (!res.destroyed) res.status(500).json({ error: 'Gemini worker failed' })
      })
      .finally(() => {
        res.off('close', cancel)
        active = undefined
      })
  })
  return { app, stop: () => active?.abort() }
}
