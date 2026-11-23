import type { AgentTask, Canvas } from '../../shared/types'

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const OPT_OUT = 'never'

function preferenceKey(ownerId: string) {
  return `doop:community-invitation:${ownerId}`
}

export function isNewTaskCompletion(task: AgentTask, previous: AgentTask | undefined) {
  return (
    previous?.id === task.id &&
    previous.endedAt === undefined &&
    task.endedAt !== undefined &&
    task.failedAt === undefined
  )
}

export function canInviteToCommunity(canvas: Canvas, task: AgentTask, ownerId: string) {
  return (
    canvas.ownerId === ownerId &&
    canvas.publishedAt === undefined &&
    task.queuedByUserId === ownerId &&
    !task.kind &&
    canvas.frames.some((frame) => !frame.demo && frame.createdAt >= task.startedAt && task.frameIds?.includes(frame.id))
  )
}

export function claimCommunityInvitation(ownerId: string, now = Date.now()) {
  try {
    const key = preferenceKey(ownerId)
    const saved = localStorage.getItem(key)
    if (saved === OPT_OUT || (saved !== null && now - Number(saved) < COOLDOWN_MS)) return false
    localStorage.setItem(key, String(now))
    return true
  } catch {
    return false
  }
}

export function optOutOfCommunityInvitations(ownerId: string) {
  try {
    localStorage.setItem(preferenceKey(ownerId), OPT_OUT)
  } catch {
    return
  }
}
