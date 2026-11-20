import { nanoid } from 'nanoid'
import * as actions from '../actions.ts'
import { STORYBOOK_WORKER, type StorybookRunResult } from '../../shared/storybookSource.ts'
import { runStorybookImport, summarize, type StorybookImportInput } from './importer.ts'

/**
 * Storybook imports run on after whoever started them is answered: one at a time per canvas, shown
 * as a "Storybook Import" task in the Agents panel (as Figma's are), kept here a while so the
 * import section and an MCP agent can read how it went. In memory: a restart forgets a running
 * import, and the next sync picks it up from the source.
 */

const KEEP_FINISHED_MS = 30 * 60_000

export interface StorybookJob {
  id: string
  canvasId: string
  taskId: string
  state: 'running' | 'done' | 'failed'
  progress: { status: string; done: number; total: number }
  result?: StorybookRunResult
  error?: string
  startedAt: number
  finished: Promise<void>
}

const jobs = new Map<string, StorybookJob>()

export class StorybookBusyError extends Error {}

export function runningJobOn(canvasId: string): StorybookJob | undefined {
  return [...jobs.values()].find((job) => job.canvasId === canvasId && job.state === 'running')
}

export function jobById(canvasId: string, id: string): StorybookJob | undefined {
  const job = jobs.get(id)
  return job?.canvasId === canvasId ? job : undefined
}

/** Start an import; refused while another runs on the same canvas. */
export function startStorybookJob(input: Omit<StorybookImportInput, 'onProgress'>, label: string): StorybookJob {
  const running = runningJobOn(input.canvasId)
  if (running) throw new StorybookBusyError(`a Storybook import is already running on this canvas (job ${running.id})`)
  const worker = actions.resolveActor({ name: STORYBOOK_WORKER, kind: 'agent', owner: input.user.name })
  const task = actions.startProgressTask(input.canvasId, worker, label, 1)
  const job: StorybookJob = {
    id: nanoid(10),
    canvasId: input.canvasId,
    taskId: task.id,
    state: 'running',
    progress: { status: label, done: 0, total: 1 },
    startedAt: Date.now(),
    finished: Promise.resolve(),
  }
  jobs.set(job.id, job)
  job.finished = runStorybookImport({
    ...input,
    onProgress: (status, done, total) => {
      job.progress = { status, done, total }
      actions.advanceProgressTask(input.canvasId, task.id, { status, done, total })
    },
  })
    .then((result) => {
      job.result = result
      job.state = 'done'
      const landed = result.components.some((component) =>
        ['created', 'updated', 'unchanged'].includes(component.outcome),
      )
      actions.finishProgressTask(input.canvasId, task.id, { status: summarize(result), failed: !landed })
    })
    .catch((error: unknown) => {
      job.error = error instanceof Error ? error.message : String(error)
      job.state = 'failed'
      actions.finishProgressTask(input.canvasId, task.id, {
        status: `Storybook import failed — ${job.error}`,
        failed: true,
      })
    })
    .finally(() => {
      setTimeout(() => jobs.delete(job.id), KEEP_FINISHED_MS).unref?.()
    })
  return job
}

/** Wait for a job, at most `ms`; true when it finished. */
export async function waitForJob(job: StorybookJob, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  const finished = await Promise.race([job.finished.then(() => true as const), timeout])
  clearTimeout(timer)
  return finished
}

/** What the import section and an agent read of a job. */
export function jobView(job: StorybookJob) {
  return {
    id: job.id,
    state: job.state,
    progress: job.progress,
    ...(job.result ? { result: job.result, summary: summarize(job.result) } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}
