import type { AgentTask, TaskFeedback } from '../../shared/types'

/** One exchange in the chat: what a person asked and how the agent answered. */
export interface ChatTurn {
  id: string
  at: number
  /** who asked, and whether it was this account */
  from: string
  mine: boolean
  text: string
  /** the agent that answered or is answering; empty while nobody has it */
  agentName: string
  reply?: string
  state: 'queued' | 'working' | 'done' | 'failed'
  failureReason?: string
}

/** A card the composer sent: a prompt, so a turn in the chat. */
export function isChatCard(task: AgentTask): boolean {
  return !!task.queuedBy && !task.kind
}

/** Composer cards and the feedback left on them, as chat turns oldest first.
 *  Structured cards (a repo import's sketches) are jobs, not conversation, and
 *  status tasks have no prompt, so neither is here. */
export function chatTurns(tasks: AgentTask[], feedback: TaskFeedback[], userId: string | undefined): ChatTurn[] {
  const turns: ChatTurn[] = []
  const cards = new Set<string>()
  for (const task of tasks) {
    if (!isChatCard(task)) continue
    cards.add(task.id)
    turns.push({
      id: task.id,
      at: task.startedAt,
      from: task.queuedBy ?? '',
      mine: !!userId && task.queuedByUserId === userId,
      text: task.status,
      agentName: task.agentName,
      ...(task.reply ? { reply: task.reply } : {}),
      state: task.failedAt ? 'failed' : task.endedAt ? 'done' : task.agentName ? 'working' : 'queued',
      ...(task.failureReason ? { failureReason: task.failureReason } : {}),
    })
  }
  for (const fb of feedback) {
    if (!cards.has(fb.taskId)) continue
    turns.push({
      id: fb.id,
      at: fb.at,
      from: fb.from,
      mine: !!userId && fb.fromUserId === userId,
      text: fb.text,
      agentName: fb.claimedBy ?? '',
      ...(fb.reply ? { reply: fb.reply } : {}),
      state: fb.failedAt ? 'failed' : fb.completedAt ? 'done' : fb.claimedBy ? 'working' : 'queued',
      ...(fb.failureReason ? { failureReason: fb.failureReason } : {}),
    })
  }
  return turns.sort((a, b) => a.at - b.at)
}

/** Every turn as one string, so the chat can tell it grew or an answer landed. */
export function chatTurnsKey(turns: ChatTurn[]): string {
  return turns.map((t) => `${t.id}:${t.state}:${t.reply?.length ?? 0}`).join('|')
}
