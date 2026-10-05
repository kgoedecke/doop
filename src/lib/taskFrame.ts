import type { AgentTask } from '../../shared/types'
import type { useStore } from './store'

type State = ReturnType<typeof useStore.getState>

/** The frame a task is "at": the last frame it touched that still exists,
 *  or — for a task still running before any edit landed — wherever the agent
 *  is currently focused or streaming. Undefined when there is nowhere to go. */
export function taskFrameId(task: AgentTask, s: State): string | undefined {
  const frames = s.canvas?.frames ?? []
  const exists = (id: string | null | undefined) => (id && frames.some((f) => f.id === id) ? id : undefined)
  for (let i = (task.frameIds?.length ?? 0) - 1; i >= 0; i--) {
    const id = exists(task.frameIds?.[i])
    if (id) return id
  }
  if (task.endedAt || task.failedAt) return undefined
  const live = Object.values(s.presences).find((p) => p.kind === 'agent' && p.name === task.agentName)
  const focused = exists(live?.activeFrameId)
  if (focused) return focused
  return exists(Object.entries(s.streams).find(([, actor]) => actor.name === task.agentName)?.[0])
}
