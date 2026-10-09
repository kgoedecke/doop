import type { AgentTask } from './types.ts'

/** Wire format shared with AgentActivityState in the iOS app/widget. Under APNs' 4 KB limit. */
export function agentActivityState(canvasName: string, tasks: AgentTask[]) {
  const sorted = [...tasks].sort((a, b) => b.startedAt - a.startedAt)
  const unfinished = sorted.filter((t) => t.endedAt == null && t.failedAt == null)
  const running = unfinished.filter((t) => !!t.agentName)
  const task = running[0] ?? unfinished[0] ?? sorted[0]
  if (!task) return null
  const phase = running.length
    ? 'working'
    : unfinished.length
      ? 'queued'
      : task.failedAt != null
        ? 'failed'
        : 'finished'
  const run = runOf(task, sorted)
  const count = task.pipeline?.length ?? 0
  const step = task.stage ?? 0
  const pipeline = count > 0 && step >= 0 && step < count
  return {
    canvasName: [...canvasName].slice(0, 80).join(''),
    agentName: [...(task.agentName || 'Doop')].slice(0, 60).join(''),
    status: [...(phase === 'failed' ? (task.failureReason ?? task.status) : task.status)].slice(0, 200).join(''),
    phase,
    activeCount: running.length,
    startedAt: (task.runStartedAt ?? run[run.length - 1]!.startedAt) / 1000,
    steps: run
      .slice(1, 1 + RECENT_STEPS)
      .reverse()
      .map((t) => [...t.status].slice(0, 80).join('')),
    ...(pipeline ? { stage: step + 1, stageCount: count } : {}),
  }
}

/** Finished steps the Live Activity keeps above the current one. */
const RECENT_STEPS = 2
/** A status handoff closes the old task and opens the next within the same call. */
const HANDOFF_MS = 5_000

/** The task and the earlier statuses the same agent posted back to back,
 *  newest first: each set_status closes the previous task as it opens the
 *  next, so a run is a chain of tasks that end where the next one starts. */
function runOf(task: AgentTask, sorted: AgentTask[]): AgentTask[] {
  const run = [task]
  for (const earlier of sorted.slice(sorted.indexOf(task) + 1)) {
    const next = run[run.length - 1]!
    if (earlier.agentName !== task.agentName || earlier.owner !== task.owner) continue
    if (earlier.queuedBy || earlier.failedAt != null || earlier.endedAt == null) break
    if (Math.abs(next.startedAt - earlier.endedAt) > HANDOFF_MS) break
    run.push(earlier)
  }
  return run
}

/** Dashboard status only; omit task prompts, ownership metadata, and completed history. */
export function activeAgentTasks(tasks: AgentTask[]) {
  return tasks
    .filter((task) => task.endedAt == null && task.failedAt == null)
    .map(({ id, agentName, status, startedAt, pipeline, stage }) => ({
      id,
      agentName,
      status,
      startedAt,
      pipeline,
      stage,
    }))
}
