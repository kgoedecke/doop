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
  const count = task.pipeline?.length ?? 0
  const step = task.stage ?? 0
  const pipeline = count > 0 && step >= 0 && step < count
  return {
    canvasName: [...canvasName].slice(0, 80).join(''),
    agentName: [...(task.agentName || 'Doop')].slice(0, 60).join(''),
    status: [...(phase === 'failed' ? (task.failureReason ?? task.status) : task.status)].slice(0, 200).join(''),
    phase,
    activeCount: running.length,
    startedAt: task.startedAt / 1000,
    ...(pipeline ? { stage: step + 1, stageCount: count } : {}),
  }
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
